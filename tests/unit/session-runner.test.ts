import { afterEach, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createId,
  expandSeatSpecs,
  makeReviewResult,
  MockReviewer,
  PanelReviewer,
  ReviewStatus,
  Severity,
  SessionRunner,
  validateSessionGraph,
  createDebateTiebreak,
  createStageRunners,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type Reviewer,
  type SeatStepRunner,
  type SessionSpec,
  type StageRunnerDeps,
  type StageRunners,
  type StageSpec,
} from "../../src/index.js";
import type { ReviewerFinding } from "../../src/agents/routed-reviewer.js";
import { SeatScheduler } from "../../src/seats/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-runner-"));
  dirs.push(dir);
  return dir;
}

const teams: Record<string, ReturnType<typeof expandSeatSpecs>> = {
  planners: expandSeatSpecs([{ provider: "mock", model: "planner", count: 2 }], { teamName: "planners" }),
  reviewers: expandSeatSpecs([{ provider: "mock", model: "critic", count: 2 }], { teamName: "reviewers" }),
};
const seatsFor = (stage: StageSpec) => {
  const team = stage.team ? teams[stage.team] : undefined;
  if (!team) throw new Error(`unknown team "${stage.team}"`);
  return team;
};

/** Debate stub: every seat proposes `proposal(vars)`, critiques nothing and agrees on Proposal A. */
function debateRunner(
  proposal: (vars: Readonly<Record<string, unknown>>) => string,
  agree = true,
): SeatStepRunner & { proposeGoals: string[] } {
  const proposeGoals: string[] = [];
  const run: SeatStepRunner = async ({ step, vars }) => {
    if (step === "negotiate-propose") {
      proposeGoals.push(String(vars.goal));
      return { proposal: proposal(vars) };
    }
    if (step === "negotiate-critique") return { critiques: [] };
    if (step === "negotiate-revise") return { proposal: proposal(vars) };
    if (step === "negotiate-agree") return { agree, preferred: "Proposal A", confidence: 1 };
    if (step === "judge") return { winner: "Proposal A", reasons: ["first"] };
    throw new Error(`unexpected step ${step}`);
  };
  return Object.assign(run, { proposeGoals });
}

interface MockExec extends Executor {
  prompts: string[];
  cancelled: string[];
}

function executor(
  handle: (call: number) => Promise<ExecutorResult> | ExecutorResult = () => ({
    status: "completed",
    summary: "done",
    sessionId: "sess-1",
  }),
): MockExec {
  let calls = 0;
  const prompts: string[] = [];
  const cancelled: string[] = [];
  return {
    name: "mock-executor",
    prompts,
    cancelled,
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
    async run(task) {
      prompts.push(task.prompt);
      return handle(++calls);
    },
    async continue() {
      return handle(++calls);
    },
    async cancel(taskId) {
      cancelled.push(taskId);
    },
  };
}

function panel(steps: Array<ConstructorParameters<typeof MockReviewer>[0]>, tiebreak = {}): PanelReviewer {
  return new PanelReviewer({ name: "panel", policy: "majority", reviewers: steps.map((s) => new MockReviewer(s)), ...tiebreak });
}

const spec: SessionSpec = {
  title: "Average",
  goal: "Implement average()",
  stages: [
    { id: "plan", kind: "plan", team: "planners", strategy: "debate", options: {}, requireApproval: false, next: "build" },
    {
      id: "build",
      kind: "execute",
      team: "builders",
      strategy: "best-of-n",
      options: { n: 2 },
      requireApproval: false,
      next: "check",
    },
    {
      id: "check",
      kind: "review",
      team: "reviewers",
      strategy: "panel",
      options: { tiebreak: "negotiate", maxRounds: 4 },
      requireApproval: false,
    },
  ],
};

