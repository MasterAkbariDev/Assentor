import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandSeatSpecs,
  MockReviewer,
  parseAssentorConfig,
  WorktreeManager,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type ExecutorTask,
  type ModeControllerInput,
  type ModeControllerResult,
  type StageSpec,
} from "../../src/index.js";
import type { MockReviewerStep } from "../../src/providers/reviewers/mock/index.js";
import { createDebugController, debugProblems, instrumentationLines, rankFindings, type DebugExtras } from "../../src/modes/debug.js";
import { SeatScheduler } from "../../src/seats/index.js";

const exec = promisify(execFile);
// Real git in temp repos, like strategy-best-of-n.test.ts.
vi.setConfig({ testTimeout: 120_000 });
const SESSION = "44444444-4444-4444-8444-444444444444";
const dirs: string[] = [];

const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-debug-")));
  dirs.push(dir);
  await git(dir, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "assentor@test");
  await git(dir, "config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n");
  await fs.writeFile(path.join(dir, "bug.txt"), "bad\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const baseConfig = (debug: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  parseAssentorConfig({
    teams: {
      hyp: { seats: [{ provider: "mock", model: "h", count: 2, permissions: "edit" }] },
      fixers: { seats: [{ provider: "mock", model: "f", permissions: "edit" }] },
    },
    modes: { debug: { hypothesisTeam: "hyp", fixTeam: "fixers", reproCommand: "repro", maxRounds: 1, ...debug } },
    ...extra,
  });

const done = (summary = "done", rawOutput?: string): ExecutorResult => ({ status: "completed", summary, ...(rawOutput ? { rawOutput } : {}) });
const reply = (over: Record<string, unknown>) =>
  JSON.stringify({ hypothesis: "h", experiment: "log it", verdict: "supported", confidence: 0.8, evidence: "saw it", ...over });

function executor(work: (task: ExecutorTask) => Promise<ExecutorResult> | ExecutorResult) {
  const ex: Executor & { prompts: string[] } = {
    name: "mock-executor",
    prompts: [],
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
    async run(task) {
      ex.prompts.push(task.prompt);
      return work(task);
    },
    async continue() {
      throw new Error("never continues");
    },
    async cancel() {},
  };
  return ex;
}

/** The scripted "bug": repro fails while bug.txt says bad; prints instr.txt (the experiments' instrumentation). */
const runCommand: NonNullable<DebugExtras["runCommand"]> = async (command, cwd) => {
  const read = (file: string) => fs.readFile(path.join(cwd, file), "utf8").catch(() => "");
  if (command === "gate-fail") return { stdout: "", stderr: "gate broke", code: 1 };
  const bug = (await read("bug.txt")).includes("bad");
  return { stdout: `${bug ? "FAIL: bug" : "ok"}\n${await read("instr.txt")}`, stderr: "", code: bug ? 1 : 0 };
};

type HypothesisScript = (seatIndex: number, round: number, cwd: string) => Promise<ExecutorResult> | ExecutorResult;

interface Setup {
  repo: string;
  events: EngineEventDraft[];
  hypothesisExecutors: Array<ReturnType<typeof executor>>;
  fixExecutor: ReturnType<typeof executor>;
  run(over?: Partial<ModeControllerInput>, extras?: DebugExtras): Promise<ModeControllerResult>;
  manager: WorktreeManager;
}

