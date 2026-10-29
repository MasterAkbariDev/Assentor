import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "../../src/core/ids.js";
import { expandSeatSpecs } from "../../src/core/seats.js";
import { isRetryableExecutorResult } from "../../src/core/retry.js";
import { createEmptyContract } from "../../src/core/task-contract.js";
import type { SeatStepRunner } from "../../src/negotiation/engine.js";
import {
  SplitPlanSchema,
  buildSplitPlanSchema,
  createDivideExecutor,
  isOwned,
  parseDivideOptions,
  pathsOverlap,
  planWaves,
} from "../../src/negotiation/strategies/divide.js";
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
  await fs.mkdir(path.join(dir, "other"));
  await fs.writeFile(path.join(dir, "other/secret.ts"), "l1\nl2\nl3\nl4\nl5\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const seats = expandSeatSpecs([
  { provider: "claude-code", model: "opus", role: "planner" },
  { provider: "codex", model: "sol", count: 2, permissions: "edit" },
]);
const workerSeats = seats.filter((s) => s.permissions === "edit");

type Plan = Array<{ id: string; description?: string; ownedPaths: string[]; dependsOn?: string[] }>;
const plan = (subtasks: Plan) => ({
  subtasks: subtasks.map((s) => ({ description: `do ${s.id}`, dependsOn: [], ...s })),
});

type PartScript = (part: string, dir: string, task: ExecutorTask) => Promise<ExecutorResult | void> | ExecutorResult | void;

/** Executors whose behaviour per part is scripted; `cancel(taskId)` ends a pending run as cancelled. */
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
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const hang: PartScript = () => new Promise<never>(() => undefined);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

type ManagerOverride = (real: WorktreeManager, repo: string) => WorktreeManager;

