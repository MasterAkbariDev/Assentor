import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEngineRpcServer,
  createInProcessTransport,
  createMockLead,
  getMode,
  MockReviewer,
  parseAssentorConfig,
  RpcClient,
  RpcErrorCode,
  RpcRemoteError,
  WorktreeManager,
  type ControllerTurn,
  type EngineEvent,
  type Executor,
  type MockLeadStep,
  type ModeControllerInput,
  type ModeDefinition,
  type RosterEntry,
  type Seat,
  type StageRunnerDeps,
} from "../../packages/engine/src/index.js";
import { builtinPromptDir, PromptLibrary } from "../../packages/engine/src/prompts/index.js";
import { SeatScheduler } from "../../packages/engine/src/seats/index.js";
import { emptyLeadBoardView, reduceLeadEvents } from "../../packages/ui-shared/src/lead.js";

// FU-18b: lead.override / lead.pin / lead.pause / lead.resume over the in-process transport, driving a real Lead with MockLead.
vi.setConfig({ testTimeout: 60_000 });
const exec = promisify(execFile);
const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rpc-lead-")));
  dirs.push(dir);
  const git = (...args: string[]) => exec("git", args, { cwd: dir });
  await git("-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git("config", "user.email", "assentor@test");
  await git("config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n");
  await fs.writeFile(path.join(dir, "base.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  return dir;
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
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

const ROSTER: RosterEntry[] = [
  { provider: "mock", model: "cheap", label: "cheap", strengths: ["coding"], speed: "fast", cost: "low", freeSlots: 4 },
  { provider: "mock", model: "strong", label: "strong", strengths: ["coding"], speed: "slow", cost: "high", freeSlots: 4 },
];
const task = (id: string, dir: string) => ({ id, title: `Task ${id}`, ownedPaths: [dir], acceptance: ["done"] });
const plan = (...tasks: unknown[]) => ({ action: "plan_tasks", tasks });
const assign = (taskId: string, model = "cheap") => ({ action: "assign", taskId, seat: { role: "engineer", provider: "mock", model, permissions: "edit" } });
const turn = (...actions: unknown[]) => ({ actions }) as ControllerTurn;

interface Run {
  taskId: string;
  seat: Seat;
}

/**
 * A Lead session over RPC. `hold(n)` blocks the lead's n-th turn (0-based) until the returned release is called;
 * agents write `<owned dir>/x.txt` and report done.
 */
async function setup(script: MockLeadStep[], options: { mode?: ModeDefinition } = {}) {
  const projectPath = await makeRepo();
  const wm = new WorktreeManager({ repoPath: projectPath });
  const lead = createMockLead(script);
  const runs: Run[] = [];
  const holds = new Map<number, { reached: boolean; release: () => void; gate: Promise<void> }>();
  let turns = 0;
  const hold = (n: number) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const entry = { reached: false, release, gate };
    holds.set(n, entry);
    return entry;
  };
  const config = parseAssentorConfig({ modes: { lead: { lead: { provider: "mock", model: "lead" }, policy: { reviewBeforeAccept: false } } } });
  const sessionId: { current?: string } = {};
  const createExecutor: StageRunnerDeps["createExecutor"] = (stage) => {
    const seat = stage.options.seat as Seat;
    const ex: Executor = {
      name: `mock-${seat.model}`,
      capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
      async run(t) {
        const id = /^task-(t\d+)-/.exec(t.taskId)![1]!.toUpperCase();
        runs.push({ taskId: id, seat });
        const dir = id.toLowerCase();
        await fs.mkdir(path.join(t.projectPath, dir), { recursive: true });
        await fs.writeFile(path.join(t.projectPath, dir, "x.txt"), `${seat.model}\n`);
        const report = { taskId: id, status: "done", summary: "did it", filesChanged: [`${dir}/x.txt`], testsRun: [] };
        return { status: "completed", summary: ["```json", JSON.stringify(report), "```"].join("\n") };
      },
      continue: async () => ({ status: "completed", summary: "no report" }),
      cancel: async () => undefined,
    };
    return ex;
  };
  const prompts = await PromptLibrary.load({ builtinDir: builtinPromptDir(), userDir: path.join(projectPath, ".no-user-prompts"), projectPath });
  const server = createEngineRpcServer({
    projectPath,
    engineVersion: "test",
    listCacheMs: 0,
    worktrees: wm,
    sessionHost: {
      launch: () => ({
        autonomy: "supervised",
        config,
        worktrees: wm,
        ...(options.mode ? { mode: options.mode } : {}),
        deps: {
          projectPath,
          scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
          runStep: async () => ({}),
          seatsFor: () => [],
          createExecutor,
          createReviewer: () => new MockReviewer({ name: "r1" }),
          supervisor: { skipGates: true },
        },
        host: {
          askSeat: async (request) => {
            if (request.seat.role !== "summarizer") {
              const entry = holds.get(turns++);
              if (entry) {
                entry.reached = true;
                await entry.gate;
              }
            }
            return lead.askSeat(request);
          },
          roster: () => ROSTER,
          prompts,
        },
      }),
    },
  });
  const { client: transport } = createInProcessTransport(server);
  const client = new RpcClient(transport);
  cleanups.push(async () => {
    if (sessionId.current) await client.call("session.cancel", { sessionId: sessionId.current }).catch(() => undefined);
    client.close();
  });
  const start = async () => {
    const { sessionId: id } = await client.call("session.create", { mode: "lead", goal: "Do T1 and T2" });
    sessionId.current = id;
    await client.call("session.start", { sessionId: id });
    return id;
  };
  const events = async (id: string) => (await client.call("session.export", { sessionId: id })).events as unknown as EngineEvent[];
  const userActions = async (id: string) =>
    (await events(id)).filter((e) => e.type === "lead.action" && (e.data as { by?: string }).by === "user").map((e) => e.data as Record<string, unknown>);
  const ended = (id: string) => until(async () => (await client.call("session.get", { sessionId: id })).session.live === undefined);
  return { client, server, lead, runs, hold, start, events, userActions, ended };
}

describe("lead.override", () => {
  it("reassigns at the next decision point and shows as a user action on the board and log", async () => {
    const s = await setup([
      turn(plan(task("T1", "t1"), task("T2", "t2")), assign("T2", "strong")),
      turn({ action: "retire", seatId: "agent-9" }),
      () => turn({ action: "retire", seatId: "agent-9" }),
    ]);
    const second = s.hold(1);
    const id = await s.start();
    await until(() => second.reached);
    // T1 is in the backlog; agent-1 (strong) did T2 and is idle.
    expect(await s.client.call("lead.override", { sessionId: id, taskId: "T1", seatId: "agent-1" })).toEqual({ ok: true });
    expect(s.runs.filter((r) => r.taskId === "T1")).toEqual([]); // queued, not applied mid-turn
    second.release();
    await until(async () => (await s.userActions(id)).length === 1);
    await until(() => s.runs.some((r) => r.taskId === "T1"));
    expect(s.runs.find((r) => r.taskId === "T1")!.seat).toMatchObject({ id: "agent-1", model: "strong" });

    await s.ended(id); // the script runs out: the lead seat fails, the session ends blocked
    const events = await s.events(id);
    const types = events.map((e) => (e.type === "lead.action" ? `${e.type}:${(e.data as { action: string }).action}` : e.type));
    // Applied after the second lead turn, before the third.
    const at = types.indexOf("lead.action:override");
    expect(types.lastIndexOf("lead.turn", at)).toBe(types.indexOf("lead.turn", types.indexOf("lead.turn") + 1));
    expect(await s.userActions(id)).toEqual([expect.objectContaining({ action: "override", by: "user", accepted: true, taskId: "T1", seatId: "agent-1" })]);
    expect(s.lead.prompts[2]).toMatch(/the user: override: done/);

    const view = events.reduce(reduceLeadEvents, emptyLeadBoardView());
    expect(view.tasks.find((t) => t.id === "T1")).toMatchObject({ seatId: "agent-1" });
    expect(view.actions.find((a) => a.action === "override")).toMatchObject({ by: "user", accepted: true });
  });

  it("refuses an accepted task and an unknown seat or task", async () => {
    const s = await setup([turn(plan(task("T1", "t1")), assign("T1")), turn({ action: "accept", taskId: "T1" }), turn({ action: "retire", seatId: "agent-9" })]);
    const third = s.hold(2);
    const id = await s.start();
    await until(() => third.reached);
    const refused = await failure(s.client.call("lead.override", { sessionId: id, taskId: "T1", seatId: "agent-1" }));
    expect(refused.code).toBe(RpcErrorCode.Rejected);
    expect(refused.message).toMatch(/T1 is accepted/);
    expect((await failure(s.client.call("lead.override", { sessionId: id, taskId: "T9", seatId: "agent-1" }))).code).toBe(RpcErrorCode.Rejected);
    expect((await failure(s.client.call("lead.pin", { sessionId: id, taskId: "T1", model: "strong" }))).code).toBe(RpcErrorCode.Rejected);
    third.release();
    await s.ended(id);
    expect(await s.userActions(id)).toEqual([]);
    // Finished sessions are InvalidParams, like seat control.
    expect((await failure(s.client.call("lead.pause", { sessionId: id }))).code).toBe(RpcErrorCode.InvalidParams);
  });
});

describe("lead.pin", () => {
  it("changes the model of that task's next run only; invalid model ids are InvalidParams", async () => {
    const s = await setup([turn(plan(task("T1", "t1"), task("T2", "t2"))), turn(assign("T1"), assign("T2")), turn({ action: "retire", seatId: "agent-9" })]);
    const second = s.hold(1);
    const id = await s.start();
    await until(() => second.reached);
    expect((await failure(s.client.call("lead.pin", { sessionId: id, taskId: "T1", model: "--evil" }))).code).toBe(RpcErrorCode.InvalidParams);
    expect(await s.client.call("lead.pin", { sessionId: id, taskId: "T1", model: "strong" })).toEqual({ ok: true });
    second.release();
    await until(() => s.runs.length === 2);
    const byTask = Object.fromEntries(s.runs.map((r) => [r.taskId, r.seat.model]));
    expect(byTask).toEqual({ T1: "strong", T2: "cheap" });
    await s.ended(id);
    const events = await s.events(id);
    // The seat itself is still the lead's cheap hire.
    expect(events.find((e) => e.type === "seat.spawned" && e.seatId === "agent-1")?.data).toMatchObject({ model: "cheap" });
    const view = events.reduce(reduceLeadEvents, emptyLeadBoardView());
    expect(view.tasks.find((t) => t.id === "T1")?.pinnedModel).toBe("strong");
    expect(view.tasks.find((t) => t.id === "T2")?.pinnedModel).toBeUndefined();
  });
});

describe("lead.pause / lead.resume", () => {
  it("pause stops new lead actions while agents finish; resume continues", async () => {
    const s = await setup([turn(plan(task("T1", "t1"))), turn(plan(task("T1", "t1"))), turn({ action: "retire", seatId: "agent-9" })]);
    const first = s.hold(0);
    const id = await s.start();
    await until(() => first.reached);
    expect(await s.client.call("lead.pause", { sessionId: id })).toEqual({ ok: true });
    expect((await failure(s.client.call("lead.pause", { sessionId: id }))).code).toBe(RpcErrorCode.Rejected);
    first.release();
    await until(async () => (await s.events(id)).some((e) => e.type === "lead.action" && (e.data as { by?: string }).by === undefined));
    await new Promise((r) => setTimeout(r, 200));
    const paused = await s.events(id);
    expect(paused.filter((e) => e.type === "task.created")).toEqual([]);
    expect(paused.find((e) => e.type === "lead.action" && (e.data as { action: string }).action === "plan_tasks")?.data).toMatchObject({
      accepted: false,
      reason: expect.stringMatching(/paused/),
    });
    expect(s.lead.prompts).toHaveLength(1); // no new turn while paused
    expect(paused.reduce(reduceLeadEvents, emptyLeadBoardView()).paused).toBe(true);

    expect(await s.client.call("lead.resume", { sessionId: id })).toEqual({ ok: true });
    await until(async () => (await s.events(id)).some((e) => e.type === "task.created"));
    await s.ended(id);
    const events = await s.events(id);
    expect((await s.userActions(id)).map((a) => a.action)).toEqual(["pause", "resume"]);
    expect(events.reduce(reduceLeadEvents, emptyLeadBoardView()).paused).toBe(false);
  });
});

describe("access and mode", () => {
  it("a non-lead session is refused", async () => {
    const lead = getMode("lead")!;
    const mode = {
      ...lead,
      id: "pair",
      validate: undefined,
      createController: (input: ModeControllerInput) => ({ run: () => new Promise((r) => input.signal.addEventListener("abort", () => r({ status: "blocked" }))) }),
    } as ModeDefinition;
    const s = await setup([], { mode });
    const id = await s.start();
    for (const call of [
      s.client.call("lead.pause", { sessionId: id }),
      s.client.call("lead.resume", { sessionId: id }),
      s.client.call("lead.override", { sessionId: id, taskId: "T1", seatId: "agent-1" }),
      s.client.call("lead.pin", { sessionId: id, taskId: "T1", model: null }),
    ]) {
      const error = await failure(call);
      expect(error.code).toBe(RpcErrorCode.Rejected);
      expect(error.message).toMatch(/not lead/);
    }
    expect((await failure(s.client.call("lead.pause", { sessionId: "22222222-2222-4222-8222-222222222222" }))).code).toBe(RpcErrorCode.InvalidParams);
  });

  it("a read connection is denied every lead control", async () => {
    const { server } = await setup([]);
    const frames: string[] = [];
    const connection = server.connect((f) => void frames.push(f)); // no allowWrite
    const methods = ["lead.override", "lead.pin", "lead.pause", "lead.resume"];
    for (const [i, method] of methods.entries()) await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: i, method, params: {} }));
    expect(frames.map((f) => JSON.parse(f).error.code)).toEqual(Array(4).fill(RpcErrorCode.WriteNotAllowed));
  });
});
