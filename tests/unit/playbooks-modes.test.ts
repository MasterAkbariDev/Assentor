import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createId,
  expandSeatSpecs,
  getMode,
  MockReviewer,
  ModeValidationError,
  PanelReviewer,
  parseAssentorConfig,
  prepareModeSession,
  type AssentorConfig,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type SeatStepRunner,
  type StageRunnerDeps,
  type StageSpec,
} from "../../packages/engine/src/index.js";
import { validateSessionGraph } from "../../packages/engine/src/orchestrator/session-runner.js";
import { builtinPlaybook } from "../../packages/engine/src/modes/playbook-modes.js";
import { SeatScheduler } from "../../packages/engine/src/seats/index.js";

// Playbook-backed modes: pipeline, explore, plan (T02B-09).

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "playbook-modes-"));
  dirs.push(dir);
  return dir;
}

const GOAL = "Add a retry to the uploader";

const seat = (role: string, permissions: "read-only" | "edit" = "read-only") => ({ provider: "mock", role, permissions });

const TEAMS = {
  analysis: { seats: [seat("requirements-analyst"), seat("devils-advocate")] },
  design: { seats: [seat("architect"), seat("planner")] },
  builders: { seats: [seat("engineer", "edit"), seat("test-writer", "edit"), seat("docs-writer", "edit")] },
  reviewers: { seats: [seat("code-reviewer"), seat("security-reviewer")] },
  investigators: { seats: [seat("architect"), seat("test-reviewer"), seat("code-reviewer")] },
  summary: { seats: [seat("summarizer"), seat("devils-advocate")] },
  planning: { seats: [seat("planner"), seat("architect")] },
};

const config = parseAssentorConfig({ teams: TEAMS });

/** Seats of a stage's team in the config under test (not the module default). */
const seatsIn = (cfg: AssentorConfig) => (stage: StageSpec) => {
  const team = stage.team ? cfg.teams[stage.team] : undefined;
  if (!team) throw new Error(`unknown team "${stage.team}"`);
  return expandSeatSpecs(team.seats, { teamName: stage.team });
};

const debate: SeatStepRunner = async ({ step }) => {
  if (step === "negotiate-propose" || step === "negotiate-revise") return { proposal: "Retry three times with backoff" };
  if (step === "negotiate-critique") return { critiques: [] };
  if (step === "negotiate-agree") return { agree: true, preferred: "Proposal A", confidence: 1 };
  throw new Error(`unexpected step ${step}`);
};

function executor(prompts: string[]): Executor {
  return {
    name: "mock-executor",
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
    run: async (task: { prompt: string }) => {
      prompts.push(task.prompt);
      return { status: "completed", summary: "done" } as ExecutorResult;
    },
    continue: async () => ({ status: "completed", summary: "done" }) as ExecutorResult,
    cancel: async () => undefined,
  };
}

function deps(projectPath: string, over: Partial<StageRunnerDeps> = {}, cfg: AssentorConfig = config): StageRunnerDeps {
  return {
    projectPath,
    scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
    runStep: debate,
    seatsFor: seatsIn(cfg),
    createExecutor: () => executor([]),
    createReviewer: () =>
      new PanelReviewer({ name: "panel", policy: "majority", reviewers: [new MockReviewer({ name: "r1" })] }),
    supervisor: { skipGates: true },
    ...over,
  };
}

async function setup(id: string, over: { config?: AssentorConfig; prompts?: string[] } = {}) {
  const events: EngineEventDraft[] = [];
  const projectPath = await tempProject();
  let executors = 0;
  const prompts = over.prompts ?? [];
  const value = {
    mode: id,
    sessionId: createId(),
    goal: GOAL,
    autonomy: "supervised" as const,
    config: over.config ?? config,
    deps: deps(projectPath, { createExecutor: () => (executors++, executor(prompts)) }, over.config ?? config),
    emit: (e: EngineEventDraft) => void events.push(e),
  };
  return { value, events, projectPath, prompts, executors: () => executors };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function problems(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModeValidationError);
    return (error as ModeValidationError).problems;
  }
  throw new Error("expected a ModeValidationError");
}

const IDS = ["pipeline", "explore", "plan"] as const;

