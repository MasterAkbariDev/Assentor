import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "../../src/core/ids.js";
import { expandSeatSpecs } from "../../src/core/seats.js";
import { runNegotiation, type SeatStepRunner } from "../../src/negotiation/engine.js";
import {
  SplitPlanSchema,
  createDivideStrategy,
  isOwned,
  pathsOverlap,
  planWaves,
  type DivideDeps,
} from "../../src/negotiation/strategies/divide.js";
import { NegotiationCancelledError } from "../../src/negotiation/strategy.js";
import type { EngineEventDraft } from "../../src/protocol/events.js";
import type { Executor, ExecutorResult, ExecutorTask } from "../../src/providers/executors/types.js";
import { PromptLibrary } from "../../src/prompts/index.js";
import { SeatScheduler } from "../../src/seats/index.js";
import { WorktreeManager } from "../../src/worktrees/index.js";

const exec = promisify(execFile);
// Real git in temp repos; slow CI machines need the headroom.
vi.setConfig({ testTimeout: 60_000 });
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-divide-")));
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

const seats = expandSeatSpecs([
  { provider: "claude-code", model: "opus", role: "planner" },
  { provider: "codex", model: "sol", count: 2, permissions: "edit" },
]);

type Plan = Array<{ id: string; description?: string; ownedPaths: string[]; dependsOn?: string[] }>;
const plan = (subtasks: Plan) => ({
  subtasks: subtasks.map((s) => ({ description: `do ${s.id}`, dependsOn: [], ...s })),
});

type PartScript = (part: string, dir: string, task: ExecutorTask) => Promise<ExecutorResult | void> | ExecutorResult | void;

/** Executor whose behaviour per part is scripted; `cancel(taskId)` ends a pending run as cancelled. */
function fakeExecutors(script: PartScript, options: { ignoreCancel?: boolean } = {}) {
  const started: string[] = [];
  const cancelled: string[] = [];
  let active = 0;
  let maxActive = 0;
  const waiting = new Map<string, (r: ExecutorResult) => void>();
  const create = (): Executor => ({
    name: "fake",
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
    async run(task) {
      const part = /implementing part (\S+) /.exec(task.prompt)![1]!;
      started.push(part);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const cancelledRun = new Promise<ExecutorResult>((resolve) => waiting.set(task.taskId, resolve));
        const outcome = Promise.resolve(script(part, task.projectPath, task));
        const result = await Promise.race([outcome, cancelledRun]);
        return result ?? { status: "completed", summary: `${part} done` };
      } finally {
        active -= 1;
      }
    },
    async continue() {
      throw new Error("not used");
    },
    async cancel(taskId) {
      cancelled.push(taskId);
      if (!options.ignoreCancel) waiting.get(taskId)?.({ status: "cancelled", summary: "cancelled" });
    },
  });
  return { create, started, cancelled, maxActive: () => maxActive };
}

const write = async (dir: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  }
};

const hang: PartScript = () => new Promise<never>(() => undefined);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

async function setup(script: PartScript, options: { ignoreCancel?: boolean } = {}) {
  const repo = await makeRepo();
  const worktrees = new WorktreeManager({ repoPath: repo });
  const executors = fakeExecutors(script, options);
  const sessionId = createId();
  const events: EngineEventDraft[] = [];
  const abort = new AbortController();
  const deps: DivideDeps = { worktrees, createExecutor: executors.create, cancelGraceMs: 30 };
  const run = (
    planReply: unknown | (() => Promise<unknown>),
    opts: { options?: Record<string, unknown>; deps?: Partial<DivideDeps>; runStep?: SeatStepRunner } = {},
  ) => {
    const runStep: SeatStepRunner =
      opts.runStep ??
      (async ({ step }) => {
        if (step !== "divide-plan") throw new Error(`unexpected step ${step}`);
        return typeof planReply === "function" ? (planReply as () => Promise<unknown>)() : planReply;
      });
    return runNegotiation({
      sessionId,
      runId: "split",
      strategy: createDivideStrategy({ ...deps, ...opts.deps }),
      goal: "Build the feature",
      seats,
      options: opts.options ?? {},
      scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
      runStep,
      emit: (e) => events.push(e),
      signal: abort.signal,
    });
  };
  const integrationPath = async () => {
    const info = (await worktrees.list(sessionId)).find((w) => w.seatId === "divide-integration");
    return info?.path;
  };
  return { repo, worktrees, executors, sessionId, events, abort, run, integrationPath };
}

