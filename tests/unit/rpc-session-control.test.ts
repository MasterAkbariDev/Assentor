import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEngineRpcServer,
  createInProcessTransport,
  expandSeatSpecs,
  getMode,
  MockReviewer,
  PanelReviewer,
  parseAssentorConfig,
  RpcClient,
  RpcErrorCode,
  RpcRemoteError,
  WorktreeManager,
  type Executor,
  type ModeControllerInput,
  type ModeDefinition,
  type RpcServer,
  type SessionHost,
  type StageRunnerDeps,
  type StageSpec,
} from "../../packages/engine/src/index.js";
import { EventLog, isSessionRunLocked } from "../../packages/engine/src/events/log.js";
import { killProcessTree } from "../../packages/engine/src/process/kill-tree.js";
import { RpcMethods } from "../../packages/protocol/src/rpc.js";
import { SeatScheduler } from "../../packages/engine/src/seats/index.js";

vi.setConfig({ testTimeout: 60_000 });
const exec = promisify(execFile);
const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

/** A real git repo: it is both the project and the main checkout. */
async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rpc-sc-")));
  dirs.push(dir);
  await git(dir, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "assentor@test");
  await git(dir, "config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n");
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const config = parseAssentorConfig({
  teams: { panel: { seats: [{ provider: "mock", model: "critic", count: 1, role: "code-reviewer" }] } },
});
const seatsFor = (stage: StageSpec) => expandSeatSpecs(config.teams[stage.team!]!.seats, { teamName: stage.team! });
const executor = (): Executor => ({
  name: "mock-executor",
  capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
  run: async () => ({ status: "completed", summary: "done" }),
  continue: async () => ({ status: "completed", summary: "done" }),
  cancel: async () => undefined,
});
const deps = (projectPath: string, makeExecutor: () => Executor = executor): StageRunnerDeps => ({
  projectPath,
  scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
  runStep: async () => ({}),
  seatsFor,
  createExecutor: () => makeExecutor(),
  createReviewer: () => new PanelReviewer({ name: "panel", policy: "majority", reviewers: [new MockReviewer({ name: "r1" })] }),
  supervisor: { skipGates: true },
});

/** A dynamic mode whose controller runs `body`. */
function dynamicMode(body: (input: ModeControllerInput) => Promise<void>): ModeDefinition {
  const { validate: _validate, ...lead } = getMode("lead")!;
  return {
    ...lead,
    createController: (input) => ({ run: async () => (await body(input), { status: "completed" as const }) }),
  } as ModeDefinition;
}

interface Setup {
  projectPath: string;
  client: RpcClient;
  server: RpcServer;
  wm: WorktreeManager;
}

async function setup(
  options: {
    autonomy?: "manual" | "supervised" | "autopilot";
    mode?: ModeDefinition;
    maxAutonomy?: "manual" | "supervised" | "autopilot";
    createdTtlMs?: number;
    launchDelayMs?: number;
    executor?: () => Executor;
  } = {},
): Promise<Setup> {
  const projectPath = await makeRepo();
  const wm = new WorktreeManager({ repoPath: projectPath });
  const sessionHost: SessionHost = {
    launch: async () => {
      if (options.launchDelayMs) await new Promise((r) => setTimeout(r, options.launchDelayMs));
      return {
      autonomy: options.autonomy ?? "supervised",
      config,
      deps: deps(projectPath, options.executor),
      ...(options.mode ? { mode: options.mode } : {}),
      };
    },
  };
  const server = createEngineRpcServer({ projectPath, engineVersion: "test", listCacheMs: 0,
    sessionHost,
    worktrees: wm,
    ...(options.maxAutonomy ? { maxAutonomy: options.maxAutonomy } : {}),
    ...(options.createdTtlMs ? { createdTtlMs: options.createdTtlMs } : {}),
  });
  const { client: transport } = createInProcessTransport(server);
  const client = new RpcClient(transport);
  cleanups.push(() => client.close());
  return { projectPath, client, server, wm };
}