describe("playbook modes build valid session graphs", () => {
  it.each(IDS)("%s builds a spec that passes validateSessionGraph and names its playbook", (id) => {
    const spec = getMode(id)!.buildSession!({ goal: GOAL, title: "Title", autonomy: "supervised", config });
    expect(validateSessionGraph(spec)).toEqual([]);
    expect(spec).toMatchObject({ title: "Title", goal: GOAL, playbook: id });
  });

  it("pipeline: requirements → design → build (approval) → review, with onNeedsWork back to build", () => {
    const spec = getMode("pipeline")!.buildSession!({ goal: GOAL, title: "T", autonomy: "supervised", config });
    expect(spec.stages.map((s) => [s.id, s.kind, s.team, s.requireApproval ?? false, s.next ?? null])).toEqual([
      ["requirements", "plan", "analysis", false, "design"],
      ["design", "plan", "design", false, "build"],
      ["build", "execute", "builders", true, "review"],
      ["review", "review", "reviewers", false, null],
    ]);
    expect(spec.stages[3]).toMatchObject({ strategy: "panel", onNeedsWork: "build" });
  });

  it("explore: three investigators, then a summarizer with required citations", () => {
    const spec = getMode("explore")!.buildSession!({ goal: GOAL, title: "T", autonomy: "supervised", config });
    expect(spec.stages.map((s) => [s.id, s.kind, s.team, s.next ?? null])).toEqual([
      ["investigate", "negotiate", "investigators", "summarize"],
      ["summarize", "negotiate", "summary", null],
    ]);
    expect(spec.stages[1]!.options).toEqual({ citations: "required" });
  });

  it("plan: a planner and an architect debate for two rounds, output task cards", () => {
    const spec = getMode("plan")!.buildSession!({ goal: GOAL, title: "T", autonomy: "supervised", config });
    expect(spec.stages).toEqual([
      expect.objectContaining({ id: "plan", kind: "plan", team: "planning", strategy: "debate", options: { maxRounds: 2, output: "task-cards" } }),
    ]);
  });
});

describe("explore and plan are read-only", () => {
  it.each(["explore", "plan"] as const)("%s: no execute stage and only read-only seats in its playbook", (id) => {
    const spec = getMode(id)!.buildSession!({ goal: GOAL, title: "T", autonomy: "supervised", config });
    expect(spec.stages.some((s) => s.kind === "execute")).toBe(false);
    const playbook = builtinPlaybook(id);
    expect(playbook.readOnly).toBe(true);
    const seats = Object.values(playbook.teams).flatMap((t) => t.seats);
    expect(seats.length).toBeGreaterThan(0);
    expect(seats.every((s) => s.permissions === "read-only")).toBe(true);
  });

  it("a missing built-in playbook is a ModeValidationError, not a raw ENOENT", () => {
    expect(problems(() => builtinPlaybook("no-such-playbook"))).toEqual([
      expect.stringContaining('built-in playbook "no-such-playbook": cannot read'),
    ]);
  });

  it("pipeline, explore and plan are CLI-available; editsCode matches", () => {
    for (const id of IDS) expect(getMode(id)!.available).toBe(true);
    expect(getMode("explore")!.editsCode).toBe(false);
    expect(getMode("plan")!.editsCode).toBe(true);
  });
});