async function setup(opts: {
  config?: ReturnType<typeof baseConfig>;
  hypothesis: HypothesisScript;
  fix: (task: ExecutorTask, attempt: number) => Promise<ExecutorResult> | ExecutorResult;
  review?: MockReviewerStep[];
}): Promise<Setup> {
  const repo = await makeRepo();
  const manager = new WorktreeManager({ repoPath: repo });
  const config = opts.config ?? baseConfig();
  const events: EngineEventDraft[] = [];
  const seatsFor = (stage: StageSpec) => expandSeatSpecs(config.teams[stage.team!]!.seats, { teamName: stage.team });
  const rounds = new Map<number, number>();
  const hypothesisExecutors: Array<ReturnType<typeof executor>> = [];
  let attempts = 0;
  const fixExecutor = executor((task) => opts.fix(task, ++attempts));
  const hypSeatIds = seatsFor({ id: "x", kind: "execute", team: "hyp" } as StageSpec).map((s) => s.id);
  const createExecutor = (stage: StageSpec): Executor => {
    if (stage.id === "debug-fix") return fixExecutor;
    const index = hypSeatIds.indexOf(String(stage.options?.seatId));
    const round = (rounds.get(index) ?? 0) + 1;
    rounds.set(index, round);
    const ex = executor((task) => opts.hypothesis(index, round, task.projectPath));
    hypothesisExecutors.push(ex);
    return ex;
  };
  const deps = {
    projectPath: repo,
    scheduler: new SeatScheduler({ sessionId: SESSION, backoffBaseMs: 1 }),
    runStep: async () => ({}),
    seatsFor,
    createExecutor,
    createReviewer: () => new MockReviewer({ steps: opts.review ?? [{ type: "pass" }] }),
  } as ModeControllerInput["deps"];
  const input: ModeControllerInput = {
    goal: "average() returns the wrong value",
    title: "t",
    autonomy: "autopilot",
    config,
    sessionId: SESSION,
    stages: {} as ModeControllerInput["stages"],
    deps,
    worktrees: manager,
    signal: new AbortController().signal,
    emit: (e) => void events.push(e),
  };
  return {
    repo,
    events,
    hypothesisExecutors,
    fixExecutor,
    manager,
    run: (over = {}, extras = {}) => createDebugController({ ...input, ...over }, { runCommand, ...extras }).run(),
  };
}

const writeInstr = (cwd: string, text: string) => fs.writeFile(path.join(cwd, "instr.txt"), `${text} ASSENTOR-DEBUG\n`);
const fixesBug = async (task: ExecutorTask) => {
  await fs.writeFile(path.join(task.projectPath, "bug.txt"), "good\n");
  return done("fixed");
};
const winnerAt = (index: number): HypothesisScript => async (i, _round, cwd) => {
  if (i !== index) return done("x", reply({ verdict: "refuted", confidence: 0.2, hypothesis: `wrong guess ${i}` }));
  await writeInstr(cwd, "SIG-RIGHT");
  return done("x", reply({ hypothesis: "off by one in the divisor", signal: "SIG-RIGHT" }));
};