function deps(projectPath: string, over: Partial<StageRunnerDeps> = {}): StageRunnerDeps {
  return {
    projectPath,
    scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
    runStep: debateRunner(() => "Plan: sum the values and divide by the count"),
    seatsFor,
    createExecutor: () => executor(),
    createReviewer: (_stage, tiebreak) => panel([{ name: "r1" }, { name: "r2" }], tiebreak),
    supervisor: { skipGates: true },
    ...over,
  };
}

function recorder() {
  const events: EngineEventDraft[] = [];
  return { events, emit: (e: EngineEventDraft) => void events.push(e) };
}

const stageEvents = (events: EngineEventDraft[]) =>
  events
    .filter((e) => e.type === "stage.started" || e.type === "stage.completed")
    .map((e) => `${e.type === "stage.started" ? "start" : "end"} ${e.stageId}${e.type === "stage.completed" ? ` ${String(e.data.outcome)}` : ""}`);

async function readGraph(projectPath: string, sessionId: string) {
  return JSON.parse(await fs.readFile(path.join(projectPath, ".assentor", "sessions", sessionId, "graph.json"), "utf8"));
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SessionRunner end to end (mock)", () => {
  it("plan(debate) → execute(best-of-n) → review(panel, NEEDS_WORK once) → PASS", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    const exec = executor();
    const executorStages: StageSpec[] = [];
    const members = [
      { name: "r1", steps: [{ type: "needs_work" as const, requiredChanges: ["add tests"] }] },
      { name: "r2", steps: [{ type: "needs_work" as const, requiredChanges: ["add tests"] }] },
    ];
    let reviewer: PanelReviewer | undefined;
    const { events, emit } = recorder();
    const runner = new SessionRunner({
      sessionId,
      projectPath,
      emit,
      runners: createStageRunners(
        deps(projectPath, {
          createExecutor: (stage) => {
            executorStages.push(stage);
            return exec;
          },
          createReviewer: (_stage, tiebreak) => (reviewer = panel(members, tiebreak)),
        }),
      ),
    });

    const result = await runner.run(spec);

    expect(result).toMatchObject({ status: "completed", plan: "Plan: sum the values and divide by the count" });
    expect(result.history.map((h) => [h.stageId, h.attempt, h.outcome])).toEqual([
      ["plan", 1, "pass"],
      ["build", 2, "pass"],
    ]);
    expect(executorStages.map((s) => s.strategy)).toEqual(["best-of-n"]);
    expect(exec.prompts[0]).toContain("Agreed plan (follow it):\nPlan: sum the values");
    expect(reviewer!.callCount).toBe(2); // NEEDS_WORK, then PASS
    expect(stageEvents(events)).toEqual([
      "start plan",
      "end plan pass",
      "start build",
      "start check",
      "end check pass",
      "end build pass",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "session.completed" });
    expect(events.filter((e) => e.type.startsWith("negotiation.")).every((e) => e.stageId === "plan")).toBe(true);
    const graph = await readGraph(projectPath, sessionId);
    expect(graph).toMatchObject({ status: "completed", attempts: 2, visits: { plan: 1, build: 1 } });
    expect(graph.current).toBeUndefined();
    await fs.access(path.join(projectPath, ".assentor", "sessions", sessionId, "negotiations", "plan-1.json"));
  });

  it("a review still NEEDS_WORK after maxRounds follows onNeedsWork with feedback, then hits the loop limit", async () => {
    const projectPath = await tempProject();
    const runStep = debateRunner(() => "Plan v");
    const loop: SessionSpec = {
      ...spec,
      stages: spec.stages.map((s) => (s.id === "check" ? { ...s, options: { maxRounds: 1 }, onNeedsWork: "plan" } : s)),
    };
    const alwaysNeedsWork = { steps: Array.from({ length: 10 }, () => ({ type: "needs_work" as const, requiredChanges: ["add tests"] })) };
    const { events, emit } = recorder();
    const result = await new SessionRunner({
      sessionId: createId(),
      projectPath,
      emit,
      maxStageVisits: 2,
      runners: createStageRunners(
        deps(projectPath, {
          runStep,
          createReviewer: () => panel([{ name: "r1", ...alwaysNeedsWork }, { name: "r2", ...alwaysNeedsWork }]),
        }),
      ),
    }).run(loop);

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain('loop limit: stage "plan" already ran 2 times');
    expect(result.history.map((h) => `${h.stageId}:${h.outcome}`)).toEqual([
      "plan:pass",
      "build:needs_work",
      "plan:pass",
      "build:needs_work",
    ]);
    // The second plan round sees what the review asked for.
    expect(runStep.proposeGoals.at(-1)).toContain("The last review asked for these changes:\n- add tests");
    expect(runStep.proposeGoals[0]).not.toContain("add tests");
    expect(events.at(-1)).toMatchObject({ type: "session.blocked" });
  });
});