describe("each mode runs through prepareModeSession on mock seats", () => {
  it("explore: investigators debate, the summarizer answers; no executor is ever called", async () => {
    const { value, events, executors } = await setup("explore");
    const session = prepareModeSession(value);
    expect(session.spec?.stages.map((s) => s.id)).toEqual(["investigate", "summarize"]);
    const result = await session.run();
    expect(result).toMatchObject({ status: "completed", mode: "explore" });
    expect(executors()).toBe(0);
    expect(events[0]).toMatchObject({ type: "mode.selected", data: { mode: "explore" } });
    expect(events.filter((e) => e.type === "stage.started").map((e) => e.stageId)).toEqual(["investigate", "summarize"]);
  });

  it("plan: planner and architect debate; the decision is the plan; no executor is ever called", async () => {
    const { value, executors } = await setup("plan");
    const result = await prepareModeSession(value).run();
    expect(result).toMatchObject({ status: "completed", mode: "plan", plan: "Retry three times with backoff" });
    expect(executors()).toBe(0);
  });

  it("pipeline: the build waits for approval, then the build and the review panel run", async () => {
    const prompts: string[] = [];
    const { value, events } = await setup("pipeline", { prompts });
    const session = prepareModeSession(value);
    const done = session.run();
    await until(() => events.some((e) => e.type === "session.state" && e.data.to === "waiting"));
    expect(prompts).toEqual([]);
    expect(session.approve("build")).toBe(true);
    const result = await done;
    expect(result).toMatchObject({ status: "completed", mode: "pipeline" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(GOAL);
    expect(events.filter((e) => e.type === "stage.started").map((e) => e.stageId)).toEqual([
      "requirements",
      "design",
      "build",
      "review",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "session.completed" });
  });
});

describe("manual autonomy", () => {
  it.each(IDS)("%s: every non-review stage requires approval", async (id) => {
    const { value } = await setup(id);
    const spec = prepareModeSession({ ...value, autonomy: "manual" }).spec!;
    for (const stage of spec.stages) expect(stage.requireApproval ?? false).toBe(stage.kind !== "review");
  });
});

describe("cancel", () => {
  it("explore: aborting the signal during a debate cancels the session and calls no executor", async () => {
    const abort = new AbortController();
    const { value, events, executors } = await setup("explore");
    let started = false;
    value.deps = {
      ...value.deps,
      runStep: ({ signal }) => {
        started = true;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    };
    const running = prepareModeSession({ ...value, signal: abort.signal }).run();
    await until(() => started);
    abort.abort();
    expect(await running).toMatchObject({ status: "cancelled", mode: "explore" });
    expect(executors()).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "session.failed", data: { status: "cancelled" } });
  });
});

describe("invalid config is refused before anything runs", () => {
  const withTeams = (over: Record<string, unknown>) => parseAssentorConfig({ teams: { ...TEAMS, ...over } });

  it("a missing team is refused for pipeline", async () => {
    const { value, events, projectPath, executors } = await setup("pipeline", {
      config: parseAssentorConfig({ teams: Object.fromEntries(Object.entries(TEAMS).filter(([name]) => name !== "builders")) }),
    });
    expect(problems(() => prepareModeSession(value))).toEqual(['mode "pipeline" needs team "builders" in teams']);
    expect(events).toEqual([]);
    expect(executors()).toBe(0);
    await expect(fs.access(path.join(projectPath, ".assentor"))).rejects.toThrow();
  });

  it("pipeline's build stage needs an edit seat", async () => {
    const { value, events } = await setup("pipeline", {
      config: withTeams({ builders: { seats: [seat("engineer")] } }),
    });
    expect(problems(() => prepareModeSession(value))).toEqual(['team "builders" needs an edit seat for the "build" stage']);
    expect(events).toEqual([]);
  });

  it("explore refuses an edit seat in its team", async () => {
    const { value, events, executors } = await setup("explore", {
      config: withTeams({ investigators: { seats: [seat("architect"), seat("code-reviewer", "edit")] } }),
    });
    expect(problems(() => prepareModeSession(value))).toEqual([
      'team "investigators" has an edit seat, but mode "explore" is read-only',
    ]);
    expect(events).toEqual([]);
    expect(executors()).toBe(0);
  });

  it("plan refuses an edit seat and a missing team", async () => {
    const edit = await setup("plan", { config: withTeams({ planning: { seats: [seat("planner"), seat("architect", "edit")] } }) });
    expect(problems(() => prepareModeSession(edit.value))).toEqual([
      'team "planning" has an edit seat, but mode "plan" is read-only',
    ]);
    expect(edit.events).toEqual([]);

    const missing = await setup("plan", { config: parseAssentorConfig({ teams: {} }) });
    expect(problems(() => prepareModeSession(missing.value))).toEqual(['mode "plan" needs team "planning" in teams']);
    expect(missing.events).toEqual([]);
  });

  it("a debate team with one seat is refused by the stage check, not run", async () => {
    const { value, events, executors } = await setup("pipeline", {
      config: withTeams({ analysis: { seats: [seat("requirements-analyst")] } }),
    });
    expect(problems(() => prepareModeSession(value))).toEqual([
      'stage "requirements": debate needs at least two debating seats (not counting the moderator)',
    ]);
    expect(events).toEqual([]);
    expect(executors()).toBe(0);
  });
});