async function setup(script: PartScript, options: { ignoreCancel?: boolean; manager?: ManagerOverride } = {}) {
  const repo = await makeRepo();
  const real = new WorktreeManager({ repoPath: repo });
  const manager = options.manager ? options.manager(real, repo) : real;
  const fake = fakeExecutors(script, options);
  const sessionId = createId();
  const events: EngineEventDraft[] = [];
  const abort = new AbortController();
  const scheduler = new SeatScheduler({ sessionId: "s", backoffBaseMs: 1, abortGraceMs: 30 });
  const task = (goal = "Build the feature"): ExecutorTask => ({
    taskId: "task-1",
    projectPath: repo,
    contract: createEmptyContract(goal),
    prompt: goal,
  });
  const make = (
    planReply: unknown | (() => Promise<unknown>),
    opts: { options?: Record<string, unknown>; target?: "main" | { sessionId: string; seatId: string }; runStep?: SeatStepRunner } = {},
  ) => {
    const runStep: SeatStepRunner =
      opts.runStep ??
      (async ({ step }) => {
        if (step !== "divide-plan") throw new Error(`unexpected step ${step}`);
        return typeof planReply === "function" ? (planReply as () => Promise<unknown>)() : planReply;
      });
    return createDivideExecutor({
      manager,
      sessionId,
      scheduler,
      runStep,
      workers: workerSeats.map((seat) => ({ seat, executor: fake.create() })),
      team: seats,
      options: opts.options ?? {},
      ...(opts.target ? { target: opts.target } : {}),
      emit: (e) => events.push(e),
    });
  };
  const run = (planReply: unknown | (() => Promise<unknown>), opts: Parameters<typeof make>[1] = {}) =>
    make(planReply, opts).run(task());
  const list = () => real.list(sessionId);
  const integration = async () => (await list()).find((w) => w.seatId.endsWith("-int"));
  return { repo, real, fake, sessionId, events, abort, scheduler, make, run, task, list, integration };
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

const noWaitingSeat = (events: EngineEventDraft[]) =>
  expect(events.filter((e) => e.type === "seat.status" && e.data.status === "waiting")).toEqual([]);

describe("divide executor: success path", () => {
  it("runs parts in waves, each in its own worktree, merges them in order and applies the result to main", async () => {
    const seen: Record<string, string[]> = {};
    const t = await setup(async (part, dir) => {
      seen[part] = (await fs.readdir(dir)).sort();
      if (part === "S1") await write(dir, { "src/one.ts": "one\n" });
      if (part === "S2") await write(dir, { "src/two.ts": "two\n" });
      if (part === "S3") await write(dir, { "docs/three.md": "three\n" });
    });
    const result = await t.run(
      plan([
        { id: "S1", ownedPaths: ["src/one.ts"] },
        { id: "S2", ownedPaths: ["./src/two.ts"] },
        { id: "S3", ownedPaths: ["docs"], dependsOn: ["S1", "S2"] },
      ]),
    );

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("3 parts in 2 waves (S1 S2 | S3)");
    // S3 started from the integration branch, so it saw S1's and S2's work.
    expect(seen.S3).toContain("src");
    expect(seen.S1).not.toContain("docs");
    // The target got the whole result as one squash commit.
    expect(await git(t.repo, "status", "--porcelain")).toBe("");
    for (const [file, text] of [["src/one.ts", "one"], ["src/two.ts", "two"], ["docs/three.md", "three"]] as const) {
      expect(await git(t.repo, "show", `HEAD:${file}`)).toBe(text);
    }
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("2");
    // Merged in plan order inside the integration worktree.
    const integration = (await t.integration())!;
    expect((await git(integration.path, "log", "--format=%s", "--first-parent")).split("\n").slice(0, 3)).toEqual([
      "divide: S3",
      "divide: S2",
      "divide: S1",
    ]);
    expect(t.fake.maxActive()).toBeLessThanOrEqual(2);
    expectOneTerminalPerStart(t.events);
    noWaitingSeat(t.events);
    expect(t.events.filter((e) => e.type === "negotiation.proposal")).toHaveLength(3);
  });

  it("applies to a task worktree seat instead of main when asked", async () => {
    const t = await setup(async (_part, dir) => write(dir, { "x/one.ts": "one\n" }));
    const taskSeat = { sessionId: t.sessionId, seatId: "task" };
    await t.real.create(taskSeat);
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["x"] }]), { target: taskSeat });
    expect(result.status).toBe("completed");
    const taskPath = (await t.list()).find((w) => w.seatId === "task")!.path;
    expect(await git(taskPath, "show", "HEAD:x/one.ts")).toBe("one");
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1"); // main untouched
  });

  it("can run again (resume or continue) without colliding with the first round's worktrees", async () => {
    let n = 0;
    const t = await setup(async (_part, dir) => {
      n += 1;
      await write(dir, { [`r/f${n}.txt`]: String(n) });
    });
    const executor = t.make((() => {
      let call = 0;
      return () => Promise.resolve(plan([{ id: "S1", ownedPaths: [`r/f${(call += 1)}.txt`] }]));
    })());
    expect((await executor.run(t.task())).status).toBe("completed");
    const second = await executor.continue({ ...t.task(), messages: [], nextPhaseDirective: "also do more" });
    expect(second.status).toBe("completed");
    expect(await git(t.repo, "show", "HEAD:r/f1.txt")).toBe("1");
    expect(await git(t.repo, "show", "HEAD:r/f2.txt")).toBe("2");
    expect((await t.list()).filter((w) => w.seatId.endsWith("-int"))).toHaveLength(2);
  });

  it("runs at most one part per edit seat at a time, and every part through the scheduler", async () => {
    let activeMax = () => 0;
    const t = await setup(async (part, dir) => {
      // Hold each run until two overlap, so a slow `git worktree add` cannot hide the overlap.
      for (let i = 0; i < 300 && activeMax() < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
      await write(dir, { [`f/${part}.txt`]: part });
    });
    activeMax = t.fake.maxActive;
    const spy = vi.spyOn(t.scheduler, "run");
    const result = await t.run(plan(["A1", "A2", "A3", "A4", "A5"].map((id) => ({ id, ownedPaths: [`f/${id}.txt`] }))));
    expect(result.status).toBe("completed");
    expect(t.fake.maxActive()).toBe(2);
    expect(spy).toHaveBeenCalledTimes(6); // the plan ask and five parts
  });
});