describe("SessionRunner resume", () => {
  it("resumes after a crash mid-stage: finished stages are kept, the interrupted stage re-runs", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    let hung = false;
    const runStep = debateRunner(() => "Plan A");
    const crashed = new SessionRunner({
      sessionId,
      projectPath,
      runners: createStageRunners(
        deps(projectPath, {
          runStep,
          // The process "dies" here: the executor never answers and nothing more is written.
          createExecutor: () =>
            executor(() => {
              hung = true;
              return new Promise<ExecutorResult>(() => undefined);
            }),
        }),
      ),
    });
    void crashed.run(spec);
    await until(() => hung);
    expect(await readGraph(projectPath, sessionId)).toMatchObject({ status: "running", current: "build", attempts: 2 });
    const plannerAsks = runStep.proposeGoals.length;

    const exec = executor();
    const { events, emit } = recorder();
    const result = await new SessionRunner({
      sessionId,
      projectPath,
      emit,
      runners: createStageRunners(deps(projectPath, { runStep, createExecutor: () => exec })),
    }).resume();

    expect(result.status).toBe("completed");
    expect(runStep.proposeGoals.length).toBe(plannerAsks); // plan not re-run
    expect(exec.prompts[0]).toContain("Plan A"); // plan restored from the checkpoint
    expect(result.history.map((h) => [h.stageId, h.attempt, h.outcome])).toEqual([
      ["plan", 1, "pass"],
      ["build", 3, "pass"], // attempt 2 was the interrupted one
    ]);
    expect(stageEvents(events)).toEqual(["start build", "start check", "end check pass", "end build pass"]);
  });

  it("a completed session resumes as is, and run() refuses a session that already has a graph", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    const runners = createStageRunners(deps(projectPath));
    await new SessionRunner({ sessionId, projectPath, runners }).run(spec);

    const again = await new SessionRunner({ sessionId, projectPath, runners: stubRunners() }).resume();
    expect(again.status).toBe("completed");
    await expect(new SessionRunner({ sessionId, projectPath, runners }).run(spec)).rejects.toThrow("already has a stage graph");
    const once = new SessionRunner({ sessionId: createId(), runners: stubRunners() });
    await once.run(spec);
    await expect(once.run(spec)).rejects.toThrow("runs once");
  });

  it("refuses a tampered graph file", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    await new SessionRunner({ sessionId, projectPath, runners: stubRunners() }).run(spec);
    const file = path.join(projectPath, ".assentor", "sessions", sessionId, "graph.json");
    const graph = JSON.parse(await fs.readFile(file, "utf8"));
    graph.status = "running";
    graph.current = "build";
    graph.spec.stages[0].next = "nowhere";
    await fs.writeFile(file, JSON.stringify(graph));
    await expect(new SessionRunner({ sessionId, projectPath, runners: stubRunners() }).resume()).rejects.toThrow();
  });
});

