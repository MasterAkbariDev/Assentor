import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBestOfNExecutor,
  discardBestOfNLosers,
  expandSeatSpecs,
  parseBestOfNOptions,
  shuffleWithSeed,
  WorktreeManager,
  type BestOfNDeps,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type ExecutorTask,
  type SeatStepRunner,
} from "../../packages/engine/src/index.js";
import { createEmptyContract } from "../../packages/engine/src/core/task-contract.js";
import { SeatScheduler } from "../../packages/engine/src/seats/index.js";

const exec = promisify(execFile);
// Real git in temp repos, like worktree-manager.test.ts.
vi.setConfig({ testTimeout: 60_000 });
const SESSION = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-bon-")));
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

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const candidateSeats = expandSeatSpecs(
  [
    { provider: "mock", model: "alpha", permissions: "edit" },
    { provider: "mock", model: "beta", permissions: "edit" },
    { provider: "mock", model: "gamma", permissions: "edit" },
  ],
  {},
);
const [alpha, beta, gamma] = candidateSeats as [(typeof candidateSeats)[0], (typeof candidateSeats)[0], (typeof candidateSeats)[0]];
const judges = expandSeatSpecs([{ provider: "mock", model: "judge", role: "judge", count: 2 }]);

const done = (summary = "done"): ExecutorResult => ({ status: "completed", summary });

/** An executor that runs `work` in the project path it is given (the candidate's worktree). */
function executor(work: (task: ExecutorTask) => Promise<ExecutorResult> | ExecutorResult) {
  const cancelled: string[] = [];
  const ex: Executor & { cancelled: string[]; projectPaths: string[] } = {
    name: "mock-executor",
    cancelled,
    projectPaths: [],
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
    async run(task) {
      ex.projectPaths.push(task.projectPath);
      return work(task);
    },
    async continue() {
      throw new Error("candidates never continue");
    },
    async cancel(taskId) {
      cancelled.push(taskId);
    },
  };
  return ex;
}

const writes = (file: string, text = "work\n") =>
  executor(async (task) => {
    await fs.writeFile(path.join(task.projectPath, file), text);
    return done(`wrote ${file}`);
  });

/** An executor that hangs until it is cancelled (like a CLI whose process gets killed). */
function hanging() {
  let release: (r: ExecutorResult) => void = () => undefined;
  const ex = executor(() => new Promise<ExecutorResult>((resolve) => (release = resolve)));
  const cancel = ex.cancel;
  ex.cancel = async (taskId) => {
    await cancel(taskId);
    release({ status: "cancelled", summary: "killed" });
  };
  return ex;
}

interface Setup {
  repo: string;
  manager: WorktreeManager;
  events: EngineEventDraft[];
  asks: Array<{ seatId: string; vars: Readonly<Record<string, unknown>> }>;
  build(
    executors: Executor[],
    extra?: Partial<BestOfNDeps>,
    rank?: (seatId: string, proposals: Array<{ label: string; text: string }>) => string[],
  ): Executor;
}

async function setup(): Promise<Setup> {
  const repo = await makeRepo();
  currentRepo = repo;
  const manager = new WorktreeManager({ repoPath: repo });
  const events: EngineEventDraft[] = [];
  const asks: Setup["asks"] = [];
  const seeds = [3, 5, 11, 13];
  return {
    repo,
    manager,
    events,
    asks,
    build(executors, extra = {}, rank = (_seat, proposals) => proposals.map((p) => p.label)) {
      const runStep: SeatStepRunner = async ({ seat, step, vars }) => {
        if (step !== "negotiate-rank") throw new Error(`unexpected step ${step}`);
        asks.push({ seatId: seat.id, vars });
        return { ranking: rank(seat.id, vars.proposals as Array<{ label: string; text: string }>) };
      };
      return createBestOfNExecutor({
        manager,
        sessionId: SESSION,
        scheduler: new SeatScheduler({ sessionId: SESSION, backoffBaseMs: 1 }),
        runStep,
        candidates: executors.map((executor, i) => ({ seat: candidateSeats[i]!, executor })),
        judges,
        roundSeed: () => seeds.shift() ?? 7,
        emit: (draft) => events.push(draft),
        ...extra,
      });
    },
  };
}