describe("divide executor: failure paths", () => {
  it("never applies a failed part or anything else: main is untouched, dependents are not run, worktrees are kept", async () => {
    const t = await setup(async (part, dir) => {
      if (part === "S2") return { status: "failed", summary: "", error: "compile error" };
      await write(dir, { [`out/${part}.txt`]: part });
    });
    const result = await t.run(
      plan([
        { id: "S1", ownedPaths: ["out/S1.txt"] },
        { id: "S2", ownedPaths: ["out/S2.txt"] },
        { id: "S3", ownedPaths: ["out/S3.txt"], dependsOn: ["S1", "S2"] },
      ]),
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("part S2 did not complete; nothing was applied to the target");
    expect(result.summary).toContain("S3: not run");
    expect(result.error).toContain("S2: executor failed: compile error");
    expect(t.fake.started.sort()).toEqual(["S1", "S2"]);
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await exists(path.join(t.repo, "out"))).toBe(false);
    const records = await t.list();
    expect(records.find((w) => w.seatId.endsWith("-p-s2"))).toMatchObject({ outcome: "failed" });
    expect(records.find((w) => w.seatId.endsWith("-int"))).toMatchObject({ outcome: "failed" }); // kept
    expect(t.events.filter((e) => e.type === "seat.error")).toHaveLength(1);
    expectOneTerminalPerStart(t.events);
  });

  it("fails a part that changes files outside its ownedPaths", async () => {
    const t = await setup(async (_part, dir) => write(dir, { "mine/x.txt": "x", "theirs/y.txt": "y" }));
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["mine"] }]));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("changed files outside its ownedPaths: theirs/y.txt");
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("fails a part that renames a file out of a path it does not own (R1)", async () => {
    const t = await setup(async (_part, dir) => {
      await fs.mkdir(path.join(dir, "owned"));
      await git(dir, "mv", "other/secret.ts", "owned/secret.ts");
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["owned"] }]));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("other/secret.ts");
    expect(await exists(path.join(t.repo, "other/secret.ts"))).toBe(true);
    expect((await t.integration())!.path).toBeTruthy();
    expect(await exists(path.join((await t.integration())!.path, "other/secret.ts"))).toBe(true);
  });

  it("refuses a write that lands after the part's own ownership check (R2)", async () => {
    const dirsByPart: Record<string, string> = {};
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup(async (part, dir) => {
      dirsByPart[part] = dir;
      if (part === "S1") await write(dir, { "a1.ts": "a\n" });
      if (part === "S2") {
        // Wait until S1 has been checked and reported done, then write into S1's worktree.
        await until(() => t.events.some((e) => e.type === "seat.done" && e.data.summary === "S1"));
        await fs.writeFile(path.join(dirsByPart.S1!, "other/secret.ts"), "PWNED\n");
        await write(dir, { "b1.ts": "b\n" });
      }
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["a1.ts"] }, { id: "S2", ownedPaths: ["b1.ts"] }]));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("merge refused");
    expect(result.error).toContain("other/secret.ts");
    expect(await git(t.repo, "show", "HEAD:other/secret.ts")).toBe("l1\nl2\nl3\nl4\nl5");
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await exists(path.join((await t.integration())!.path, "a1.ts"))).toBe(false);
    expect((await t.list()).find((w) => w.seatId.endsWith("-p-s1"))).toMatchObject({ outcome: "failed" });
  });

  it("fails a part that adds a symlink leaving the worktree, and accepts one that stays inside", async () => {
    const t = await setup(async (part, dir) => {
      await fs.mkdir(path.join(dir, `own-${part}`));
      if (part === "S1") await fs.symlink("../../../../../../../etc/hosts", path.join(dir, "own-S1/link"));
      else {
        await fs.writeFile(path.join(dir, "own-S2/real.txt"), "r\n");
        await fs.symlink("real.txt", path.join(dir, "own-S2/link"));
      }
    });
    const bad = await t.run(plan([{ id: "S1", ownedPaths: ["own-S1"] }]));
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("symlinks that leave the worktree");
    expect(bad.error).toContain("own-S1/link");
    const good = await t.run(plan([{ id: "S2", ownedPaths: ["own-S2"] }]));
    expect(good.status).toBe("completed");
  });

  it("never merges half-finished work from a part whose seat was cancelled on its own (scheduler.cancelSeat)", async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup(async (part, dir) => {
      if (part === "S1") {
        await write(dir, { "a1.ts": "HALF\n" });
        setTimeout(() => t.scheduler.cancelSeat("sol-1"), 100);
        await new Promise((r) => setTimeout(r, 5_000));
      }
      if (part === "S2") await write(dir, { "b1.ts": "b\n" });
    });
    // sol-1 takes S1 (the first waiting part); sol-2 takes S2.
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["a1.ts"] }, { id: "S2", ownedPaths: ["b1.ts"] }]));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("did not complete");
    expect(result.error).toContain("S1: cancelled");
    expect(await exists(path.join(t.repo, "a1.ts"))).toBe(false);
    expect(await exists(path.join(t.repo, "b1.ts"))).toBe(false);
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1");
    expectOneTerminalPerStart(t.events);
  });

  it("fails, not cancelled, when the session budget runs out during a part", async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup(async (_part, dir) => {
      await write(dir, { "a1.ts": "HALF\n" });
      setTimeout(() => (t.scheduler as unknown as { stopAll(r: string, m: string): void }).stopAll("budget", "token budget used up"), 100);
      await new Promise((r) => setTimeout(r, 5_000));
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["a1.ts"] }]));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("session budget ran out (token budget used up)");
    expect(await exists(path.join(t.repo, "a1.ts"))).toBe(false);
  });

  it("refuses a symlink written into a part's worktree after its own check (P6), before anything reaches main", async () => {
    const dirsByPart: Record<string, string> = {};
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup(async (part, dir) => {
      dirsByPart[part] = dir;
      if (part === "S1") await write(dir, { "owned/x.ts": "x\n" });
      if (part === "S2") {
        await until(() => t.events.some((e) => e.type === "seat.done" && e.data.summary === "S1"));
        await fs.symlink("/etc/hosts", path.join(dirsByPart.S1!, "owned/link"));
        await write(dir, { "b1.ts": "b\n" });
      }
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["owned"] }, { id: "S2", ownedPaths: ["b1.ts"] }]));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("owned/link -> /etc/hosts");
    expect(await exists(path.join(t.repo, "owned"))).toBe(false);
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it.each(["../.git/hooks", "../.assentor", "../.GIT/config"])("fails a part whose symlink points into git or Assentor state (%s)", async (target) => {
    const t = await setup(async (_part, dir) => {
      await fs.mkdir(path.join(dir, "owned"));
      await fs.symlink(target, path.join(dir, "owned/h"));
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["owned"] }]));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("owned/h");
    expect(await exists(path.join(t.repo, "owned"))).toBe(false);
  });

  it("treats an executor that needs input, throws or times out as a failed part", async () => {
    const t = await setup(async (part) => {
      if (part === "S1") return { status: "needs_input", summary: "which db?" };
      if (part === "S2") throw new Error("boom");
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["a1"] }, { id: "S2", ownedPaths: ["a2"] }]));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/S1: executor needs_input: which db\?/);
    expect(result.error).toMatch(/S2: executor error|S2: .*boom/);
  });

  it("fails a part that exceeds partTimeoutMs, through the scheduler's deadline", async () => {
    const t = await setup(hang);
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["a1"] }]), { options: { partTimeoutMs: 100 } });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("part deadline of 100 ms exceeded");
    expect(isRetryableExecutorResult(result)).toBe(false); // the Supervisor must not rerun the whole round
    expect(t.fake.cancelled).toHaveLength(1); // the deadline cancelled the executor
    expectOneTerminalPerStart(t.events);
  });

  it("stops on a merge conflict inside the integration worktree: failed (the Supervisor stops), nothing reaches main, no seat left waiting", async () => {
    const t = await setup(
      async (part, dir) => {
        if (part === "S1") await write(dir, { "s1.txt": "s1\n" });
        if (part === "S2") await write(dir, { "a.txt": "mine\n" });
        if (part === "S3") await write(dir, { "s3.txt": "s3\n" });
      },
      {
        // Someone edits a.txt on the integration branch between the part finishing and the merge.
        manager: (real) => {
          const wrapped = Object.create(real) as WorktreeManager;
          wrapped.applyTo = async (...args: Parameters<WorktreeManager["applyTo"]>) => {
            const target = args[0];
            if (typeof target !== "string" && args[1].seatId.endsWith("-p-s2")) {
              const dir = (await real.list(target.sessionId)).find((w) => w.seatId === target.seatId)!.path;
              await fs.writeFile(path.join(dir, "a.txt"), "theirs\n");
              await git(dir, "commit", "-qam", "outside edit");
            }
            return real.applyTo(...args);
          };
          return wrapped;
        },
      },
    );
    const result = await t.run(
      plan([
        { id: "S1", ownedPaths: ["s1.txt"] },
        { id: "S2", ownedPaths: ["a.txt"] },
        { id: "S3", ownedPaths: ["s3.txt"], dependsOn: ["S2"] },
      ]),
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Part S2 conflicts with work already merged (a.txt)");
    expect(result.error).toContain("Resolve it by hand");
    expect(result.summary).toContain("S1: merged");
    expect(result.summary).toContain("S3: not run");
    expect(t.fake.started.sort()).toEqual(["S1", "S2"]);
    const integration = (await t.integration())!;
    expect(await git(integration.path, "status", "--porcelain")).toBe("");
    expect(await git(integration.path, "rev-parse", "-q", "--verify", "MERGE_HEAD").catch(() => "none")).toBe("none");
    expect(await fs.readFile(path.join(integration.path, "a.txt"), "utf8")).toBe("theirs\n");
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1"); // the partial integration never reached main
    expect(await exists(path.join(t.repo, "s1.txt"))).toBe(false);
    expect((await t.list()).map((w) => w.seatId)).toEqual(expect.arrayContaining([expect.stringMatching(/-p-s2$/)]));
    expect(t.events.find((e) => e.type === "session.warning")).toMatchObject({
      data: { kind: "divide.conflict", part: "S2", files: ["a.txt"] },
    });
    noWaitingSeat(t.events);
    expectOneTerminalPerStart(t.events);
  });

  it("a conflict at the target leaves the target as it was and fails with instructions", async () => {
    const t = await setup(async (_part, dir) => write(dir, { "a.txt": "mine\n" }), {
      manager: (real, repo) => {
        const wrapped = Object.create(real) as WorktreeManager;
        wrapped.applyTo = async (...args: Parameters<WorktreeManager["applyTo"]>) => {
          if (args[0] === "main") {
            await fs.writeFile(path.join(repo, "a.txt"), "main moved\n");
            await git(repo, "commit", "-qam", "main moved");
          }
          return real.applyTo(...args);
        };
        return wrapped;
      },
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["a.txt"] }]));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("conflicts with the target (a.txt); the target is unchanged");
    expect(t.events.find((e) => e.type === "session.warning")).toMatchObject({ data: { kind: "divide.conflict", files: ["a.txt"] } });
    expect(await git(t.repo, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(t.repo, "a.txt"), "utf8")).toBe("main moved\n");
    noWaitingSeat(t.events);
  });

  it("reports an applyTo failure as failed, not as success", async () => {
    const t = await setup(async (part, dir) => write(dir, { [`o/${part}`]: part }), {
      manager: (real) => {
        const wrapped = Object.create(real) as WorktreeManager;
        wrapped.applyTo = async () => {
          throw new Error("hook failed");
        };
        return wrapped;
      },
    });
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["o"] }]));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("hook failed");
  });

  it("fails before any part starts when the main checkout is dirty", async () => {
    const t = await setup(async () => undefined);
    await fs.writeFile(path.join(t.repo, "dirty.txt"), "x");
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["o"] }]));
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/integration worktree.*uncommitted changes/);
    expect(t.fake.started).toEqual([]);
  });
});