async function failure(promise: Promise<unknown>): Promise<RpcRemoteError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcRemoteError);
    return error as RpcRemoteError;
  }
  throw new Error("expected the call to fail");
}

describe("contract and access", () => {
  it("every mutating method is write; the read-only ones are read", () => {
    const reads = ["session.list", "session.get", "session.export", "worktree.diff"];
    const writes = [
      "session.create", "session.start", "session.pause", "session.resume", "session.cancel", "session.approve",
      "seat.setModel", "seat.inject", "seat.stop", "seat.restart", "worktree.apply", "worktree.discard",
    ];
    for (const m of reads) expect(RpcMethods[m as keyof typeof RpcMethods].access).toBe("read");
    for (const m of writes) expect(RpcMethods[m as keyof typeof RpcMethods].access).toBe("write");
  });

  it("a read-only connection (serve) is refused every write method", async () => {
    const { server } = await setup();
    const frames: string[] = [];
    const connection = server.connect((f) => void frames.push(f)); // no allowWrite
    for (const [i, method] of ["session.cancel", "worktree.apply", "worktree.discard", "seat.stop"].entries()) {
      await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: i, method, params: {} }));
    }
    expect(frames.map((f) => JSON.parse(f).error.code)).toEqual(Array(4).fill(RpcErrorCode.WriteNotAllowed));
  });

  it("pause, resume, seat.inject and seat.restart answer NotSupported", async () => {
    const { client } = await setup();
    const id = "11111111-1111-4111-8111-111111111111";
    const calls = [
      client.call("session.pause", { sessionId: id }),
      client.call("session.resume", { sessionId: id }),
      client.call("seat.inject", { sessionId: id, seatId: "a", text: "hi" }),
      client.call("seat.restart", { sessionId: id, seatId: "a" }),
    ];
    for (const call of calls) expect((await failure(call)).code).toBe(RpcErrorCode.NotSupported);
  });

  it("session.create without a session host is NotSupported", async () => {
    const projectPath = await makeRepo();
    const { client: transport } = createInProcessTransport(createEngineRpcServer({ projectPath }));
    const client = new RpcClient(transport);
    cleanups.push(() => client.close());
    expect((await failure(client.call("session.create", { mode: "solo", goal: "x" }))).code).toBe(RpcErrorCode.NotSupported);
  });
});