function stubRunners(over: Partial<StageRunners> = {}): StageRunners & { executed: number } {
  const runners = {
    executed: 0,
    negotiate: async () => ({ outcome: "pass" as const, summary: "ok", decision: "the plan" }),
    execute: async () => {
      runners.executed += 1;
      return { outcome: "pass" as const, summary: "built" };
    },
    ...over,
  };
  return runners;
}

describe("approval gates", () => {
  const gated: SessionSpec = {
    ...spec,
    stages: spec.stages.map((s) => (s.id === "build" ? { ...s, requireApproval: true } : s)),
  };

  it("blocks before the stage until approve(stageId)", async () => {
    const runners = stubRunners();
    const { events, emit } = recorder();
    const runner = new SessionRunner({ sessionId: createId(), runners, emit });
    const done = runner.run(gated);
    await until(() => events.some((e) => e.type === "session.state" && e.data.to === "waiting"));
    await new Promise((r) => setTimeout(r, 20));
    expect(runners.executed).toBe(0);
    expect(events.find((e) => e.type === "session.state")).toMatchObject({ stageId: "build" });
    expect(stageEvents(events)).toEqual(["start plan", "end plan pass"]);
    expect(runner.approve("plan")).toBe(false);
    expect(runner.approve("check")).toBe(false);
    expect(runner.approve("build")).toBe(true);
    expect((await done).status).toBe("completed");
    expect(runners.executed).toBe(1);
    expect(runner.approve("build")).toBe(false);
  });

  it("cancel while waiting ends the session without starting the stage, and resume asks again", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    const session = new AbortController();
    const { events, emit } = recorder();
    const runner = new SessionRunner({ sessionId, projectPath, runners: stubRunners(), emit, signal: session.signal });
    const done = runner.run(gated);
    await until(() => events.some((e) => e.type === "session.state" && e.data.to === "waiting"));
    session.abort();
    const result = await done;
    expect(result).toMatchObject({ status: "cancelled", current: "build" });
    expect(stageEvents(events)).toEqual(["start plan", "end plan pass"]);
    expect(getEventListeners(session.signal, "abort")).toHaveLength(0);

    const runners = stubRunners();
    const second = recorder();
    const resumed = new SessionRunner({ sessionId, projectPath, runners, emit: second.emit });
    const finished = resumed.resume();
    await until(() => second.events.some((e) => e.type === "session.state" && e.data.to === "waiting"));
    expect(runners.executed).toBe(0);
    resumed.approve("build");
    expect((await finished).status).toBe("completed");
  });
});

