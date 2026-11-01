import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandSeatSpecs,
  getMode,
  MockReviewer,
  parseAssentorConfig,
  prepareModeSession,
  WorktreeManager,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type ExecutorTask,
  type ModeControllerInput,
  type ModeControllerResult,
  type StageSpec,
} from "../../packages/engine/src/index.js";
import type { MockReviewerStep } from "../../packages/engine/src/providers/reviewers/mock/index.js";
import { estimateRun } from "../../packages/engine/src/estimate/cost.js";
import { createRaceController, diffSize, raceOrder, raceProblems, raceSeatCount, type RaceExtras } from "../../packages/engine/src/modes/race.js";
import { SeatScheduler } from "../../packages/engine/src/seats/index.js";

const exec = promisify(execFile);
const SESSION = "55555555-5555-4555-8555-555555555555";
const dirs: string[] = [];

const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-race-")));
  dirs.push(dir);
  await git(dir, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "assentor@test");
  await git(dir, "config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n");
  await fs.writeFile(path.join(dir, "README.md"), "base\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const config = (race: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  parseAssentorConfig({
    teams: {
      builders: { seats: [{ provider: "mock", model: "b", permissions: "edit" }] },
      judges: { seats: [{ provider: "mock", model: "j" }] },
    },
    modes: { race: { team: "builders", ...race } },
    verification: { commands: { test: "test-cmd" } },
    ...extra,
  });

const done = (summary = "done"): ExecutorResult => ({ status: "completed", summary });

/** The project's test gate: fails while impl.txt says "broken". */
const runCommand: NonNullable<RaceExtras["runCommand"]> = async (_command, cwd) => {
  const impl = await fs.readFile(path.join(cwd, "impl.txt"), "utf8").catch(() => "");
  return impl.includes("broken") ? { stdout: "", stderr: "1 test failed", code: 1 } : { stdout: "ok", stderr: "", code: 0 };
};

const writes = (text: string) => async (task: ExecutorTask) => {
  await fs.writeFile(path.join(task.projectPath, "impl.txt"), text);
  return done();
};

type Build = (task: ExecutorTask, signal: AbortSignal) => Promise<ExecutorResult>;