/** Every seat that started something (thinking/editing) got exactly one terminal event for it. */
function expectOneTerminalPerStart(events: EngineEventDraft[]) {
  const bySeat = new Map<string, { starts: number; ends: number }>();
  for (const e of events) {
    if (!e.seatId) continue;
    const entry = bySeat.get(e.seatId) ?? { starts: 0, ends: 0 };
    if (e.type === "seat.status" && (e.data.status === "thinking" || e.data.status === "editing")) entry.starts += 1;
    if (e.type === "seat.done" || e.type === "seat.error") entry.ends += 1;
    bySeat.set(e.seatId, entry);
  }
  for (const [seatId, { starts, ends }] of bySeat) expect({ seatId, ends }).toEqual({ seatId, ends: starts });
}

const status = (events: EngineEventDraft[], seatId: string) =>
  events.filter((e) => e.type === "seat.status" && e.seatId === seatId).map((e) => (e as { data: { status: string } }).data.status);

describe("divide: success path", () => {
  it("runs parts in waves, each in its own worktree, and merges them in order into the integration worktree", async () => {
    const seen: Record<string, string[]> = {};
    const t = await setup(async (part, dir) => {
      seen[part] = (await fs.readdir(dir)).sort();
      if (part === "S1") await write(dir, { "src/one.ts": "one\n" });
      if (part === "S2") await write(dir, { "src/two.ts": "two\n" });
      if (part === "S3") await write(dir, { "docs/three.md": "three\n" });
    });
    const { result } = await t.run(
      plan([
        { id: "S1", ownedPaths: ["src/one.ts"] },
        { id: "S2", ownedPaths: ["./src/two.ts"] },
        { id: "S3", ownedPaths: ["docs"], dependsOn: ["S1", "S2"] },
      ]),
    );

    expect(result.consensus).toEqual({ score: 1, reached: true });
    expect(result.rounds).toBe(3); // plan + 2 waves
    expect(result.decision).toContain("Integrated 3 of 3 parts");
    expect(result.decision).toContain("Applied, in order: S1, S2, S3");
    expect(result.rationale).toContain("S1 S2 | S3");
    expect(result.proposals.map((p) => p.label)).toEqual(["Part S1", "Part S2", "Part S3"]);
    expect(result.dissent).toEqual([]);
    // S3 started from the integration branch, so it saw S1's and S2's work.
    expect(seen.S3).toContain("src");
    expect(seen.S1).not.toContain("docs");

    const integration = (await t.integrationPath())!;
    expect(await fs.readFile(path.join(integration, "src/one.ts"), "utf8")).toBe("one\n");
    expect(await fs.readFile(path.join(integration, "src/two.ts"), "utf8")).toBe("two\n");
    expect(await fs.readFile(path.join(integration, "docs/three.md"), "utf8")).toBe("three\n");
    expect(await git(integration, "status", "--porcelain")).toBe("");
    expect((await git(integration, "log", "--format=%s", "--first-parent")).split("\n").slice(0, 3)).toEqual([
      "divide: S3",
      "divide: S2",
      "divide: S1",
    ]);
    // The main checkout is untouched.
    expect(await git(t.repo, "status", "--porcelain")).toBe("");
    expect(await fs.access(path.join(t.repo, "src")).then(() => true, () => false)).toBe(false);
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1");

    expect(t.executors.maxActive()).toBeLessThanOrEqual(2); // one part per edit seat at a time
    expectOneTerminalPerStart(t.events);
    expect(t.events.filter((e) => e.type === "negotiation.proposal")).toHaveLength(3);
    expect(t.events.at(-1)).toMatchObject({ type: "negotiation.consensus", data: { reached: true } });
  });

  it("runs at most one part per edit seat at a time", async () => {
    let activeMax = () => 0;
    const t = await setup(async (part, dir) => {
      // Hold each run until two overlap, so a slow `git worktree add` cannot hide the overlap.
      for (let i = 0; i < 300 && activeMax() < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
      await write(dir, { [`f/${part}.txt`]: part });
    });
    activeMax = t.executors.maxActive;
    const { result } = await t.run(plan(["A1", "A2", "A3", "A4", "A5"].map((id) => ({ id, ownedPaths: [`f/${id}.txt`] }))));
    expect(result.consensus.reached).toBe(true);
    expect(t.executors.maxActive()).toBe(2);
  });
});

describe("divide: failure paths", () => {
  it("never applies a failed part, skips its dependents and keeps its worktree marked failed", async () => {
    const t = await setup(async (part, dir) => {
      if (part === "S2") return { status: "failed", summary: "", error: "compile error" };
      await write(dir, { [`out/${part}.txt`]: part });
    });
    const { result } = await t.run(
      plan([
        { id: "S1", ownedPaths: ["out/S1.txt"] },
        { id: "S2", ownedPaths: ["out/S2.txt"] },
        { id: "S3", ownedPaths: ["out/S3.txt"], dependsOn: ["S2"] },
      ]),
    );

    expect(result.consensus.reached).toBe(false);
    expect(result.consensus.score).toBeCloseTo(1 / 3);
    expect(result.decision).toContain("Applied, in order: S1");
    expect(result.decision).toContain("Failed: S2 (executor failed: compile error)");
    expect(result.decision).toContain("Not run: S3");
    expect(result.dissent.map((d) => d.label)).toEqual(["Part S2"]);
    expect(t.executors.started.sort()).toEqual(["S1", "S2"]); // S3 never started

    const integration = (await t.integrationPath())!;
    expect(await fs.access(path.join(integration, "out/S1.txt")).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(integration, "out/S2.txt")).then(() => true, () => false)).toBe(false);
    const records = await t.worktrees.list(t.sessionId);
    expect(records.find((w) => w.seatId === "divide-p-s2")).toMatchObject({ outcome: "failed" });
    expect(records.find((w) => w.seatId === "divide-p-s1")).toMatchObject({ outcome: "applied" });
    expect(t.events.filter((e) => e.type === "seat.error")).toHaveLength(1);
    expectOneTerminalPerStart(t.events);
  });

  it("fails a part that changes files outside its ownedPaths, and does not apply it", async () => {
    const t = await setup(async (_part, dir) => {
      await write(dir, { "mine/x.txt": "x", "theirs/y.txt": "y" });
    });
    const { result } = await t.run(plan([{ id: "S1", ownedPaths: ["mine"] }]));
    expect(result.consensus.reached).toBe(false);
    expect(result.decision).toContain("changed files outside its ownedPaths: theirs/y.txt");
    const integration = (await t.integrationPath())!;
    expect(await fs.access(path.join(integration, "mine/x.txt")).then(() => true, () => false)).toBe(false);
  });

  it("treats an executor that needs input, throws or times out as a failed part", async () => {
    const t = await setup(async (part) => {
      if (part === "S1") return { status: "needs_input", summary: "which db?" };
      if (part === "S2") throw new Error("boom");
    });
    const { result } = await t.run(plan([{ id: "S1", ownedPaths: ["a1"] }, { id: "S2", ownedPaths: ["a2"] }]));
    expect(result.decision).toContain("S1 (executor needs_input: which db?)");
    expect(result.decision).toContain("S2 (executor error: boom)");
    expect(result.consensus.reached).toBe(false);
  });

  it("stops cleanly on a merge conflict: nothing forced, target clean, earlier parts kept, user prompted", async () => {
    const t = await setup(async (part, dir) => {
      if (part === "S1") await write(dir, { "s1.txt": "s1\n" });
      if (part === "S2") await write(dir, { "a.txt": "mine\n" });
      if (part === "S3") await write(dir, { "s3.txt": "s3\n" });
    });
    // Someone edits a.txt on the integration branch between the part finishing and the merge.
    const real = t.worktrees;
    const worktrees = {
      create: real.create.bind(real),
      diff: real.diff.bind(real),
      markFailed: real.markFailed.bind(real),
      applyTo: async (...args: Parameters<WorktreeManager["applyTo"]>) => {
        if (typeof args[0] !== "string" && args[1].seatId === "divide-p-s2") {
          const dir = (await t.integrationPath())!;
          await fs.writeFile(path.join(dir, "a.txt"), "theirs\n");
          await git(dir, "commit", "-qam", "outside edit");
        }
        return real.applyTo(...args);
      },
    };
    const { result } = await t.run(
      plan([
        { id: "S1", ownedPaths: ["s1.txt"] },
        { id: "S2", ownedPaths: ["a.txt"] },
        { id: "S3", ownedPaths: ["s3.txt"], dependsOn: ["S2"] },
      ]),
      { deps: { worktrees } },
    );

    expect(result.consensus.reached).toBe(false);
    expect(result.decision).toContain("Applied, in order: S1");
    expect(result.decision).toContain("Done but not applied: S2");
    expect(result.decision).toContain("Not run: S3");
    expect(result.decision).toContain("Stopped: merging part S2 conflicted");
    expect(result.dissent).toEqual([{ label: "Part S2", reason: "integration conflict in a.txt" }]);
    expect(t.executors.started.sort()).toEqual(["S1", "S2"]);

    const integration = (await t.integrationPath())!;
    expect(await git(integration, "status", "--porcelain")).toBe("");
    expect(await fs.access(path.join(integration, ".git")).then(() => true, () => false)).toBe(true);
    expect(await git(integration, "rev-parse", "-q", "--verify", "MERGE_HEAD").catch(() => "none")).toBe("none");
    expect(await fs.readFile(path.join(integration, "a.txt"), "utf8")).toBe("theirs\n");
    expect(await fs.readFile(path.join(integration, "s1.txt"), "utf8")).toBe("s1\n");
    // The conflicting part's worktree is kept for the user.
    expect((await t.worktrees.list(t.sessionId)).map((w) => w.seatId)).toContain("divide-p-s2");

    const integrator = seats[0]!.id; // role planner doubles as integrator when none is named
    const waiting = t.events.find((e) => e.type === "seat.status" && e.data.status === "waiting");
    expect(waiting).toMatchObject({ seatId: integrator });
    const warning = t.events.find((e) => e.type === "session.warning");
    expect(warning).toMatchObject({ seatId: integrator, data: { kind: "divide.conflict", part: "S2", files: ["a.txt"] } });
    expect((warning as { data: { message: string } }).data.message).toContain("Resolve it by hand");
    expect(status(t.events, integrator).at(-1)).toBe("waiting");
    expectOneTerminalPerStart(t.events);
  });

  it("reports an applyTo failure as a stop, not a crash", async () => {
    const t = await setup(async (part, dir) => write(dir, { [`o/${part}`]: part }));
    const real = t.worktrees;
    const worktrees = {
      create: real.create.bind(real),
      diff: real.diff.bind(real),
      markFailed: real.markFailed.bind(real),
      applyTo: async () => {
        throw new Error("hook failed");
      },
    };
    const { result } = await t.run(plan([{ id: "S1", ownedPaths: ["o"] }]), { deps: { worktrees } });
    expect(result.consensus.reached).toBe(false);
    expect(result.decision).toContain("Stopped: merging part S1 failed: hook failed");
    expect(result.dissent.some((d) => d.reason.includes("hook failed"))).toBe(true);
  });

  it("rejects the run before any part starts when the main checkout is dirty", async () => {
    const t = await setup(async () => undefined);
    await fs.writeFile(path.join(t.repo, "dirty.txt"), "x");
    await expect(t.run(plan([{ id: "S1", ownedPaths: ["o"] }]))).rejects.toThrow(/uncommitted changes/);
    expect(t.executors.started).toEqual([]);
  });
});