/** A ballot that ranks proposals mentioning these files first, in this order. */
const prefer =
  (...files: string[]) =>
  (_seat: string, proposals: Array<{ label: string; text: string }>) => {
    const score = (p: { text: string }) => {
      const i = files.findIndex((f) => p.text.includes(f));
      return i < 0 ? files.length : i;
    };
    return [...proposals].sort((x, y) => score(x) - score(y)).map((p) => p.label);
  };

let currentRepo = "";
const task = (): ExecutorTask => ({
  taskId: "task-1",
  projectPath: currentRepo,
  contract: createEmptyContract("Add a feature"),
  prompt: "Add a feature",
});

const terminal = (events: EngineEventDraft[], seatId: string) =>
  events.filter((e) => e.seatId === seatId && (e.type === "seat.done" || e.type === "seat.error"));

describe("best-of-n: happy path", () => {
  it("runs every candidate in its own worktree, applies only the vote winner and keeps the rest until the host discards them", async () => {
    const s = await setup();
    const a = writes("one.txt");
    const b = writes("two.txt");
    const c = writes("three.txt");
    // Both judges rank two.txt first, whatever label the shuffle gave it.
    const bon = s.build([a, b, c], {}, prefer("two.txt", "one.txt", "three.txt"));

    const result = await bon.run(task());

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Beta#1 won of 3");
    // Only the winner reached main (squashed into one commit), and the checkout is clean.
    expect(await fs.readFile(path.join(s.repo, "two.txt"), "utf8")).toBe("work\n");
    await expect(fs.access(path.join(s.repo, "one.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(s.repo, "three.txt"))).rejects.toThrow();
    expect(await git(s.repo, "rev-list", "--count", "HEAD")).toBe("2");
    expect(await git(s.repo, "status", "--porcelain")).toBe("");

    // Each candidate ran in a distinct worktree, never in the main checkout.
    const paths = [a, b, c].map((x) => x.projectPaths[0]!);
    expect(new Set(paths).size).toBe(3);
    paths.forEach((p) => expect(p).toContain(path.join(".assentor", "worktrees")));

    expect(result.summary).toMatch(/order seed [0-9a-f]{8}/);

    // Losers are kept (nothing is deleted behind the user's back); the winner landed.
    const left = await s.manager.list(SESSION);
    expect(left.map((w) => [w.seatId.split(".")[0], w.outcome ?? "kept"]).sort()).toEqual([
      [alpha.id, "kept"],
      [beta.id, "applied"],
      [gamma.id, "kept"],
    ]);
    left.forEach((w) => expect(w.seatId).toMatch(/\.bon-r1[0-9a-f]{8}$/));
    // The host discards kept losers at session end, through the manager.
    expect(await discardBestOfNLosers(s.manager, SESSION)).toHaveLength(2);
    expect((await s.manager.list(SESSION)).map((w) => w.seatId.split(".")[0])).toEqual([beta.id]);
    expect((await git(s.repo, "branch", "--list", "assentor/*")).split("\n")).toHaveLength(1);

    // Judges saw anonymized diffs with gate status; no seat id, model or worktree path.
    expect(s.asks.map((x) => x.seatId).sort()).toEqual(["judge-1", "judge-2"]);
    const seen = JSON.stringify(s.asks[0]!.vars);
    expect(seen).toContain("Proposal A");
    expect(seen).toContain("+work");
    expect(seen).not.toContain("Proposal D");
    expect(seen).toContain("Verification: not run");
    for (const secret of ["alpha", "beta", "gamma", "mock", ".assentor", s.repo]) {
      expect(seen).not.toContain(secret);
    }

    // Every candidate seat got exactly one terminal event.
    for (const seat of candidateSeats) {
      expect(terminal(s.events, seat.id)).toHaveLength(1);
    }
  });

  it("a later round (continue) starts from the winner's tip with new worktrees", async () => {
    const s = await setup();
    const bon = s.build([writes("r1-a.txt"), writes("r1-b.txt")]);
    expect((await bon.run(task())).status).toBe("completed");

    const second = s.build([writes("r2-a.txt"), writes("r2-b.txt")]);
    const result = await second.continue({
      taskId: "task-1",
      projectPath: s.repo,
      contract: createEmptyContract("Add a feature"),
      messages: [],
    });
    expect(result.status).toBe("completed");
    expect(await fs.readFile(path.join(s.repo, "r1-a.txt"), "utf8")).toBe("work\n");
    expect(await fs.readFile(path.join(s.repo, "r2-a.txt"), "utf8")).toBe("work\n");
    expect(await git(s.repo, "status", "--porcelain")).toBe("");
  });
});

describe("best-of-n: gates", () => {
  it("runs the gates in each worktree and only a gate-passing candidate can win", async () => {
    const s = await setup();
    const cwds: string[] = [];
    const bon = s.build(
      [writes("alpha.txt", "bad\n"), writes("beta.txt", "good\n")],
      {
        verification: {
          enabled: true,
          commands: { typecheck: "", test: "check", lint: "", build: "" },
          skipReviewOnFailure: { typecheck: true, build: true, test: true, lint: false },
        },
        runVerificationCommand: async (_command, cwd) => {
          cwds.push(cwd);
          return (await fs.readFile(path.join(cwd, "alpha.txt")).catch(() => undefined))
            ? { stdout: "", stderr: `failed in ${cwd}`, code: 1 }
            : { stdout: "ok", stderr: "", code: 0 };
        },
      },
    );

    const result = await bon.run(task());

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("only one eligible candidate");
    expect(new Set(cwds).size).toBe(2); // one gate run per worktree
    expect(cwds).not.toContain(s.repo);
    expect(await fs.readFile(path.join(s.repo, "beta.txt"), "utf8")).toBe("good\n");
    expect(s.asks).toEqual([]); // no vote needed
  });
});

describe("best-of-n: failures", () => {
  it("a failed and a timed-out candidate lose; the last one standing wins without a vote", async () => {
    const s = await setup();
    const slow = hanging();
    const bon = s.build(
      [executor(() => ({ status: "failed", summary: "no", error: "boom" })), slow, writes("gamma.txt")],
      { options: { candidateTimeoutMs: 100 } },
    );

    const result = await bon.run(task());

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("failed candidate");
    expect(result.summary).toContain("failed: boom");
    expect(result.summary).toContain("timeout");
    expect(slow.cancelled).toHaveLength(1); // the timed-out executor was told to stop
    expect(await fs.readFile(path.join(s.repo, "gamma.txt"), "utf8")).toBe("work\n");
    // keepLosers is the default: the failed candidates' worktrees stay, marked failed for `cleanup({ keepFailed })`.
    const left = await s.manager.list(SESSION);
    expect(left.map((w) => [w.seatId.split(".")[0], w.outcome]).sort()).toEqual([
      [alpha.id, "failed"],
      [beta.id, "failed"],
      [gamma.id, "applied"],
    ]);
    expect(s.asks).toEqual([]);
    expect(terminal(s.events, alpha.id)[0]?.type).toBe("seat.error");
    expect(terminal(s.events, beta.id)[0]?.type).toBe("seat.error");
    expect(terminal(s.events, gamma.id)[0]?.type).toBe("seat.done");
  });

  it("fails when every candidate fails, applies nothing and (keepLosers: false) leaves no worktrees", async () => {
    const s = await setup();
    const head = await git(s.repo, "rev-parse", "HEAD");
    const noop = executor(() => done("did nothing")); // completed but changed nothing
    const bon = s.build([executor(() => ({ status: "failed", summary: "no", error: "boom" })), noop], {
      options: { keepLosers: false },
    });

    const result = await bon.run(task());

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("all 2 candidates failed");
    expect(result.error).toContain("made no changes");
    expect(await git(s.repo, "rev-parse", "HEAD")).toBe(head);
    expect(await s.manager.list(SESSION)).toEqual([]);
    expect(terminal(s.events, alpha.id)).toHaveLength(1);
    expect(terminal(s.events, beta.id)).toHaveLength(1);
  });

  it("a tie goes to the earliest label, gate artifacts stay out of the diff and the path is redacted", async () => {
    const s = await setup();
    // Every candidate fails the gate, so all stay eligible and the judges see the results.
    // judge-1 prefers alpha.txt, judge-2 prefers beta.txt: equal points.
    const bon = s.build(
      [writes("alpha.txt"), writes("beta.txt")],
      {
        verification: {
          enabled: true,
          commands: { typecheck: "", test: "check", lint: "", build: "" },
          skipReviewOnFailure: { typecheck: true, build: true, test: true, lint: false },
        },
        runVerificationCommand: async (_c, cwd) => {
          await fs.writeFile(path.join(cwd, "cov.tmp"), "artifact\n"); // a gate artifact
          return { stdout: "", stderr: `boom at ${cwd} and ${path.relative(s.repo, cwd)}`, code: 2 };
        },
      },
      (judge, proposals) => prefer(judge === "judge-1" ? "alpha.txt" : "beta.txt")(judge, proposals),
    );

    const result = await bon.run(task());

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("tie-break");
    const seen = JSON.stringify(s.asks[0]!.vars);
    expect(seen).toContain("test: FAILED (exit 2)");
    expect(seen).toContain("<worktree>");
    expect(seen).not.toContain(".assentor");
    expect(seen).not.toContain("cov.tmp"); // the diff was taken before the gates ran
    expect(result.summary).toMatch(/warning: .*the gates created cov\.tmp/);
    const labelA = (s.asks[0]!.vars.proposals as Array<{ label: string; text: string }>)[0]!.text;
    const expected = labelA.includes("alpha.txt") ? "alpha.txt" : "beta.txt";
    const other = expected === "alpha.txt" ? "beta.txt" : "alpha.txt";
    expect(await fs.readFile(path.join(s.repo, expected), "utf8")).toBe("work\n");
    await expect(fs.access(path.join(s.repo, other))).rejects.toThrow();
  });

  it("when applyTo refuses, nothing lands and the winner's worktree is kept, marked failed", async () => {
    const s = await setup();
    const head = await git(s.repo, "rev-parse", "HEAD");
    // Dirtying the main checkout while the candidates run makes applyTo refuse.
    // (only after the other candidate's worktree exists, since create refuses a dirty main too)
    let otherStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (otherStarted = resolve));
    const dirties = executor(async (t) => {
      await fs.writeFile(path.join(t.projectPath, "alpha.txt"), "work\n");
      await started;
      await fs.writeFile(path.join(s.repo, "stray.txt"), "uncommitted\n");
      return done();
    });
    const other = executor(async (t) => {
      await fs.writeFile(path.join(t.projectPath, "beta.txt"), "work\n");
      otherStarted();
      return done();
    });
    const bon = s.build([dirties, other], {}, prefer("alpha.txt", "beta.txt"));

    const result = await bon.run(task());

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("refused");
    expect(result.summary).toContain("uncommitted changes");
    expect(await git(s.repo, "rev-parse", "HEAD")).toBe(head);
    await expect(fs.access(path.join(s.repo, "alpha.txt"))).rejects.toThrow();
    const left = await s.manager.list(SESSION);
    expect(left).toHaveLength(2); // the loser is kept too
    const winner = left.find((w) => w.seatId.startsWith(alpha.id));
    expect(winner).toMatchObject({ outcome: "failed" });
    // The host's session-end cleanup discards the plain loser but never the refused winner's only copy.
    expect(await discardBestOfNLosers(s.manager, SESSION)).toHaveLength(1);
    const afterCleanup = await s.manager.list(SESSION);
    expect(afterCleanup.map((w) => w.seatId)).toEqual([winner!.seatId]);
    await expect(fs.access(winner!.path)).resolves.toBeUndefined();
    await expect(fs.access(path.join(winner!.path, "alpha.txt"))).resolves.toBeUndefined();
  });
});

describe("best-of-n: cancel", () => {
  it("cancel mid-run stops every executor, discards the unfinished work (keepLosers: false) and ends every seat", async () => {
    const s = await setup();
    const execs = [hanging(), hanging()];
    const bon = s.build(execs, { options: { keepLosers: false } }); // mid-edit work may be discarded
    const running = bon.run(task());
    await vi.waitFor(() => expect(execs.every((x) => x.projectPaths.length === 1)).toBe(true), { timeout: 30_000 });

    await bon.cancel("task-1");
    const result = await running;

    expect(result.status).toBe("cancelled");
    execs.forEach((x) => expect(x.cancelled).toHaveLength(1));
    expect(await s.manager.list(SESSION)).toEqual([]);
    for (const seat of [alpha, beta]) {
      expect(terminal(s.events, seat.id)).toHaveLength(1);
      expect(terminal(s.events, seat.id)[0]).toMatchObject({ type: "seat.done", data: { ok: false } });
    }
    expect(s.asks).toEqual([]);
  });

  it("cancel while the judges are ranking stops the asks, keeps the finished candidates and ends every seat", async () => {
    const s = await setup();
    let ranking = 0;
    let aborted = 0;
    const bon = createBestOfNExecutor({
      manager: s.manager,
      sessionId: SESSION,
      scheduler: new SeatScheduler({ sessionId: SESSION, backoffBaseMs: 1 }),
      // Ranking never answers on its own; it ends only when its signal aborts.
      runStep: ({ signal }) =>
        new Promise((_resolve, reject) => {
          ranking += 1;
          signal.addEventListener("abort", () => {
            aborted += 1;
            reject(new Error("aborted"));
          });
        }),
      candidates: [writes("alpha.txt"), writes("beta.txt")].map((x, i) => ({ seat: candidateSeats[i]!, executor: x })),
      judges,
      options: { keepLosers: false },
      emit: (draft) => s.events.push(draft),
    });
    const running = bon.run(task());
    await vi.waitFor(() => expect(ranking).toBe(2), { timeout: 30_000 });

    await bon.cancel("task-1");
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(aborted).toBe(2);
    // Finished work that passed its gates is not force-discarded, even with keepLosers: false.
    const left = await s.manager.list(SESSION);
    expect(left).toHaveLength(2);
    left.forEach((w) => expect(w.outcome).toBe("failed"));
    expect(await Promise.all(left.map((w) => fs.access(w.path).then(() => true)))).toEqual([true, true]);
    // ...and the session-end helper leaves them alone unless asked to drop failed ones too.
    expect(await discardBestOfNLosers(s.manager, SESSION)).toEqual([]);
    expect(await s.manager.list(SESSION)).toHaveLength(2);
    expect(await discardBestOfNLosers(s.manager, SESSION, { keepFailed: false })).toHaveLength(2);
    expect(await s.manager.list(SESSION)).toEqual([]);
    for (const seat of [alpha, beta, ...judges]) {
      expect(terminal(s.events, seat.id)).toHaveLength(1);
    }
  });
});

describe("best-of-n: options", () => {
  it("validates stage options", () => {
    expect(parseBestOfNOptions({})).toEqual({ apply: "squash", keepLosers: true });
    expect(parseBestOfNOptions({ n: 2, apply: "merge", keepLosers: false, candidateTimeoutMs: 5 })).toEqual({
      n: 2,
      apply: "merge",
      keepLosers: false,
      candidateTimeoutMs: 5,
    });
    expect(parseBestOfNOptions({ n: 1 })).toContain("options.n");
    expect(parseBestOfNOptions({ n: 4 }, 3)).toContain("only 3 editing seats");
    expect(parseBestOfNOptions({}, 1)).toContain("at least two");
    expect(parseBestOfNOptions({ apply: "rebase" })).toContain("options.apply");
    // patch leaves main dirty, which would make every later round's manager.create fail.
    expect(parseBestOfNOptions({ apply: "patch" })).toContain("options.apply");
    expect(parseBestOfNOptions({ candidateTimeoutMs: 0 })).toContain("candidateTimeoutMs");
    expect(() => createBestOfNExecutor({ options: { n: 1 }, candidates: [] } as unknown as BestOfNDeps)).toThrow("options.n");
  });

  it("refuses duplicate candidate seat ids", () => {
    const dup = { seat: alpha, executor: writes("x.txt") };
    expect(() => createBestOfNExecutor({ candidates: [dup, dup] } as unknown as BestOfNDeps)).toThrow("must be unique");
  });

  it("orders candidates by a seed: same seed, same order, and some seed changes it", () => {
    const items = ["a", "b", "c", "d"];
    expect(shuffleWithSeed(items, 42)).toEqual(shuffleWithSeed(items, 42));
    expect([...shuffleWithSeed(items, 42)].sort()).toEqual(items);
    expect(Array.from({ length: 20 }, (_, i) => shuffleWithSeed(items, i).join("")).some((o) => o !== "abcd")).toBe(true);
  });

  it("fails clearly when the project path is not the repository top level", async () => {
    const s = await setup();
    const sub = path.join(s.repo, "packages", "app");
    await fs.mkdir(sub, { recursive: true });
    const a = writes("one.txt");
    const bon = s.build([a, writes("two.txt")]);

    const result = await bon.run({ ...task(), projectPath: sub });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not the repository top level");
    expect(a.projectPaths).toEqual([]);
    expect(await s.manager.list(SESSION)).toEqual([]);
  });
});