describe("failure paths", () => {
  it("cancel mid-negotiation: no ask left running, every seat and stage gets a terminal event", async () => {
    const projectPath = await tempProject();
    const session = new AbortController();
    let active = 0;
    let started = 0;
    const runStep: SeatStepRunner = ({ signal }) => {
      active += 1;
      started += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          active -= 1;
          reject(new Error("aborted"));
        });
      });
    };
    const { events, emit } = recorder();
    const done = new SessionRunner({
      sessionId: createId(),
      projectPath,
      emit,
      signal: session.signal,
      runners: createStageRunners(deps(projectPath, { runStep })),
    }).run(spec);
    await until(() => started === 2);
    session.abort();
    const result = await done;

    expect(result).toMatchObject({ status: "cancelled", current: "plan" });
    expect(active).toBe(0);
    expect(stageEvents(events)).toEqual(["start plan", "end plan cancelled"]);
    for (const seat of teams.planners!) {
      const own = events.filter((e) => e.seatId === seat.id);
      expect(own.at(-1)?.type, seat.id).toMatch(/seat\.(done|error)/);
    }
    expect(events.at(-1)).toMatchObject({ type: "session.failed", data: { status: "cancelled" } });
  });

  it("cancel mid-execute: the executor is cancelled, the Supervisor settles, nothing reviews", async () => {
    const projectPath = await tempProject();
    const session = new AbortController();
    let release: (() => void) | undefined;
    const exec = executor(
      () =>
        new Promise<ExecutorResult>((resolve) => {
          release = () => resolve({ status: "cancelled", summary: "stopped" });
        }),
    );
    exec.cancel = async (taskId) => {
      exec.cancelled.push(taskId);
      release?.();
    };
    let reviews = 0;
    const counting: Reviewer = {
      name: "counting",
      review: async () => ((reviews += 1), { error: "unexpected" }),
      continue: async () => ((reviews += 1), { error: "unexpected" }),
    };
    const { events, emit } = recorder();
    const done = new SessionRunner({
      sessionId: createId(),
      projectPath,
      emit,
      signal: session.signal,
      runners: createStageRunners(
        deps(projectPath, { createExecutor: () => exec, createReviewer: () => counting }),
      ),
    }).run(spec);
    await until(() => release !== undefined);
    session.abort();
    const result = await done;

    expect(result).toMatchObject({ status: "cancelled", current: "build" });
    expect(exec.cancelled).toHaveLength(1);
    expect(reviews).toBe(0);
    expect(stageEvents(events)).toEqual([
      "start plan",
      "end plan pass",
      "start build",
      "start check",
      "end check cancelled",
      "end build cancelled",
    ]);
    expect(getEventListeners(session.signal, "abort")).toHaveLength(0);
  });

  it("a stage that throws fails the session with a terminal stage event, and resume retries it", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    const { events, emit } = recorder();
    const result = await new SessionRunner({
      sessionId,
      projectPath,
      emit,
      runners: createStageRunners(
        deps(projectPath, {
          createExecutor: () => {
            throw new Error("best-of-n is not available");
          },
        }),
      ),
    }).run(spec);

    expect(result).toMatchObject({ status: "failed", current: "build" });
    expect(result.reason).toContain('stage "build" failed: best-of-n is not available');
    expect(stageEvents(events)).toEqual([
      "start plan",
      "end plan pass",
      "start build",
      "start check",
      "end check failed",
      "end build failed",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "session.failed" });
    expect(await readGraph(projectPath, sessionId)).toMatchObject({ status: "failed", current: "build" });

    const retried = await new SessionRunner({
      sessionId,
      projectPath,
      runners: createStageRunners(deps(projectPath)),
    }).resume();
    expect(retried.status).toBe("completed");
  });

  it("a custom stage runner that throws is recorded as failed too", async () => {
    const { events, emit } = recorder();
    const result = await new SessionRunner({
      sessionId: createId(),
      emit,
      runners: stubRunners({
        negotiate: async () => {
          throw new TypeError("boom");
        },
      }),
    }).run(spec);
    expect(result.status).toBe("failed");
    expect(stageEvents(events)).toEqual(["start plan", "end plan failed"]);
  });

  it("session budget exhaustion stops the stage and the session as budget_exceeded", async () => {
    const projectPath = await tempProject();
    const scheduler = new SeatScheduler({ sessionId: "s", backoffBaseMs: 1, sessionBudget: { maxTokens: 10 } });
    const runStep: SeatStepRunner = async ({ reportUsage }) => {
      reportUsage({ tokensIn: 100 });
      return { proposal: "too expensive" };
    };
    const { events, emit } = recorder();
    const result = await new SessionRunner({
      sessionId: createId(),
      projectPath,
      emit,
      runners: createStageRunners(deps(projectPath, { scheduler, runStep })),
    }).run(spec);

    expect(result).toMatchObject({ status: "budget_exceeded", current: "plan" });
    expect(stageEvents(events)).toEqual(["start plan", "end plan budget"]);
    expect(events.at(-1)).toMatchObject({ type: "session.failed", data: { status: "budget_exceeded" } });
  });

  it("a Supervisor out of budget (not rounds) ends the session as budget_exceeded", async () => {
    const projectPath = await tempProject();
    const result = await new SessionRunner({
      sessionId: createId(),
      projectPath,
      runners: createStageRunners(deps(projectPath, { budgetLimits: { maxMessages: 0 } })),
    }).run(spec);
    expect(result).toMatchObject({ status: "budget_exceeded", current: "build" });
    expect(result.history.at(-1)).toMatchObject({ stageId: "build", outcome: "budget" });
  });
});

