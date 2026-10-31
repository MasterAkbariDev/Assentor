import { execFile } from "node:child_process";
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
const deps = (projectPath: string): StageRunnerDeps => ({
  projectPath,
  scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
  runStep: async () => ({}),
  seatsFor,
  createExecutor: () => executor(),
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

async function setup(options: { autonomy?: "manual" | "supervised"; mode?: ModeDefinition } = {}): Promise<Setup> {
  const projectPath = await makeRepo();
  const wm = new WorktreeManager({ repoPath: projectPath });
  const sessionHost: SessionHost = {
    launch: () => ({
      autonomy: options.autonomy ?? "supervised",
      config,
      deps: deps(projectPath),
      ...(options.mode ? { mode: options.mode } : {}),
    }),
  };
  const server = createEngineRpcServer({ projectPath, engineVersion: "test", listCacheMs: 0, sessionHost, worktrees: wm });
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

  it("pause, resume and every seat method answer NotSupported", async () => {
    const { client } = await setup();
    const id = "11111111-1111-4111-8111-111111111111";
    const calls = [
      client.call("session.pause", { sessionId: id }),
      client.call("session.resume", { sessionId: id }),
      client.call("seat.setModel", { sessionId: id, seatId: "a", model: "m" }),
      client.call("seat.inject", { sessionId: id, seatId: "a", text: "hi" }),
      client.call("seat.stop", { sessionId: id, seatId: "a" }),
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
    const { client } = await setup({ mode });
    const { sessionId } = await client.call("session.create", { mode: "lead", goal: "g" });
    await client.call("session.start", { sessionId });
    await until(async () => (await client.call("session.get", { sessionId })).pendingApprovals.length === 1);

    expect(await client.call("session.cancel", { sessionId })).toEqual({ ok: true, live: "cancelling" });
    await until(async () => (await client.call("session.get", { sessionId })).session.live === undefined);
    expect(seenAbort).toBe(true);
    expect(approved).toBe(false);
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
});