describe("divide: the split plan", () => {
  it("rejects a plan whose parts own overlapping paths, before any worktree or executor exists", async () => {
    const t = await setup(async () => undefined);
    const { result } = await t.run(
      plan([
        { id: "S1", ownedPaths: ["src"] },
        { id: "S2", ownedPaths: ["src/util/a.ts"] },
      ]),
    );
    expect(result.consensus).toEqual({ score: 0, reached: false });
    expect(result.decision).toBe("");
    expect(result.dissent[0]!.reason).toContain("own overlapping paths");
    expect(await t.worktrees.list(t.sessionId)).toEqual([]);
    expect(t.executors.started).toEqual([]);
    expect(t.events.filter((e) => e.type === "seat.status" && e.data.status === "editing")).toEqual([]);
  });

  it.each([
    ["empty", { subtasks: [] }, "the plan is empty"],
    ["not a list", { subtasks: "split it" }, "invalid divide-plan reply"],
    ["no subtasks field", { parts: [] }, "invalid divide-plan reply"],
    ["a part without paths", plan([{ id: "S1", ownedPaths: [] }]), "must own at least one path"],
    ["an unsafe path", plan([{ id: "S1", ownedPaths: ["../etc"] }]), "'..' is not allowed"],
    ["too many parts", plan([{ id: "A", ownedPaths: ["a"] }, { id: "B", ownedPaths: ["b"] }]), "at most 1 allowed"],
  ])("returns a rejected result, never throws, for a plan that is %s", async (_name, reply, message) => {
    const t = await setup(async () => undefined);
    const { result } = await t.run(reply, { options: { maxParts: 1 } });
    expect(result.consensus.reached).toBe(false);
    expect(result.dissent[0]!.reason).toContain(message);
    expect(t.executors.started).toEqual([]);
    expect(await t.worktrees.list(t.sessionId)).toEqual([]);
  });

  it("returns a rejected result when the planner fails", async () => {
    const t = await setup(async () => undefined);
    const { result } = await t.run(null, {
      runStep: async () => {
        throw new Error("planner crashed");
      },
    });
    expect(result.dissent[0]).toMatchObject({ seatId: seats[0]!.id });
    expect(result.dissent[0]!.reason).toContain("planner crashed");
  });
});