describe("invalid graphs", () => {
  const base = spec.stages;
  const graph = (stages: Array<Partial<StageSpec> & { id: string; kind: StageSpec["kind"] }>) => ({
    title: "t",
    goal: "g",
    stages,
  });

  it("reports cycles, unknown stages, misplaced reviews, unreachable stages and long ids", () => {
    expect(validateSessionGraph(spec)).toEqual([]);
    expect(
      validateSessionGraph(graph([{ id: "a", kind: "plan", next: "b" }, { id: "b", kind: "negotiate", next: "a" }])),
    ).toEqual(["next edges form a cycle: a → b → a"]);
    expect(validateSessionGraph(graph([{ id: "a", kind: "plan", next: "ghost" }]))[0]).toContain('unknown stage id "ghost"');
    expect(validateSessionGraph(graph([{ id: "a", kind: "plan", next: "a" }, { id: "b", kind: "plan" }]))).toEqual([
      "next edges form a cycle: a → a",
      'stage "b": unreachable from the first stage "a"',
    ]);
    expect(validateSessionGraph(graph([{ id: "x", kind: "execute" }]))).toContain(
      'stage "x": an execute stage\'s next must be a review stage',
    );
    expect(validateSessionGraph(graph([{ id: "p", kind: "plan", next: "r" }, { id: "r", kind: "review" }]))).toEqual(
      expect.arrayContaining([
        'stage "r": a review stage must be the next of exactly one execute stage',
        'stage "p": only an execute stage may lead to review stage "r"',
      ]),
    );
    expect(validateSessionGraph(graph([{ id: "p", kind: "plan", onNeedsWork: "p" }]))).toContain(
      'stage "p": onNeedsWork is only allowed on review stages',
    );
    expect(validateSessionGraph(graph([{ id: "p".repeat(41), kind: "plan" }]))[0]).toContain("longer than 40");
    expect(
      validateSessionGraph({ ...spec, stages: base.map((s) => (s.id === "check" ? { ...s, requireApproval: true } : s)) }),
    ).toEqual(['stage "check": a review stage runs with its execute stage; put requireApproval on that stage']);
  });

  it("run() rejects before emitting or writing anything", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    const { events, emit } = recorder();
    const cyclic = { ...spec, stages: base.map((s) => (s.id === "plan" ? { ...s, next: "plan" } : s)) };
    await expect(new SessionRunner({ sessionId, projectPath, emit, runners: stubRunners() }).run(cyclic)).rejects.toThrow(
      "invalid session graph",
    );
    expect(events).toEqual([]);
    await expect(fs.access(path.join(projectPath, ".assentor", "sessions", sessionId))).rejects.toThrow();
  });

  it("built-in runners reject unknown strategies, unknown teams and bad review options up front", async () => {
    const projectPath = await tempProject();
    const runners = createStageRunners(deps(projectPath));
    const bad = {
      ...spec,
      stages: base.map((s) =>
        s.id === "plan"
          ? { ...s, strategy: "no-such" }
          : s.id === "check"
            ? { ...s, team: "ghosts", options: { tiebreak: "negotiate", maxRounds: 0 } }
            : s,
      ),
    };
    const error = await new SessionRunner({ sessionId: createId(), runners }).run(bad).catch((e: Error) => e);
    expect(String(error)).toContain('stage "plan": unknown negotiation strategy "no-such"');
    expect(String(error)).toContain('stage "check": options.maxRounds must be an integer from 1 to 50');
    const noTeam = { ...spec, stages: base.map((s) => (s.id === "check" ? { ...s, team: "ghosts" } : s)) };
    await expect(new SessionRunner({ sessionId: createId(), runners }).run(noTeam)).rejects.toThrow('unknown team "ghosts"');
  });
});