describe("divide executor: the split plan", () => {
  it("rejects a plan whose parts own overlapping paths, before any worktree or executor exists", async () => {
    const t = await setup(async () => undefined);
    const result = await t.run(plan([{ id: "S1", ownedPaths: ["src"] }, { id: "S2", ownedPaths: ["src/util/a.ts"] }]));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("own overlapping paths");
    expect(await t.list()).toEqual([]);
    expect(t.fake.started).toEqual([]);
    expect(t.events.filter((e) => e.type === "seat.status" && e.data.status === "editing")).toEqual([]);
  });

  it.each([
    ["empty", { subtasks: [] }, "the plan is empty"],
    ["not a list", { subtasks: "split it" }, "invalid divide-plan reply"],
    ["no subtasks field", { parts: [] }, "invalid divide-plan reply"],
    ["a part without paths", plan([{ id: "S1", ownedPaths: [] }]), "must own at least one path"],
    ["an unsafe path", plan([{ id: "S1", ownedPaths: ["../etc"] }]), "'..' is not allowed"],
    ["a root .gitignore", plan([{ id: "S1", ownedPaths: [".gitignore"] }]), "allowRootGitFiles"],
    ["too many parts", plan([{ id: "A", ownedPaths: ["a"] }, { id: "B", ownedPaths: ["b"] }]), "at most 1 allowed"],
  ])("fails, never throws, for a plan that is %s", async (_name, reply, message) => {
    const t = await setup(async () => undefined);
    const result = await t.run(reply, { options: { maxParts: 1 } });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain(message);
    expect(t.fake.started).toEqual([]);
    expect(await t.list()).toEqual([]);
  });

  it("accepts a root .gitignore only when the allowRootGitFiles option is set", async () => {
    const t = await setup(async (_part, dir) => write(dir, { ".gitignore": ".assentor/\nbuild/\n" }));
    const result = await t.run(plan([{ id: "S1", ownedPaths: [".gitignore"] }]), { options: { allowRootGitFiles: true } });
    expect(result.status).toBe("completed");
  });

  it("fails when the planner fails", async () => {
    const t = await setup(async () => undefined);
    const result = await t.run(null, {
      runStep: async () => {
        throw new Error("planner crashed");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("planner crashed");
  });
});

describe("divide executor: cancellation", () => {
  it("cancel(taskId) cancels running executors, gives every started part one terminal event and keeps the worktrees", async () => {
    const t = await setup(hang);
    const executor = t.make(plan([{ id: "S1", ownedPaths: ["a1"] }, { id: "S2", ownedPaths: ["a2"] }, { id: "S3", ownedPaths: ["a3"], dependsOn: ["S1"] }]));
    const running = executor.run(t.task());
    await until(() => t.fake.started.length === 2);
    await executor.cancel("task-1");

    expect((await running).status).toBe("cancelled");
    expect(t.fake.cancelled).toHaveLength(2);
    expect(t.fake.started.sort()).toEqual(["S1", "S2"]); // S3 never started
    const ends = t.events.filter((e) => e.type === "seat.done" && e.data.summary === "cancelled");
    expect(ends.map((e) => e.seatId).sort()).toEqual(["sol-1", "sol-2"]);
    expectOneTerminalPerStart(t.events);
    // Nothing merged or applied, main is clean, unfinished work is kept and marked failed.
    expect(await git(t.repo, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await git(t.repo, "status", "--porcelain")).toBe("");
    const records = await t.list();
    expect(records.filter((w) => w.outcome === "failed").map((w) => w.seatId.replace(/^r\w+-/, "")).sort()).toEqual(["int", "p-s1", "p-s2"]);
  });

  it("does not wait forever for an executor that ignores cancel (the scheduler's abort grace)", async () => {
    const t = await setup(hang, { ignoreCancel: true });
    const executor = t.make(plan([{ id: "S1", ownedPaths: ["a1"] }]));
    const running = executor.run(t.task());
    await until(() => t.fake.started.length === 1);
    await executor.cancel("task-1");
    expect((await running).status).toBe("cancelled");
    expect(t.fake.cancelled).toHaveLength(1);
    expectOneTerminalPerStart(t.events);
  });

  it("stops during the planner ask without creating anything", async () => {
    const t = await setup(hang);
    let asked = false;
    const executor = t.make(null, {
      runStep: ({ signal }) =>
        new Promise((_resolve, reject) => {
          asked = true;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    const running = executor.run(t.task());
    await until(() => asked);
    await executor.cancel("task-1");
    expect((await running).status).toBe("cancelled");
    expect(await t.list()).toEqual([]);
    expect(t.fake.started).toEqual([]);
    expectOneTerminalPerStart(t.events);
  });
});

describe("divide: options, schema and helpers", () => {
  it("parseDivideOptions validates options, the planner seat and the worker count", () => {
    expect(parseDivideOptions({})).toMatchObject({ maxParts: 8, apply: "squash", allowRootGitFiles: false });
    expect(parseDivideOptions({ planner: "opus-1", partTimeoutMs: 5 }, seats)).toMatchObject({ planner: "opus-1", partTimeoutMs: 5 });
    expect(parseDivideOptions({ planner: "ghost" }, seats)).toContain("not in the team");
    expect(parseDivideOptions({ maxParts: 0 })).toContain("invalid options");
    expect(parseDivideOptions({ speed: "fast" })).toContain("invalid options");
    expect(parseDivideOptions({ apply: "rebase" })).toContain("invalid options");
    expect(parseDivideOptions({}, seats, 0)).toContain("at least one editing seat");
  });

  it("createDivideExecutor refuses invalid options up front", () => {
    expect(() =>
      createDivideExecutor({ manager: {} as never, sessionId: createId(), scheduler: {} as never, runStep: {} as never, workers: [], options: {} }),
    ).toThrow(/at least one editing seat/);
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

  const reasons = (subtasks: unknown, schema = SplitPlanSchema) => {
    const parsed = schema.safeParse({ subtasks });
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

  it("reserves root .gitattributes, .gitmodules and .gitignore unless allowed (nested ones are fine)", () => {
    for (const name of [".gitattributes", ".gitmodules", ".gitignore", "./.GitIgnore"]) {
      expect(reasons([part("S1", [name])])[0], name).toContain("allowRootGitFiles");
    }
    expect(reasons([part("S1", ["sub/.gitignore"])])).toEqual([]);
    expect(reasons([part("S1", [".gitignore"])], buildSplitPlanSchema({ allowRootGitFiles: true }))).toEqual([]);
  });
});

describe("divide-plan prompt", () => {
  it("is a built-in prompt that asks for the split-plan shape", () => {
    const library = PromptLibrary.loadBuiltinSync();
    expect(library.errors).toEqual([]);
    const prompt = library.get("divide-plan")!;
    expect([...prompt.variables].sort()).toEqual(["goal", "maxParts"]);
    expect(prompt.permissions).toBe("read-only");
    expect(prompt.body).toContain("Never put triple backticks inside a string; show code inline or indented.");
    expect(prompt.body).toContain("escape line breaks");
    expect(prompt.body).not.toContain("Proposals are anonymous");
    const json = /```json\n([\s\S]*?)\n```/.exec(prompt.body)![1]!;
    expect(SplitPlanSchema.safeParse(JSON.parse(json)).success).toBe(true);
  });
});