describe("divide: cancellation", () => {
  it("cancels running executors, gives every started part one terminal event and keeps the worktrees", async () => {
    const t = await setup(hang);
    const done = t.run(plan([{ id: "S1", ownedPaths: ["a1"] }, { id: "S2", ownedPaths: ["a2"] }, { id: "S3", ownedPaths: ["a3"], dependsOn: ["S1"] }]));
    const settled = done.then(() => "resolved", (error: unknown) => error);
    await until(() => t.executors.started.length === 2);
    t.abort.abort();

    const error = await settled;
    expect(error).toBeInstanceOf(NegotiationCancelledError);
    expect(t.executors.cancelled).toHaveLength(2);
    expect(t.executors.started.sort()).toEqual(["S1", "S2"]); // S3 never started
    const ends = t.events.filter((e) => e.type === "seat.done" && e.data.summary === "cancelled");
    expect(ends.map((e) => e.seatId).sort()).toEqual(["sol-1", "sol-2"]);
    expectOneTerminalPerStart(t.events);
    // Nothing merged, the main checkout is clean, unfinished work is kept and marked failed.
    const integration = (await t.integrationPath())!;
    expect(await git(integration, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await git(t.repo, "status", "--porcelain")).toBe("");
    const records = await t.worktrees.list(t.sessionId);
    expect(records.filter((w) => w.outcome === "failed").map((w) => w.seatId).sort()).toEqual(["divide-p-s1", "divide-p-s2"]);
    // The engine saved nothing for a cancelled run.
    expect(t.events.some((e) => e.type === "negotiation.consensus")).toBe(false);
  });

  it("does not wait forever for an executor that ignores cancel", async () => {
    const t = await setup(hang, { ignoreCancel: true });
    const settled = t.run(plan([{ id: "S1", ownedPaths: ["a1"] }])).then(() => "resolved", (error: unknown) => error);
    await until(() => t.executors.started.length === 1);
    t.abort.abort();
    expect(await settled).toBeInstanceOf(NegotiationCancelledError);
    expect(t.executors.cancelled).toHaveLength(1);
    expectOneTerminalPerStart(t.events);
  });

  it("stops during the planner ask without creating anything", async () => {
    const t = await setup(hang);
    let asked = false;
    const settled = t
      .run(null, {
        runStep: ({ signal }) =>
          new Promise((_resolve, reject) => {
            asked = true;
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      })
      .then(() => "resolved", (error: unknown) => error);
    await until(() => asked);
    t.abort.abort();
    expect(await settled).toBeInstanceOf(NegotiationCancelledError);
    expect(await t.worktrees.list(t.sessionId)).toEqual([]);
    expect(t.executors.started).toEqual([]);
    expectOneTerminalPerStart(t.events);
  });

  it("does not start work when the session is already cancelled", async () => {
    const t = await setup(hang);
    t.abort.abort();
    await expect(t.run(plan([{ id: "S1", ownedPaths: ["a1"] }]))).rejects.toBeInstanceOf(NegotiationCancelledError);
    expect(t.executors.started).toEqual([]);
  });
});

describe("divide: validate, schema and helpers", () => {
  const strategy = createDivideStrategy({ worktrees: {} as never, createExecutor: () => ({}) as never });

  it("needs an edit seat and known options", () => {
    expect(strategy.validate(seats, {})).toBeUndefined();
    expect(strategy.validate([seats[0]!], {})).toContain("edit permissions");
    expect(strategy.validate(seats, { planner: "ghost" })).toContain("not in the team");
    expect(strategy.validate(seats, { integrator: "ghost" })).toContain("not in the team");
    expect(strategy.validate(seats, { maxParts: 0 })).toContain("invalid divide options");
    expect(strategy.validate(seats, { speed: "fast" })).toContain("invalid divide options");
  });

  it("run refuses an invalid team", async () => {
    const roles = [seats[0]!];
    await expect(strategy.run({ seats: roles, options: {} } as never)).rejects.toThrow(/edit permissions/);
  });

  it("planWaves orders by dependency and reports cycles", () => {
    expect(planWaves([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: [] }])).toEqual({
      waves: [["a", "c"], ["b"]],
      cyclic: [],
    });
    expect(planWaves([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: [] }])).toEqual({
      waves: [["c"]],
      cyclic: ["a", "b"],
    });
  });

  it("pathsOverlap and isOwned work on whole segments, not string prefixes", () => {
    expect(pathsOverlap("src", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("SRC/A.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src", "src2/a.ts")).toBe(false);
    expect(pathsOverlap("src/a", "src/ab")).toBe(false);
    expect(isOwned("src/a.ts", ["src"])).toBe(true);
    expect(isOwned("src2/a.ts", ["src"])).toBe(false);
    expect(isOwned("SRC/a.ts", ["src"])).toBe(false);
  });

  const reasons = (subtasks: unknown) => {
    const parsed = SplitPlanSchema.safeParse({ subtasks });
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  };
  const part = (id: string, ownedPaths: string[], dependsOn: string[] = []) => ({ id, description: "d", ownedPaths, dependsOn });

  it("SplitPlanSchema normalizes paths and rejects every unsafe or inconsistent plan", () => {
    const ok = SplitPlanSchema.parse({ subtasks: [part("S1", ["./src//a.ts/", " lib "])] });
    expect(ok.subtasks[0]!.ownedPaths).toEqual(["src/a.ts", "lib"]);
    for (const bad of ["", ".", "/abs", "C:/x", "a/../b", "src/*.ts", "a\\b", ".git/config", ".assentor/x", "a\0b"]) {
      expect(reasons([part("S1", [bad])]), bad).not.toEqual([]);
    }
    expect(reasons([part("S1", ["a"]), part("s1", ["b"])])).toEqual(['duplicate id "s1"']);
    expect(reasons([part("S1", ["a"], ["S9"])])).toEqual(['"S1" depends on unknown part "S9"']);
    expect(reasons([part("S1", ["a"], ["S1"])])).toEqual(['"S1" depends on itself']);
    expect(reasons([part("S1", ["a"], ["S2"]), part("S2", ["b"], ["S1"])])).toEqual(["dependency cycle among S1, S2"]);
    expect(reasons([part("S1", ["a"]), part("S2", ["a/b"])])[0]).toContain('"S2" and "S1" own overlapping paths');
    expect(reasons([part("bad id", ["a"])])).not.toEqual([]);
    expect(reasons(Array.from({ length: 17 }, (_, i) => part(`P${i}`, [`d${i}`])))).not.toEqual([]);
  });
});

describe("divide-plan prompt", () => {
  it("is a built-in prompt that asks for the split-plan shape", () => {
    const library = PromptLibrary.loadBuiltinSync();
    expect(library.errors).toEqual([]);
    const prompt = library.get("divide-plan")!;
    expect(prompt.variables.sort()).toEqual(["goal", "maxParts"]);
    expect(prompt.permissions).toBe("read-only");
    const json = /```json\n([\s\S]*?)\n```/.exec(prompt.body)![1]!;
    expect(SplitPlanSchema.safeParse(JSON.parse(json)).success).toBe(true);
  });
});