describe("debug mode", () => {
  it("runs hypotheses in own worktrees, ranks by controller-verified evidence, fixes, reviews, applies", async () => {
    const s = await setup({ hypothesis: winnerAt(1), fix: fixesBug });
    const result = await s.run();
    expect(result.status).toBe("completed");
    expect(await fs.readFile(path.join(s.repo, "bug.txt"), "utf8")).toBe("good\n");
    // Instrumentation never reached main; only the reviewed fix did.
    await expect(fs.access(path.join(s.repo, "instr.txt"))).rejects.toBeTruthy();
    expect(await git(s.repo, "log", "--format=%s", "-n", "1")).toContain("debug: fixed off by one in the divisor");
    expect(s.hypothesisExecutors).toHaveLength(2);
    expect(s.fixExecutor.prompts[0]).toContain("off by one in the divisor");
    expect(s.fixExecutor.prompts[0]).toContain("<evidence>");
    expect(s.hypothesisExecutors[0]!.prompts[0]).toContain("FAIL: bug");
    expect((await s.manager.list(SESSION)).length).toBe(0);
    expect(s.events.filter((e) => e.type === "seat.done")).toHaveLength(3);
  });

  it("does not trust a seat's claim: no signal in the controller's own run means no winner", async () => {
    const s = await setup({
      hypothesis: (i) => done("x", reply({ hypothesis: `claim ${i}`, signal: "NEVER-PRINTED" })),
      fix: fixesBug,
    });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("no hypothesis was confirmed");
    expect(s.fixExecutor.prompts).toHaveLength(0);
    expect(await fs.readFile(path.join(s.repo, "bug.txt"), "utf8")).toBe("bad\n");
    expect((await s.manager.list(SESSION)).length).toBe(0);
  });

  it("a signal already in the baseline output does not discriminate", async () => {
    const s = await setup({ hypothesis: () => done("x", reply({ signal: "FAIL: bug" })), fix: fixesBug });
    expect((await s.run()).status).toBe("blocked");
  });

  it("round 2 is told what was ruled out, and can win", async () => {
    const s = await setup({
      config: baseConfig({ maxRounds: 2 }),
      hypothesis: async (i, round, cwd) => {
        if (round === 1 || i === 0) return done("x", reply({ verdict: "refuted", hypothesis: `r${round} guess ${i}` }));
        await writeInstr(cwd, "SIG-R2");
        return done("x", reply({ hypothesis: "late winner", signal: "SIG-R2" }));
      },
      fix: fixesBug,
    });
    expect((await s.run()).status).toBe("completed");
    expect(s.hypothesisExecutors[2]!.prompts[0]).toContain("<tried-hypotheses>");
    expect(s.hypothesisExecutors[2]!.prompts[0]).toContain("r1 guess 0");
  });

  it("stops blocked when the bug does not reproduce, changing nothing", async () => {
    const s = await setup({ hypothesis: winnerAt(0), fix: fixesBug });
    await fs.writeFile(path.join(s.repo, "bug.txt"), "good\n");
    await git(s.repo, "commit", "-qam", "already fixed");
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("could not reproduce");
    expect(s.hypothesisExecutors).toHaveLength(0);
  });

  it("sends a fix back that adds instrumentation and blocks if it is never removed", async () => {
    const s = await setup({
      hypothesis: winnerAt(0),
      fix: async (task, attempt) => {
        if (attempt === 1) await writeInstr(task.projectPath, "SIG");
        return fixesBug(task);
      },
    });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(s.fixExecutor.prompts[1]).toContain("Temporary instrumentation (ASSENTOR-DEBUG)");
    expect(await fs.readFile(path.join(s.repo, "bug.txt"), "utf8")).toBe("bad\n");
  });

  it("accepts a second fix attempt after a failed repro", async () => {
    const s = await setup({
      hypothesis: winnerAt(0),
      fix: (task, attempt) => (attempt === 1 ? done("no-op") : fixesBug(task)),
    });
    expect((await s.run()).status).toBe("completed");
    expect(s.fixExecutor.prompts[1]).toContain("The reproduction still fails");
  });

  it("feeds failing gates back to the fix seat and blocks when attempts run out", async () => {
    const s = await setup({
      config: baseConfig({ fixAttempts: 1 }, { verification: { commands: { test: "gate-fail" } } }),
      hypothesis: winnerAt(0),
      fix: fixesBug,
    });
    // `repro` passes after the fix but the configured gate fails.
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("failed after 1 attempt");
    expect(result.reason).toContain("gate broke");
    expect(await fs.readFile(path.join(s.repo, "bug.txt"), "utf8")).toBe("bad\n");
  });

  it("blocks without applying when review does not pass", async () => {
    const s = await setup({
      hypothesis: winnerAt(0),
      fix: fixesBug,
      review: [{ type: "needs_work", summary: "wrong place", requiredChanges: ["move it"] }],
    });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("wrong place");
    expect(await fs.readFile(path.join(s.repo, "bug.txt"), "utf8")).toBe("bad\n");
  });

  it("supervised: needs approval; applies on yes, keeps the fix on no or without a channel", async () => {
    const without = await setup({ hypothesis: winnerAt(0), fix: fixesBug });
    const blocked = await without.run({ autonomy: "supervised" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toContain("approval needed");
    expect(await fs.readFile(path.join(without.repo, "bug.txt"), "utf8")).toBe("bad\n");

    for (const [answer, status] of [[false, "blocked"], [true, "completed"]] as const) {
      const s = await setup({ hypothesis: winnerAt(0), fix: fixesBug });
      const approve = vi.fn(async () => answer);
      const result = await s.run({ autonomy: "supervised" }, { approve });
      expect(result.status).toBe(status);
      expect(approve).toHaveBeenCalledTimes(1);
    }
  });

  it("a danger-area fix needs approval even under autopilot", async () => {
    const dangerous = async (task: ExecutorTask) => {
      await fs.mkdir(path.join(task.projectPath, ".github/workflows"), { recursive: true });
      await fs.writeFile(path.join(task.projectPath, ".github/workflows/ci.yml"), "on: push\n");
      return fixesBug(task);
    };
    const s = await setup({ hypothesis: winnerAt(0), fix: dangerous });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("danger area");
    const approve = vi.fn(async (_summary: string) => true);
    const s2 = await setup({ hypothesis: winnerAt(0), fix: dangerous });
    expect((await s2.run({}, { approve })).status).toBe("completed");
    expect(approve.mock.calls[0]![0]).toContain("[danger area");
  });

  it("manual autonomy without an approval channel does not start", async () => {
    const s = await setup({ hypothesis: winnerAt(0), fix: fixesBug });
    const result = await s.run({ autonomy: "manual" });
    expect(result.status).toBe("blocked");
    expect(s.hypothesisExecutors).toHaveLength(0);
  });

  it("a cancelled session ends blocked and leaves no worktrees", async () => {
    const abort = new AbortController();
    const s = await setup({
      hypothesis: async () => {
        abort.abort();
        return done("x", reply({}));
      },
      fix: fixesBug,
    });
    const result = await s.run({ signal: abort.signal });
    expect(result).toEqual({ status: "blocked", reason: "cancelled" });
    expect((await s.manager.list(SESSION)).length).toBe(0);
  });

  it("a seat that fails or answers garbage is a failed finding, not a crash", async () => {
    const s = await setup({
      hypothesis: async (i, _r, cwd) => {
        if (i === 0) return done("no json here");
        await writeInstr(cwd, "SIG-OK");
        return done("x", reply({ hypothesis: "survivor", signal: "SIG-OK" }));
      },
      fix: fixesBug,
    });
    expect((await s.run()).status).toBe("completed");
  });
});

describe("debug config validation", () => {
  const problems = (debug: unknown, teams?: Record<string, unknown>) =>
    debugProblems(
      parseAssentorConfig({
        teams: teams ?? {
          hyp: { seats: [{ provider: "mock", model: "h", count: 2, permissions: "edit" }] },
          fixers: { seats: [{ provider: "mock", model: "f", permissions: "edit" }] },
        },
        ...(debug ? { modes: { debug } } : {}),
      }),
    );

  it("accepts a valid config", () => {
    expect(problems({ hypothesisTeam: "hyp", fixTeam: "fixers" })).toEqual([]);
  });
  it("needs modes.debug", () => {
    expect(problems(undefined)[0]).toContain("needs modes.debug");
  });
  it("rejects unknown keys, unknown teams, a multi-seat fix team and read-only seats", () => {
    expect(problems({ hypothesisTeam: "hyp", fixTeam: "fixers", extra: 1 }).join()).toContain("modes.debug");
    expect(problems({ hypothesisTeam: "nope", fixTeam: "fixers" }).join()).toContain('unknown team "nope"');
    expect(problems({ hypothesisTeam: "hyp", fixTeam: "hyp" }).join()).toContain("exactly one seat");
    const readOnly = { hyp: { seats: [{ provider: "mock", model: "h", permissions: "read-only" }] }, fixers: { seats: [{ provider: "mock", model: "f" }] } };
    expect(problems({ hypothesisTeam: "hyp", fixTeam: "fixers" }, readOnly).join()).toContain("must have edit permission");
  });
});

describe("debug helpers", () => {
  it("ranks confirmed first, then by confidence, keeping seat order on ties", () => {
    const f = (confirmed: boolean, confidence: number, id: string) => ({ confirmed, confidence, id });
    expect(rankFindings([f(false, 0.9, "a"), f(true, 0.2, "b"), f(true, 0.2, "c"), f(true, 0.7, "d")]).map((x) => x.id)).toEqual(["d", "b", "c", "a"]);
  });
  it("finds added instrumentation lines in a diff only", () => {
    const diff = ["--- a/x", "+++ b/x", "+console.log(1) // assentor-debug", "-old // ASSENTOR-DEBUG", " ctx", "+clean"].join("\n");
    expect(instrumentationLines(diff)).toEqual(["console.log(1) // assentor-debug"]);
  });
});