async function setup(opts: { builds: Build[]; cfg?: ReturnType<typeof config>; judge?: (prompt: string, signal: AbortSignal) => Promise<string> | string; review?: MockReviewerStep[] }) {
  const repo = await makeRepo();
  const manager = new WorktreeManager({ repoPath: repo });
  const cfg = opts.cfg ?? config();
  const events: EngineEventDraft[] = [];
  const judgePrompts: string[] = [];
  const reviewer = new MockReviewer({ steps: opts.review ?? [{ type: "pass" }] });
  const reviewSpy = vi.spyOn(reviewer, "review");
  const seatsFor = (stage: StageSpec) =>
    stage.kind === "review" ? expandSeatSpecs(cfg.teams.judges!.seats, { teamName: "judges" }) : expandSeatSpecs(cfg.teams[stage.team!]!.seats, { teamName: stage.team });
  const createExecutor = (stage: StageSpec): Executor => {
    const index = Number(String(stage.options.seatId).replace("race-", "")) - 1;
    const running = new Map<string, AbortController>();
    return {
      name: `mock-${index}`,
      capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
      async run(task) {
        const stop = new AbortController();
        running.set(task.taskId, stop);
        return opts.builds[index]!(task, stop.signal);
      },
      async continue() {
        throw new Error("never continues");
      },
      async cancel(taskId) {
        running.get(taskId)?.abort();
      },
    };
  };
  const deps = {
    projectPath: repo,
    scheduler: new SeatScheduler({ sessionId: SESSION, backoffBaseMs: 1 }),
    runStep: async () => ({}),
    seatsFor,
    createExecutor,
    createReviewer: () => reviewer,
  } as ModeControllerInput["deps"];
  const host: ModeControllerInput["host"] = opts.judge
    ? {
        askSeat: async ({ prompt, signal }) => {
          judgePrompts.push(prompt);
          return opts.judge!(prompt, signal);
        },
      }
    : {};
  const input: ModeControllerInput = {
    goal: "add impl.txt",
    title: "t",
    autonomy: "autopilot",
    config: cfg,
    sessionId: SESSION,
    stages: {} as ModeControllerInput["stages"],
    deps,
    worktrees: manager,
    host,
    requestApproval: async () => false,
    ask: async () => undefined,
    resume: false,
    signal: new AbortController().signal,
    emit: (e) => void events.push(e),
  };
  const of = (type: string) => events.filter((e) => e.type === type);
  return {
    repo,
    manager,
    events,
    of,
    judgePrompts,
    reviewSpy,
    run: (over: Partial<ModeControllerInput> = {}, extras: RaceExtras = {}): Promise<ModeControllerResult> =>
      createRaceController({ ...input, ...over }, { runCommand, ...extras }).run(),
    runInSession: async (autonomy: "manual" | "supervised" | "autopilot", answer: "approve" | "deny" | "cancel") => {
      const questions: string[] = [];
      const abort = new AbortController();
      const session: ReturnType<typeof prepareModeSession> = prepareModeSession({
        mode: { ...getMode("race")!, createController: (i: ModeControllerInput) => createRaceController(i, { runCommand }) },
        sessionId: SESSION,
        goal: input.goal,
        autonomy,
        config: cfg,
        deps,
        host,
        worktrees: manager,
        signal: abort.signal,
        emit: (e) => {
          if (e.type !== "user.question") return;
          const data = e.data as unknown as { questionId: string; question: string };
          questions.push(data.question);
          queueMicrotask(() => (answer === "cancel" ? abort.abort() : session.answer(data.questionId, answer)));
        },
      });
      return { result: await session.run(), questions };
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** No candidate worktree is left: neither in the manager nor in git. */
async function expectNoWorktrees(s: Setup) {
  expect(await s.manager.list(SESSION)).toEqual([]);
  expect((await git(s.repo, "worktree", "list")).split("\n")).toHaveLength(1);
}

const impl = (s: Setup) => git(s.repo, "show", "HEAD:impl.txt");

// Real git in temp repos, like the other mode tests; generous for loaded machines.
describe("race mode", { timeout: 60_000 }, () => {
  it("drops a candidate that fails the tests; the other wins and lands", async () => {
    const s = await setup({ builds: [writes("broken\n"), writes("works\n")], judge: () => "never asked" });
    const result = await s.run();
    expect(result.status).toBe("completed");
    expect(result.reason).toContain("race: B#1 (race 2) won of 2");
    expect(result.reason).toContain("failed verification");
    expect(await impl(s)).toBe("works");
    expect(s.judgePrompts).toEqual([]); // evidence first: one left, no judge
    expect(s.of("gate.result").map((e) => [e.seatId, (e.data as { passed: boolean }).passed])).toEqual(
      expect.arrayContaining([["race-1", false], ["race-2", true]]),
    );
    expect(s.of("negotiation.decided")[0]).toMatchObject({ stageId: "race", data: { winner: "race-2" } });
    expect(s.of("stage.started")[0]).toMatchObject({ stageId: "race", data: { kind: "execute", strategy: "race", seats: 2 } });
    expect(s.of("stage.completed")[0]).toMatchObject({ data: { winner: "race-2", applied: true } });
    await expectNoWorktrees(s);
  });

  it("both pass: the judge picks one, shown as anonymous labels in tie-break order", async () => {
    const s = await setup({
      builds: [writes("one\n"), writes("one\ntwo\nthree\n")],
      judge: () => '{"winner": "B", "reason": "covers more cases"}',
    });
    const result = await s.run();
    expect(result.status).toBe("completed");
    expect(await impl(s)).toBe("one\ntwo\nthree");
    expect(result.reason).toContain("covers more cases");
    expect(s.judgePrompts).toHaveLength(1);
    expect(s.judgePrompts[0]).toContain('<candidate label="A">');
    expect(s.judgePrompts[0]).not.toContain("race-1");
    expect(s.judgePrompts[0]!.indexOf("+one")).toBeLessThan(s.judgePrompts[0]!.indexOf("+three")); // smaller diff is A
    expect(s.of("negotiation.decided")[0]).toMatchObject({ data: { winner: "race-2" } });
    await expectNoWorktrees(s);
  });

  it("an unusable judge reply falls back to the smaller diff", async () => {
    const s = await setup({ builds: [writes("one\ntwo\n"), writes("one\n")], judge: () => "I like both" });
    const result = await s.run();
    expect(result.status).toBe("completed");
    expect(await impl(s)).toBe("one");
    expect(result.reason).toContain("tie-break: smallest diff");
  });

  it("both fail: blocked, nothing applied, no worktrees left", async () => {
    const s = await setup({ builds: [writes("broken\n"), async () => ({ status: "failed", summary: "gave up" })] });
    const head = await git(s.repo, "rev-parse", "HEAD");
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("all 2 candidates are out; nothing was applied");
    expect(await git(s.repo, "rev-parse", "HEAD")).toBe(head);
    expect(s.of("negotiation.decided")).toEqual([]);
    await expectNoWorktrees(s);
  });

  it("cancel mid-run stops both builders and leaves no worktrees", async () => {
    const abort = new AbortController();
    let started = 0;
    const hang: Build = async (task, stop) => {
      await fs.writeFile(path.join(task.projectPath, "impl.txt"), "half\n");
      if ((started += 1) === 2) setTimeout(() => abort.abort(), 20);
      await new Promise((resolve) => stop.addEventListener("abort", resolve, { once: true }));
      return { status: "cancelled", summary: "cancelled" };
    };
    const s = await setup({ builds: [hang, hang] });
    const result = await s.run({ signal: abort.signal });
    expect(result).toEqual({ status: "blocked", reason: "cancelled" });
    expect(s.of("seat.done").filter((e) => (e.data as { summary?: string }).summary === "cancelled")).toHaveLength(2);
    await expectNoWorktrees(s);
  });

  it("supervised asks before apply: yes lands the winner, no lands nothing and keeps it (marked failed)", async () => {
    const yes = await setup({ builds: [writes("works\n"), writes("broken\n")] });
    const approved = await yes.runInSession("supervised", "approve");
    expect(approved.result.status).toBe("completed");
    expect(approved.questions).toHaveLength(1);
    expect(approved.questions[0]).toContain("race: B#1 (race 1) won of 2");
    expect(await impl(yes)).toBe("works");
    await expectNoWorktrees(yes);

    const no = await setup({ builds: [writes("works\n"), writes("broken\n")] });
    const denied = await no.runInSession("supervised", "deny");
    expect(denied.result.status).toBe("blocked");
    expect(denied.result.reason).toContain("apply was not approved");
    await expect(impl(no)).rejects.toThrow();
    const kept = await no.manager.list(SESSION);
    expect(kept.map((w) => [w.seatId, w.outcome])).toEqual([["race-1", "failed"]]);
  });

  it("a danger-area winner gets the full review and asks even under autopilot", async () => {
    const dangerous = async (task: ExecutorTask) => {
      await fs.mkdir(path.join(task.projectPath, ".github/workflows"), { recursive: true });
      await fs.writeFile(path.join(task.projectPath, ".github/workflows/ci.yml"), "on: push\n");
      return writes("works\n")(task);
    };
    const blocked = await setup({ builds: [dangerous, writes("broken\n")], review: [{ type: "needs_work", summary: "unsafe" }] });
    const r1 = await blocked.run({}, { approve: async () => true });
    expect(r1.status).toBe("blocked");
    expect(r1.reason).toContain("review NEEDS_WORK");
    expect(blocked.reviewSpy).toHaveBeenCalledOnce();

    const ok = await setup({ builds: [dangerous, writes("broken\n")] });
    const approve = vi.fn(async (_summary: string) => true);
    expect((await ok.run({}, { approve })).status).toBe("completed");
    expect(approve.mock.calls[0]![0]).toContain("[danger area");
    expect(ok.reviewSpy).toHaveBeenCalledOnce();

    const plain = await setup({ builds: [writes("works\n"), writes("broken\n")] });
    expect((await plain.run()).status).toBe("completed");
    expect(plain.reviewSpy).not.toHaveBeenCalled();
  });

  it("a candidate that changes test runner config loses ties and, if picked, gets the full review and an ask", async () => {
    const withConftest = async (task: ExecutorTask) => {
      await fs.writeFile(path.join(task.projectPath, "conftest.py"), "collect_ignore = ['tests']\n");
      return writes("works\n")(task);
    };
    const clean = writes("works\nand more\nand more\n");
    // No judge: the clean candidate wins although its diff is bigger.
    const tie = await setup({ builds: [withConftest, clean] });
    expect((await tie.run()).status).toBe("completed");
    expect(await impl(tie)).toBe("works\nand more\nand more");
    expect(tie.reviewSpy).not.toHaveBeenCalled();

    // The judge picks it (label B: suspect candidates come last): review, then the mode asks even under autopilot.
    const picked = await setup({ builds: [withConftest, clean], judge: () => '{"winner": "B", "reason": "smaller"}' });
    const blocked = await picked.run();
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toContain("changes tests or test runner config: conftest.py");
    expect(picked.reviewSpy).toHaveBeenCalledOnce();
    await expect(git(picked.repo, "show", "HEAD:conftest.py")).rejects.toThrow();

    const approved = await setup({ builds: [withConftest, clean], judge: () => '{"winner": "B", "reason": "smaller"}' });
    const approve = vi.fn(async (_summary: string) => true);
    expect((await approved.run({}, { approve })).status).toBe("completed");
    expect(approve.mock.calls[0]![0]).toContain("[changes tests or test runner config: conftest.py]");
  });

  it("deleting an existing test is suspect: full review and an ask, never a silent landing", async () => {
    const s = await setup({
      builds: [
        async (task) => {
          await fs.rm(path.join(task.projectPath, "tests", "impl.test.js"));
          return writes("works\n")(task);
        },
        writes("broken\n"),
      ],
    });
    await fs.mkdir(path.join(s.repo, "tests"));
    await fs.writeFile(path.join(s.repo, "tests", "impl.test.js"), "expect(impl).toBe('right');\n");
    await git(s.repo, "add", ".");
    await git(s.repo, "commit", "-q", "-m", "a test");
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("changes tests or test runner config: tests/impl.test.js");
    expect(s.reviewSpy).toHaveBeenCalledOnce();
    expect(await git(s.repo, "show", "HEAD:tests/impl.test.js")).toBe("expect(impl).toBe('right');");
    expect((await s.manager.list(SESSION)).map((w) => w.outcome)).toEqual(["failed"]); // kept for the user
  });

  it("cancel mid-gate, mid-judge and at the apply question leaves no worktrees", async () => {
    const abort = new AbortController();
    const gate = await setup({ builds: [writes("works\n"), writes("works\n")] });
    const hangingGate: NonNullable<RaceExtras["runCommand"]> = async (_c, _cwd, options) => {
      setTimeout(() => abort.abort(), 10);
      await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
      return { stdout: "", stderr: "killed", code: 1 };
    };
    expect(await gate.run({ signal: abort.signal }, { runCommand: hangingGate })).toEqual({ status: "blocked", reason: "cancelled" });
    await expectNoWorktrees(gate);

    const judgeAbort = new AbortController();
    const judged = await setup({
      builds: [writes("one\n"), writes("two\n")],
      judge: (_prompt, signal) => {
        setTimeout(() => judgeAbort.abort(), 10);
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    });
    expect(await judged.run({ signal: judgeAbort.signal })).toEqual({ status: "blocked", reason: "cancelled" });
    expect(judged.of("negotiation.decided")).toEqual([]);
    await expectNoWorktrees(judged);

    const asked = await setup({ builds: [writes("works\n"), writes("broken\n")] });
    const out = await asked.runInSession("supervised", "cancel");
    expect(out.questions).toHaveLength(1);
    expect(out.result.status).toBe("cancelled");
    await expect(impl(asked)).rejects.toThrow();
    await expectNoWorktrees(asked);
  });

  it("manual asks once before any work; a no runs nothing", async () => {
    const build = vi.fn(writes("works\n"));
    const s = await setup({ builds: [build, build] });
    const { result, questions } = await s.runInSession("manual", "deny");
    expect(result.status).toBe("blocked");
    expect(questions).toEqual(["Start a race of 2 candidates (2× the build cost)?"]);
    expect(build).not.toHaveBeenCalled();
    await expectNoWorktrees(s);
  });
});

describe("race config, order and estimate", () => {
  it("validates modes.race; profiles do not override an explicit seat count", () => {
    expect(raceProblems(config())).toEqual([]);
    expect(raceProblems(parseAssentorConfig({}))).toEqual([]);
    expect(raceProblems(config({ seats: 5 }))[0]).toContain("modes.race.seats");
    expect(raceProblems(config({ team: "judges" }))).toEqual(['race team "judges" has no edit seat']);
    expect(raceProblems(config({ team: "nope" }))).toEqual(['unknown team "nope" in modes.race']);
    expect(raceSeatCount(config({ seats: 4 }))).toBe(4);
    expect(raceSeatCount(config({ seats: 4 }, { run: { profile: "economy" } }))).toBe(4);
    expect(raceSeatCount(parseAssentorConfig({ run: { profile: "economy" } }))).toBe(2);
  });

  it("tie-break: clean before suspect, then smaller diff, then seat order", () => {
    expect(raceOrder([{ index: 0, size: 5, suspect: [] }, { index: 1, size: 2, suspect: [] }, { index: 2, size: 2, suspect: [] }]).map((c) => c.index)).toEqual([1, 2, 0]);
    expect(raceOrder([{ index: 0, size: 1, suspect: ["conftest.py"] }, { index: 1, size: 9, suspect: [] }]).map((c) => c.index)).toEqual([1, 0]);
    expect(diffSize("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n")).toBe(3);
  });

  it("the pre-run estimate counts N candidates (N× one build)", () => {
    const one = estimateRun(config({ seats: 2 }), { prompt: "goal", modeId: "race" });
    const three = estimateRun(config({ seats: 3 }), { prompt: "goal", modeId: "race" });
    const builds = (e: typeof one) => e.perSeat.filter((s) => s.seatId.startsWith("race-"));
    expect(builds(one)).toHaveLength(2);
    expect(builds(three)).toHaveLength(3);
    expect(three.totalLow - one.totalLow).toBe(builds(three)[0]!.low);
    expect(three.notes[0]).toBe("race: 3 candidates build in parallel, 3× the build cost");
    const economy = estimateRun(config({ seats: 4 }, { run: { profile: "economy" } }), { prompt: "goal", modeId: "race" });
    expect(builds(economy)).toHaveLength(4);
  });
});