describe("session lifecycle", () => {
  it("create → start → completes; the log is exportable and the session leaves the live list", async () => {
    const { client } = await setup({ mode: dynamicMode(async () => undefined) });
    const created = await client.call("session.create", { mode: "lead", goal: "do it" });
    expect(created.autonomy).toBe("supervised");
    expect((await client.call("session.list")).sessions.find((s) => s.id === created.sessionId)).toMatchObject({ live: "created", title: "do it" });

    expect(await client.call("session.start", { sessionId: created.sessionId })).toMatchObject({ live: "running" });
    await until(async () => (await client.call("session.get", { sessionId: created.sessionId })).session.live === undefined);
    const { events, truncated } = await client.call("session.export", { sessionId: created.sessionId });
    expect(truncated).toBe(false);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["mode.selected", "session.created", "session.completed"]));
    expect((await client.call("session.get", { sessionId: created.sessionId })).session).toMatchObject({ hasLiveLog: true });
  });

  it("start is refused while another process holds the session's run lock; a finished run releases its own", async () => {
    const { client, projectPath } = await setup({ mode: dynamicMode(async () => undefined) });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    const lock = path.join(projectPath, ".assentor", "sessions", sessionId, "run.lock");
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, `${JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString(), token: "other" })}\n`);
    const refused = await failure(client.call("session.start", { sessionId }));
    expect(refused.code).toBe(RpcErrorCode.Rejected);
    expect(refused.message).toContain("another process is running this session");
    // Still created, and the other process's lock is untouched; once it is gone the start goes ahead.
    expect((await client.call("session.get", { sessionId })).session.live).toBe("created");
    expect(JSON.parse(await fs.readFile(lock, "utf8"))).toMatchObject({ token: "other" });
    await fs.rm(lock);
    await client.call("session.start", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    expect(await isSessionRunLocked(projectPath, sessionId)).toBe(false);
  });

  it("start runs once; unknown, foreign and malformed ids are rejected", async () => {
    const { client } = await setup({ mode: dynamicMode(async (i) => void (await i.ask({ question: "wait?" }))) });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await client.call("session.start", { sessionId });
    expect((await failure(client.call("session.start", { sessionId }))).code).toBe(RpcErrorCode.Rejected);
    for (const bad of ["22222222-2222-4222-8222-222222222222", "../../etc", "not-an-id"]) {
      expect((await failure(client.call("session.start", { sessionId: bad }))).code).toBe(RpcErrorCode.InvalidParams);
      expect((await failure(client.call("session.cancel", { sessionId: bad }))).code).toBe(RpcErrorCode.InvalidParams);
      expect((await failure(client.call("session.get", { sessionId: bad }))).code).toBe(RpcErrorCode.InvalidParams);
      expect((await failure(client.call("session.export", { sessionId: bad }))).code).toBe(RpcErrorCode.InvalidParams);
    }
    await client.call("session.cancel", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
  });

  it("an unknown mode is InvalidParams and nothing becomes live", async () => {
    const { client } = await setup();
    expect((await failure(client.call("session.create", { mode: "nope", goal: "g" }))).code).toBe(RpcErrorCode.InvalidParams);
    expect((await client.call("session.list")).sessions).toEqual([]);
  });

  it("cancel aborts the signal and resolves open approval questions; the run ends cancelled", async () => {
    let seenAbort = false;
    let approved: boolean | undefined = true;
    const mode = dynamicMode(async (i) => {
      i.signal.addEventListener("abort", () => (seenAbort = true));
      approved = await i.requestApproval({ question: "go?" });
    });
    const { client, projectPath } = await setup({ mode });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await client.call("session.start", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).pendingApprovals.length === 1);
    expect(await isSessionRunLocked(projectPath, sessionId)).toBe(true);

    expect(await client.call("session.cancel", { sessionId })).toEqual({ ok: true, live: "cancelling" });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    expect(seenAbort).toBe(true);
    expect(approved).toBe(false);
    expect(await isSessionRunLocked(projectPath, sessionId)).toBe(false);
    const { events } = await client.call("session.export", { sessionId });
    expect(events.find((e) => e.type === "session.failed")).toMatchObject({ data: { status: "cancelled" } });
    // Gone from the live set: further control is refused.
    expect((await failure(client.call("session.cancel", { sessionId }))).code).toBe(RpcErrorCode.InvalidParams);
  });

  it("cancelling a session that never started drops it", async () => {
    const { client } = await setup({ mode: dynamicMode(async () => undefined) });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await client.call("session.cancel", { sessionId });
    expect((await failure(client.call("session.start", { sessionId }))).code).toBe(RpcErrorCode.InvalidParams);
    expect((await client.call("session.list")).sessions).toEqual([]);
  });

  it("approve maps to the session's approve/answer; unknown ids and non-approvals are refused", async () => {
    const answers: Array<boolean | string | undefined> = [];
    const mode = dynamicMode(async (i) => {
      answers.push(await i.requestApproval({ question: "first?" }));
      answers.push(await i.requestApproval({ question: "second?" }));
      answers.push(await i.ask({ question: "free text?" }));
    });
    const { client } = await setup({ mode });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await client.call("session.start", { sessionId });
    const pending = async () => (await client.call("session.get", { sessionId })).pendingApprovals;

    await until(async () => (await pending()).length === 1);
    expect((await failure(client.call("session.approve", { sessionId, id: "nope", decision: "approve" }))).code).toBe(RpcErrorCode.InvalidParams);
    await client.call("session.approve", { sessionId, id: (await pending())[0]!, decision: "approve" });
    await until(async () => answers.length === 1);
    await until(async () => (await pending()).length === 1);
    await client.call("session.approve", { sessionId, id: (await pending())[0]!, decision: "deny" });
    await until(async () => answers.length === 2);
    expect(answers).toEqual([true, false]);

    // The third question is free text, not an approval: approve/deny cannot answer it.
    const { events } = await client.call("session.export", { sessionId });
    const free = events.filter((e) => e.type === "user.question").at(-1) as { data: { questionId: string } };
    for (const decision of ["approve", "deny"] as const) {
      expect((await failure(client.call("session.approve", { sessionId, id: free.data.questionId, decision }))).code).toBe(RpcErrorCode.InvalidParams);
    }
    await client.call("session.cancel", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
  });

  it("a static stage gate can be approved but not denied", async () => {
    const { client } = await setup({ autonomy: "manual" });
    const { sessionId } = await client.call("session.create", { mode: "solo", goal: "g" });
    await client.call("session.start", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).pendingApprovals.includes("execute"));
    expect((await failure(client.call("session.approve", { sessionId, id: "execute", decision: "deny" }))).code).toBe(RpcErrorCode.Rejected);
    expect((await failure(client.call("session.approve", { sessionId, id: "review", decision: "approve" }))).code).toBe(RpcErrorCode.InvalidParams);
    await client.call("session.approve", { sessionId, id: "execute", decision: "approve" });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    const { events } = await client.call("session.export", { sessionId });
    expect(events.map((e) => e.type)).toContain("session.completed");
  });
});