describe("negotiated review tiebreak (Debate among reviewer seats)", () => {
  const issue = {
    id: "COR-1",
    severity: Severity.Major,
    description: "average([]) divides by zero",
    evidence: ["src/avg.ts:3"],
    affectedFiles: ["src/avg.ts"],
  };
  const findings: ReviewerFinding[] = [
    {
      agentId: "reviewers.critic-1",
      result: makeReviewResult({
        status: ReviewStatus.Pass,
        confidence: 0.9,
        summary: "fine",
        issues: [],
        requiredChanges: [],
        optionalChanges: [],
        evidenceRequests: [],
      }),
    },
    {
      agentId: "reviewers.critic-2",
      result: makeReviewResult({
        status: ReviewStatus.NeedsWork,
        confidence: 0.9,
        summary: "empty input",
        issues: [issue],
        requiredChanges: ["guard empty input"],
        optionalChanges: [],
        evidenceRequests: [],
      }),
    },
  ];
  const tiebreak = (runStep: SeatStepRunner) =>
    createDebateTiebreak({
      sessionId: "s",
      goal: "Implement average()",
      seats: teams.reviewers!,
      scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
      runStep,
      runIdPrefix: "check-2",
    });

  it("decides when the debate reaches consensus on a verdict, showing members anonymously", async () => {
    const runStep = debateRunner(() => "VERDICT: NEEDS_WORK\nThe empty case is real.");
    const ruling = await tiebreak(runStep)(findings);
    expect(ruling).toMatchObject({ status: "NEEDS_WORK", requiredChanges: ["guard empty input"] });
    expect(ruling!.summary).toContain("Negotiated tiebreak (debate)");
    const goal = runStep.proposeGoals[0]!;
    expect(goal).toContain("Reviewer 2: NEEDS_WORK — empty input");
    expect(goal).not.toContain("critic");
    expect((await tiebreak(debateRunner(() => "VERDICT: PASS\nok"))(findings))?.status).toBe("PASS");
  });

  it("cannot decide → undefined (the panel policy rules): no consensus, or no verdict line", async () => {
    expect(await tiebreak(debateRunner(() => "VERDICT: PASS", false))(findings)).toBeUndefined();
    expect(await tiebreak(debateRunner(() => "I think it is fine"))(findings)).toBeUndefined();
  });

  it("inside a panel: a tiebreak that cannot decide leaves the majority policy's NEEDS_WORK", async () => {
    const projectPath = await tempProject();
    const members = [
      { name: "r1", steps: [{ type: "pass" as const }] },
      { name: "r2", steps: [{ type: "needs_work" as const, requiredChanges: ["add tests"] }] },
    ];
    let disagreements = 0;
    const result = await new SessionRunner({
      sessionId: createId(),
      projectPath,
      runners: createStageRunners(
        deps(projectPath, {
          runStep: debateRunner((vars) => (String(vars.goal).startsWith("The review panel") ? "no verdict here" : "Plan")),
          createReviewer: (_stage, options) => {
            expect(options.tiebreak).toBe("negotiate");
            const hook = options.onDisagreement!;
            return panel(members, {
              ...options,
              onDisagreement: async (f: ReviewerFinding[]) => {
                disagreements += 1;
                return hook(f);
              },
            });
          },
        }),
      ),
    }).run(spec);
    expect(disagreements).toBe(1);
    // Round 1 split → tiebreak undecided → NEEDS_WORK; round 2 members default to PASS.
    expect(result.status).toBe("completed");
    const files = await fs.readdir(path.join(projectPath, ".assentor", "sessions"));
    const negotiations = await fs.readdir(path.join(projectPath, ".assentor", "sessions", files[0]!, "negotiations"));
    expect(negotiations.sort()).toEqual(["check-2-tiebreak-1.json", "plan-1.json"]);
  });
});