describe("autonomy, expiry, cap and export bounds", () => {
  const mode = () => dynamicMode(async () => undefined);

  it("a session never starts with more autonomy than the host, the client or maxAutonomy allow", async () => {
    const a = await setup({ mode: mode(), autonomy: "supervised" });
    expect((await a.client.call("session.create", { mode: "lead", goal: "g", autonomy: "autopilot" })).autonomy).toBe("supervised");
    expect((await a.client.call("session.create", { mode: "lead", goal: "g", autonomy: "manual" })).autonomy).toBe("manual");
    expect((await a.client.call("session.create", { mode: "lead", goal: "g" })).autonomy).toBe("supervised");

    const b = await setup({ mode: mode(), autonomy: "autopilot", maxAutonomy: "supervised" });
    expect((await b.client.call("session.create", { mode: "lead", goal: "g" })).autonomy).toBe("supervised");
    expect((await b.client.call("session.create", { mode: "lead", goal: "g", autonomy: "autopilot" })).autonomy).toBe("supervised");
    expect((await b.client.call("session.create", { mode: "lead", goal: "g", autonomy: "manual" })).autonomy).toBe("manual");
  });

  it("a created session that is not started in time is dropped", async () => {
    const { client } = await setup({ mode: mode(), createdTtlMs: 50 });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await until(async () => (await client.call("session.list")).sessions.length === 0);
    expect((await failure(client.call("session.start", { sessionId }))).code).toBe(RpcErrorCode.InvalidParams);
  });

  it("at most 32 sessions are live, also when creates overlap while the host works", async () => {
    const { client } = await setup({ mode: mode(), launchDelayMs: 30 });
    const results = await Promise.allSettled(Array.from({ length: 34 }, () => client.call("session.create", { mode: "lead", goal: "g" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(32);
    const rejects = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejects.map((r) => (r.reason as RpcRemoteError).code)).toEqual([RpcErrorCode.Rejected, RpcErrorCode.Rejected]);
  });

  it("export stops at 5,000 events and reports truncated; fromSeq continues", async () => {
    const { client, projectPath } = await setup({ mode: mode() });
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const log = await EventLog.open(projectPath, sessionId);
    await Promise.all(Array.from({ length: 5_010 }, () => log.append({ type: "user.answer", sessionId, data: { questionId: "q", answer: "a" } })));
    await log.close();
    const first = await client.call("session.export", { sessionId });
    expect(first.events).toHaveLength(5_000);
    expect(first.truncated).toBe(true);
    const rest = await client.call("session.export", { sessionId, fromSeq: 5_000 });
    expect(rest.events).toHaveLength(10);
    expect(rest.truncated).toBe(false);
  });
});

describe("worktrees", () => {
  const S1 = "11111111-1111-4111-8111-111111111111";
  const S2 = "22222222-2222-4222-8222-222222222222";

  async function seatWithChange(wm: WorktreeManager, sessionId = S1, seatId = "opus-1") {
    const info = await wm.create({ sessionId, seatId });
    await fs.writeFile(path.join(info.path, "a.txt"), "two\n");
    await fs.writeFile(path.join(info.path, "new.txt"), "fresh\n");
    return info;
  }

  it("diff returns the seat's changes", async () => {
    const { client, wm } = await setup();
    await seatWithChange(wm);
    const diff = await client.call("worktree.diff", { sessionId: S1, seatId: "opus-1" });
    expect(diff).toMatchObject({ dirty: true, truncated: false });
    expect(diff.files.sort()).toEqual(["a.txt", "new.txt"]);
    expect(diff.diff).toContain("+two");
  });

  it("ids are checked against the manifest: unknown, foreign and traversal ids never reach git or the filesystem", async () => {
    const { client, wm, projectPath } = await setup();
    await seatWithChange(wm);
    const outside = path.join(projectPath, "..", "outside-marker");
    const cases = [
      { sessionId: S2, seatId: "opus-1" }, // another session's id
      { sessionId: S1, seatId: "opus-2" }, // unknown seat
      { sessionId: S1, seatId: "../opus-1" },
      { sessionId: S1, seatId: "../../../../etc" },
      { sessionId: "../11111111", seatId: "opus-1" },
      { sessionId: S1, seatId: path.join(projectPath, ".assentor") },
    ];
    for (const key of cases) {
      expect((await failure(client.call("worktree.diff", key))).code).toBe(RpcErrorCode.InvalidParams);
      expect((await failure(client.call("worktree.apply", { ...key, confirm: true }))).code).toBe(RpcErrorCode.InvalidParams);
      expect((await failure(client.call("worktree.discard", { ...key, confirm: true, force: true }))).code).toBe(RpcErrorCode.InvalidParams);
    }
    expect(await fs.access(outside).then(() => true, () => false)).toBe(false);
    expect(await wm.list(S1)).toHaveLength(1);
  });

  it("apply and discard need confirm: true; without it nothing changes", async () => {
    const { client, wm, projectPath } = await setup();
    await seatWithChange(wm);
    const key = { sessionId: S1, seatId: "opus-1" };
    for (const confirm of [undefined, false, "true", 1]) {
      const extra = confirm === undefined ? {} : { confirm };
      expect((await failure(client.call("worktree.apply", { ...key, ...extra } as never))).code).toBe(RpcErrorCode.InvalidParams);
      expect((await failure(client.call("worktree.discard", { ...key, ...extra } as never))).code).toBe(RpcErrorCode.InvalidParams);
    }
    expect(await wm.list(S1)).toHaveLength(1);
    expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf8")).toBe("one\n");
  });

  it("apply with confirm lands the work on the main checkout", async () => {
    const { client, wm, projectPath } = await setup();
    await seatWithChange(wm);
    const result = await client.call("worktree.apply", { sessionId: S1, seatId: "opus-1", confirm: true, message: "seat work" });
    expect(result).toMatchObject({ ok: true, strategy: "squash", changed: true });
    expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf8")).toBe("two\n");
    expect(await git(projectPath, "log", "-1", "--format=%s")).toBe("seat work");
  });

  it("allowedPaths: traversal is refused up front; a change outside the set aborts and leaves main untouched", async () => {
    const { client, wm, projectPath } = await setup();
    await seatWithChange(wm);
    const key = { sessionId: S1, seatId: "opus-1", confirm: true as const };
    for (const bad of ["../a.txt", "/etc/passwd", "a\\b"]) {
      expect((await failure(client.call("worktree.apply", { ...key, allowedPaths: [bad] }))).code).toBe(RpcErrorCode.Rejected);
    }
    const err = await failure(client.call("worktree.apply", { ...key, allowedPaths: ["a.txt"] })); // new.txt is outside
    expect(err.code).toBe(RpcErrorCode.Rejected);
    expect(err.message).not.toContain(projectPath);
    expect(await fs.readFile(path.join(projectPath, "a.txt"), "utf8")).toBe("one\n");
  });

  it("discard with confirm removes the worktree and branch; force is needed for uncommitted changes", async () => {
    const { client, wm } = await setup();
    const info = await seatWithChange(wm);
    const key = { sessionId: S1, seatId: "opus-1", confirm: true as const };
    expect((await failure(client.call("worktree.discard", key))).code).toBe(RpcErrorCode.Rejected); // dirty
    expect(await wm.list(S1)).toHaveLength(1);
    expect(await client.call("worktree.discard", { ...key, force: true })).toEqual({ ok: true });
    expect(await wm.list(S1)).toEqual([]);
    expect(await fs.access(info.path).then(() => true, () => false)).toBe(false);
  });

  it("a live session's worktrees cannot be discarded until it is cancelled", async () => {
    const { client, wm } = await setup({ mode: dynamicMode(async (i) => void (await i.ask({ question: "hold" }))) });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await wm.create({ sessionId, seatId: "opus-1" });
    await client.call("session.start", { sessionId });
    const key = { sessionId, seatId: "opus-1", confirm: true as const };
    expect((await failure(client.call("worktree.discard", key))).code).toBe(RpcErrorCode.Rejected);
    await client.call("session.cancel", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    expect(await client.call("worktree.discard", key)).toEqual({ ok: true });
  });

  it("apply is refused while the session is live, also while cancelling", async () => {
    const { client, wm } = await setup({ mode: dynamicMode(async (i) => void (await i.ask({ question: "hold" }))) });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    const info = await wm.create({ sessionId, seatId: "opus-1" });
    await fs.writeFile(path.join(info.path, "a.txt"), "two\n");
    await client.call("session.start", { sessionId });
    const key = { sessionId, seatId: "opus-1", confirm: true as const };
    expect((await failure(client.call("worktree.apply", key))).code).toBe(RpcErrorCode.Rejected);
    await client.call("session.cancel", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    expect(await client.call("worktree.apply", key)).toMatchObject({ ok: true, changed: true });
  });

  it.each(["writer.lock", "run.lock"])("apply and discard are refused while another live process holds the session's %s", async (name) => {
    const { client, wm, projectPath } = await setup();
    await seatWithChange(wm);
    const lock = path.join(projectPath, ".assentor", "sessions", S1, name);
    await fs.mkdir(path.dirname(lock), { recursive: true });
    // The parent process is alive and is not this one.
    await fs.writeFile(lock, `${JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString(), token: "other" })}\n`);
    const key = { sessionId: S1, seatId: "opus-1", confirm: true as const };
    expect((await failure(client.call("worktree.apply", key))).code).toBe(RpcErrorCode.Rejected);
    expect((await failure(client.call("worktree.discard", { ...key, force: true }))).code).toBe(RpcErrorCode.Rejected);
    expect(await wm.list(S1)).toHaveLength(1);
    // A dead owner is a stale lock: not live.
    await fs.writeFile(lock, `${JSON.stringify({ pid: 2 ** 22 - 1, host: os.hostname(), startedAt: new Date().toISOString(), token: "dead" })}\n`);
    expect(await client.call("worktree.discard", { ...key, force: true })).toEqual({ ok: true });
  });
});

describe("seat control (FU-12)", () => {
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const stageFor = (seatId: string, model?: string): StageSpec => ({
    id: `work-${seatId}`,
    kind: "execute",
    options: { seat: { id: seatId, role: "engineer", ...(model ? { model } : {}) } },
    requireApproval: false,
  });
  const task = (i: ModeControllerInput, taskId: string) => ({ taskId, projectPath: i.deps.projectPath, contract: { goal: "g" } as never, prompt: "go" });

  /** Each turn is a real child process that lives until `cancel` kills it. */
  function spawningExecutor(pids: number[]): Executor {
    const children = new Map<string, ChildProcess>();
    const turn = (taskId: string) =>
      new Promise<{ status: "cancelled"; summary: string }>((resolve) => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        children.set(taskId, child);
        pids.push(child.pid!);
        cleanups.push(() => void child.kill("SIGKILL"));
        child.on("exit", () => resolve({ status: "cancelled", summary: "killed" }));
      });
    return {
      ...executor(),
      run: (t) => turn(t.taskId),
      continue: (t) => turn(t.taskId),
      cancel: async (taskId) => killProcessTree(children.get(taskId)),
    };
  }

  it("stop kills only that seat's process; the controller sees the turn cancelled and the session goes on", async () => {
    const pids: Record<string, number[]> = { a: [], b: [] };
    const seats = ["a", "b"]; // the order the controller makes them in
    const results: Record<string, string> = {};
    const mode = dynamicMode(async (i) => {
      const turns = (["a", "b"] as const).map(async (seat) => {
        const ex = i.deps.createExecutor(stageFor(seat));
        results[seat] = (await ex.run(task(i, `t-${seat}`))).status;
      });
      await Promise.all(turns);
    });
    const { client } = await setup({ mode, executor: () => spawningExecutor(pids[seats.shift()!]!) });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await client.call("session.start", { sessionId });
    await until(() => pids.a!.length === 1 && pids.b!.length === 1);

    expect((await failure(client.call("seat.stop", { sessionId, seatId: "a" } as never))).code).toBe(RpcErrorCode.InvalidParams);
    expect(await client.call("seat.stop", { sessionId, seatId: "a", confirm: true })).toEqual({ ok: true });
    await until(() => results.a !== undefined);
    expect(results.a).toBe("cancelled");
    expect(isAlive(pids.a![0]!)).toBe(false);
    expect(isAlive(pids.b![0]!)).toBe(true);
    expect((await client.call("session.get", { sessionId })).session.live).toBe("running");
    // Nothing of a's is running any more.
    expect((await failure(client.call("seat.stop", { sessionId, seatId: "a", confirm: true }))).code).toBe(RpcErrorCode.Rejected);

    await client.call("seat.stop", { sessionId, seatId: "b", confirm: true });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    const { events } = await client.call("session.export", { sessionId });
    expect(events.map((e) => e.type)).toContain("session.completed");
    // Finished: the seat is out of reach.
    expect((await failure(client.call("seat.stop", { sessionId, seatId: "b", confirm: true }))).code).toBe(RpcErrorCode.InvalidParams);
  });

  it("stopping a static stage's Supervisor seat fails the session with the stop as the reason", async () => {
    const pids: number[] = [];
    const { client } = await setup({ executor: () => spawningExecutor(pids) });
    const { sessionId } = await client.call("session.create", { mode: "solo", goal: "g" });
    await client.call("session.start", { sessionId });
    await until(() => pids.length === 1);
    // No team on solo's execute stage: the seat is named after the stage.
    await client.call("seat.stop", { sessionId, seatId: "execute", confirm: true });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    expect(isAlive(pids[0]!)).toBe(false);
    const { events } = await client.call("session.export", { sessionId });
    const failed = events.find((e) => e.type === "session.failed") as { data: { status: string; reason?: string } };
    expect(failed.data.status).toBe("failed");
    expect(failed.data.reason).toContain("seat execute stopped over RPC");
    expect(JSON.stringify(events)).not.toContain("Ctrl+C");
  });

  it("setModel applies at the seat's next turn and emits pending then applied seat.model.changed", async () => {
    const models: Array<string | undefined> = [];
    let current: string | undefined;
    const switchable = (): Executor => ({
      ...executor(),
      run: async () => (models.push(current), { status: "completed", summary: "done" }),
      setModel: (model) => void (current = model),
    });
    const mode = dynamicMode(async (i) => {
      const ex = i.deps.createExecutor(stageFor("a", "sonnet-x"));
      await ex.run(task(i, "t1"));
      await i.requestApproval({ question: "next turn?" });
      await ex.run(task(i, "t2"));
    });
    const { client } = await setup({ mode, executor: switchable });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await client.call("session.start", { sessionId });
    const pending = async () => (await client.call("session.get", { sessionId })).pendingApprovals;
    await until(async () => (await pending()).length === 1);

    for (const model of ["--yolo", "a b", ""]) {
      expect((await failure(client.call("seat.setModel", { sessionId, seatId: "a", model }))).code).toBe(RpcErrorCode.InvalidParams);
    }
    expect(await client.call("seat.setModel", { sessionId, seatId: "a", model: "opus-x" })).toEqual({ ok: true });
    expect(models).toEqual([undefined]); // not applied before the next turn
    await client.call("session.approve", { sessionId, id: (await pending())[0]!, decision: "approve" });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);

    expect(models).toEqual([undefined, "opus-x"]);
    const { events } = await client.call("session.export", { sessionId });
    expect(events.filter((e) => e.type === "seat.model.changed")).toMatchObject([
      { seatId: "a", data: { from: "sonnet-x", to: "opus-x", pending: true } },
      { seatId: "a", data: { from: "sonnet-x", to: "opus-x", pending: false } },
    ]);
    expect((await failure(client.call("seat.setModel", { sessionId, seatId: "a", model: "opus-y" }))).code).toBe(RpcErrorCode.InvalidParams);
  });

  it("unknown, foreign and fixed-model seats, unknown sessions and not-started sessions are refused", async () => {
    const mode = dynamicMode(async (i) => {
      i.deps.createExecutor(stageFor(i.goal)); // seat named after the goal; no setModel
      await i.requestApproval({ question: "hold" });
    });
    const { client } = await setup({ mode });
    const one = (await client.call("session.create", { mode: "lead", goal: "a" })).sessionId;
    const two = (await client.call("session.create", { mode: "lead", goal: "b" })).sessionId;
    // Created, not started.
    expect((await failure(client.call("seat.stop", { sessionId: one, seatId: "a", confirm: true }))).code).toBe(RpcErrorCode.Rejected);
    await client.call("session.start", { sessionId: one });
    await client.call("session.start", { sessionId: two });
    await until(async () => (await client.call("session.get", { sessionId: two })).pendingApprovals.length === 1);

    const rejectedCalls = [
      client.call("seat.setModel", { sessionId: one, seatId: "a", model: "m" }), // executor cannot switch
      client.call("seat.setModel", { sessionId: one, seatId: "b", model: "m" }), // b is session two's seat
      client.call("seat.setModel", { sessionId: one, seatId: "nobody", model: "m" }),
      client.call("seat.stop", { sessionId: one, seatId: "b", confirm: true }),
      client.call("seat.stop", { sessionId: one, seatId: "a", confirm: true }), // nothing running
    ];
    for (const call of rejectedCalls) expect((await failure(call)).code).toBe(RpcErrorCode.Rejected);
    for (const bad of ["22222222-2222-4222-8222-222222222222", "not-an-id"]) {
      expect((await failure(client.call("seat.stop", { sessionId: bad, seatId: "a", confirm: true }))).code).toBe(RpcErrorCode.InvalidParams);
      expect((await failure(client.call("seat.setModel", { sessionId: bad, seatId: "a", model: "m" }))).code).toBe(RpcErrorCode.InvalidParams);
    }
    for (const sessionId of [one, two]) await client.call("session.cancel", { sessionId });
    await until(async () => (await client.call("session.list")).sessions.every((s) => s.live === undefined));
  });
});
