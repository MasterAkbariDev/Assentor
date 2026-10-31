import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createId,
  expandSeatSpecs,
  getMode,
  listModes,
  MockReviewer,
  ModeValidationError,
  PanelReviewer,
  parseAssentorConfig,
  parseEngineEvent,
  prepareModeSession,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type ModeControllerInput,
  type ModeDefinition,
  type ModeSessionInput,
  type SeatStepRunner,
  type StageRunnerDeps,
  type StageSpec,
  type WorktreeManager,
} from "../../src/index.js";
import { SeatScheduler } from "../../src/seats/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mode-session-"));
  dirs.push(dir);
  return dir;
}

const GOAL = "Implement average()";

const config = parseAssentorConfig({
  teams: {
    planners: { seats: [{ provider: "mock", model: "planner", count: 2 }] },
    panel: { seats: [{ provider: "mock", model: "critic", count: 2, role: "code-reviewer" }] },
  },
  modes: { negotiate: { team: "planners", strategy: "debate", maxRounds: 1 } },
});

const seatsFor = (stage: StageSpec) => {
  const team = stage.team ? config.teams[stage.team] : undefined;
  if (!team) throw new Error(`unknown team "${stage.team}"`);
  return expandSeatSpecs(team.seats, { teamName: stage.team });
};

const debate: SeatStepRunner = async ({ step }) => {
  if (step === "negotiate-propose" || step === "negotiate-revise") return { proposal: "Sum, then divide by the count" };
  if (step === "negotiate-critique") return { critiques: [] };
  if (step === "negotiate-agree") return { agree: true, preferred: "Proposal A", confidence: 1 };
  throw new Error(`unexpected step ${step}`);
};

function executor(handle?: () => Promise<ExecutorResult>): Executor & { prompts: string[]; cancelled: number } {
  const prompts: string[] = [];
  const exec = {
    name: "mock-executor",
    prompts,
    cancelled: 0,
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
    run: async (task: { prompt: string }) => {
      prompts.push(task.prompt);
      return handle ? handle() : { status: "completed" as const, summary: "done" };
    },
    continue: async () => ({ status: "completed" as const, summary: "done" }),
    cancel: async () => {
      exec.cancelled += 1;
    },
  };
  return exec;
}

const passPanel = () => new PanelReviewer({ name: "panel", policy: "majority", reviewers: [new MockReviewer({ name: "r1" })] });

function deps(projectPath: string, over: Partial<StageRunnerDeps> = {}): StageRunnerDeps {
  return {
    projectPath,
    scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
    runStep: debate,
    seatsFor,
    createExecutor: () => executor(),
    createReviewer: () => passPanel(),
    supervisor: { skipGates: true },
    ...over,
  };
}

async function input(over: Partial<ModeSessionInput> & { deps?: StageRunnerDeps } = {}) {
  const events: EngineEventDraft[] = [];
  const projectPath = over.deps?.projectPath ?? (await tempProject());
  const value: ModeSessionInput = {
    mode: "solo",
    sessionId: createId(),
    goal: GOAL,
    autonomy: "supervised",
    config,
    deps: deps(projectPath),
    emit: (e) => void events.push(e),
    ...over,
  };
  return { value, events, projectPath };
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

/** A test definition for a dynamic mode. */
function dynamicMode(createController: ModeDefinition["createController"]): ModeDefinition {
  // Lead's own validate needs modes.lead; these tests run their own controller.
  const { validate: _leadValidate, ...lead } = getMode("lead")!;
  return { ...lead, createController };
}

describe("mode contract", () => {
  it("each mode's builder matches its kind; solo, review, negotiate, lead and tdd can run; only solo is CLI-available", () => {
    for (const mode of listModes()) {
      if (mode.kind === "static") expect(mode.createController).toBeUndefined();
      else expect(mode.buildSession).toBeUndefined();
    }
    expect(listModes().filter((m) => m.buildSession || m.createController).map((m) => m.id)).toEqual([
      "solo",
      "review",
      "negotiate",
      "lead",
      "cascade",
      "pipeline",
      "pair",
      "redteam",
      "tdd",
      "swarm",
      "debug",
      "explore",
      "plan",
    ]);
    expect(listModes().filter((m) => m.available).map((m) => m.id)).toEqual(["solo"]);
  });

  it("builds the static graphs from config", async () => {
    const { value } = await input();
    expect(prepareModeSession(value).spec?.stages.map((s) => [s.id, s.kind, s.strategy, s.requireApproval])).toEqual([
      ["execute", "execute", undefined, false],
      ["review", "review", "panel", false],
    ]);
    expect(prepareModeSession({ ...value, mode: "review" }).spec?.stages.map((s) => [s.id, s.strategy, s.options])).toEqual([
      ["existing-work", "existing-work", {}],
      ["review", "panel", { maxRounds: 1 }],
    ]);
    expect(prepareModeSession({ ...value, mode: "negotiate" }).spec?.stages).toMatchObject([
      { id: "negotiate", kind: "negotiate", team: "planners", strategy: "debate", options: { maxRounds: 1, consensus: 0.7 } },
    ]);
    const withPanel = parseAssentorConfig({ ...config, modes: { review: { team: "panel", tiebreak: "negotiate" } } });
    expect(prepareModeSession({ ...value, config: withPanel }).spec?.stages[1]).toMatchObject({
      team: "panel",
      options: { tiebreak: "negotiate" },
    });
  });
});

describe("runnable modes, end to end (mock seats)", () => {
  it("solo: execute ⇄ review through the stage graph, mode.selected first", async () => {
    const exec = executor();
    const { value, events, projectPath } = await input();
    value.deps = deps(projectPath, { createExecutor: () => exec });

    const result = await prepareModeSession(value).run();

    expect(result).toMatchObject({ status: "completed", mode: "solo", autonomy: "supervised" });
    expect(exec.prompts).toEqual([GOAL]);
    expect(events[0]).toMatchObject({ type: "mode.selected", data: { mode: "solo", kind: "static", autonomy: "supervised" } });
    expect(events.at(-1)).toMatchObject({ type: "session.completed" });
  });

  it("review: never calls the host executor; PASS completes, NEEDS_WORK blocks with the findings", async () => {
    let hostExecutors = 0;
    const { value, projectPath } = await input({ mode: "review" });
    value.deps = deps(projectPath, { createExecutor: () => (hostExecutors++, executor()) });
    expect(await prepareModeSession(value).run()).toMatchObject({ status: "completed", mode: "review" });

    const needsWork = await input({ mode: "review" });
    needsWork.value.deps = deps(needsWork.projectPath, {
      createExecutor: () => (hostExecutors++, executor()),
      createReviewer: () =>
        new MockReviewer({ name: "r", steps: [{ type: "needs_work", requiredChanges: ["handle an empty list"] }] }),
    });
    const blocked = await prepareModeSession(needsWork.value).run();
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toContain("review still needs work");
    expect(hostExecutors).toBe(0);
  });

  it("negotiate: the team's decision becomes the session plan", async () => {
    const { value } = await input({ mode: "negotiate" });
    const result = await prepareModeSession(value).run();
    expect(result).toMatchObject({ status: "completed", mode: "negotiate", plan: "Sum, then divide by the count" });
  });
});

describe("autonomy flows into the session, never above the configured level", () => {
  it("supervised: the Supervisor does not steer itself even when the host asks for autopilot", async () => {
    const exec = executor();
    const { value, projectPath } = await input();
    value.deps = deps(projectPath, { createExecutor: () => exec, supervisor: { skipGates: true, autopilot: true } });
    await prepareModeSession(value).run();
    expect(exec.prompts).toEqual([GOAL]);
  });

  it("autopilot: the Supervisor steers (autonomous task prompt)", async () => {
    const exec = executor();
    const { value, projectPath } = await input({ autonomy: "autopilot" });
    value.deps = deps(projectPath, { createExecutor: () => exec });
    const result = await prepareModeSession(value).run();
    expect(result.autonomy).toBe("autopilot");
    expect(exec.prompts[0]).not.toBe(GOAL);
    expect(exec.prompts[0]).toContain(GOAL);
  });

  it("manual: every non-review stage waits for approval", async () => {
    const exec = executor();
    const { value, events, projectPath } = await input({ autonomy: "manual" });
    value.deps = deps(projectPath, { createExecutor: () => exec });
    const session = prepareModeSession(value);
    expect(session.spec?.stages.map((s) => [s.id, s.requireApproval])).toEqual([
      ["execute", true],
      ["review", false],
    ]);

    const done = session.run();
    await until(() => events.some((e) => e.type === "session.state" && e.data.to === "waiting"));
    expect(exec.prompts).toEqual([]);
    expect(session.approve("execute")).toBe(true);
    expect(await done).toMatchObject({ status: "completed", autonomy: "manual" });
  });

  it("a dynamic controller gets the configured autonomy and the stage runners", async () => {
    let seen: ModeControllerInput | undefined;
    const { value } = await input({
      autonomy: "manual",
      mode: dynamicMode((controllerInput) => {
        seen = controllerInput;
        return { run: async () => ({ status: "completed" }) };
      }),
    });
    const result = await prepareModeSession(value).run();
    expect(result).toMatchObject({ status: "completed", mode: "lead", autonomy: "manual", history: [] });
    expect(seen).toMatchObject({ autonomy: "manual", goal: GOAL, title: GOAL });
    expect(typeof seen?.stages.execute).toBe("function");
  });
});

describe("failure paths", () => {
  it("an invalid mode config is refused before anything starts", async () => {
    let executors = 0;
    const { value, events, projectPath } = await input({ mode: "negotiate", config: parseAssentorConfig({}) });
    value.deps = deps(projectPath, { createExecutor: () => (executors++, executor()) });

    expect(problems(() => prepareModeSession(value))).toEqual([
      "negotiate mode needs modes.negotiate (team and strategy) in the config",
    ]);
    const unknownTeam = parseAssentorConfig({ modes: { review: { team: "ghosts" } } });
    expect(problems(() => prepareModeSession({ ...value, mode: "solo", config: unknownTeam }))[0]).toContain(
      'Unknown team "ghosts" in modes.review',
    );
    const unregistered = parseAssentorConfig({ ...config, modes: { negotiate: { team: "planners", strategy: "best-of-n" } } });
    expect(problems(() => prepareModeSession({ ...value, config: unregistered }))).toEqual([
      'stage "negotiate": unknown negotiation strategy "best-of-n"',
    ]);

    expect(events).toEqual([]);
    expect(executors).toBe(0);
    await expect(fs.access(path.join(projectPath, ".assentor"))).rejects.toThrow();
  });

  it("a mode that cannot run, an unknown mode or autonomy, and an empty goal are refused", async () => {
    const { value, events } = await input();
    expect(problems(() => prepareModeSession({ ...value, mode: "interactive" }))).toEqual([
      'mode "interactive" cannot run yet (no createController)',
    ]);
    expect(problems(() => prepareModeSession({ ...value, mode: "lead" }))).toEqual([
      "lead mode needs modes.lead with at least lead: { provider, model } in the config",
    ]);
    expect(problems(() => prepareModeSession({ ...value, resume: true }))).toEqual([
      "a static session resumes through SessionRunner.resume, not resume",
    ]);
    expect(problems(() => prepareModeSession({ ...value, mode: "race" }))).toEqual([
      'mode "race" cannot run yet (no buildSession)',
    ]);
    expect(
      problems(() => prepareModeSession({ ...value, mode: "nope", autonomy: "yolo" as never, goal: " " })),
    ).toEqual(['unknown mode "nope"', 'unknown autonomy "yolo"', "the goal is empty"]);
    expect(events).toEqual([]);
  });

  it("an invalid session id is refused for static and dynamic modes before anything runs", async () => {
    let controllers = 0;
    for (const mode of ["solo", dynamicMode(() => (controllers++, { run: async () => ({ status: "completed" }) }))]) {
      const { value, events } = await input({ mode, sessionId: "../../evil" });
      expect(problems(() => prepareModeSession(value))).toEqual(['invalid session id "../../evil"']);
      expect(events).toEqual([]);
    }
    expect(controllers).toBe(0);
  });

  it("a reused session id is refused before mode.selected reaches that session's log", async () => {
    const first = await input();
    await prepareModeSession(first.value).run();
    const events: EngineEventDraft[] = [];
    const again = prepareModeSession({
      ...first.value,
      deps: deps(first.projectPath),
      emit: (e) => void events.push(e),
    });
    await expect(again.run()).rejects.toThrow(/already has a stage graph/);
    expect(events).toEqual([]);
  });

  it("only review mode may skip the executor with existing-work", async () => {
    let hostExecutors = 0;
    const pipeline: ModeDefinition = {
      ...getMode("race")!,
      buildSession: ({ goal, title }) => ({
        title,
        goal,
        stages: [
          { id: "implement", kind: "execute", strategy: "existing-work", next: "review" },
          { id: "review", kind: "review", strategy: "panel" },
        ],
      }),
    };
    const { value, events, projectPath } = await input({ mode: pipeline });
    value.deps = deps(projectPath, { createExecutor: () => (hostExecutors++, executor()) });
    expect(problems(() => prepareModeSession(value))).toEqual([
      'stage "implement": strategy "existing-work" (no executor) is only for review mode',
    ]);
    expect(events).toEqual([]);
    expect(hostExecutors).toBe(0);
  });

  it("a controller that throws fails the session with terminal events", async () => {
    for (const mode of [
      dynamicMode(() => ({ run: async () => Promise.reject(new Error("lead crashed")) })),
      dynamicMode(() => {
        throw new Error("no lead seat");
      }),
      dynamicMode(() => ({ run: async () => ({ status: "done" }) as never })),
    ]) {
      const { value, events } = await input({ mode });
      const result = await prepareModeSession(value).run();
      expect(result.status).toBe("failed");
      expect(events.map((e) => e.type)).toEqual(["mode.selected", "session.created", "session.state", "session.failed"]);
    }
    const { value } = await input({ mode: dynamicMode(() => ({ run: async () => Promise.reject(new Error("lead crashed")) })) });
    const session = prepareModeSession(value);
    expect((await session.run()).reason).toBe("controller failed: lead crashed");
    await expect(session.run()).rejects.toThrow(/runs once/);
  });

  it("cancel: a dynamic controller's late result is not trusted; a static session cancels its executor", async () => {
    const abort = new AbortController();
    const { value, events } = await input({
      signal: abort.signal,
      mode: dynamicMode(({ signal }) => ({
        run: () =>
          new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "completed" }), { once: true })),
      })),
    });
    const running = prepareModeSession(value).run();
    await until(() => events.some((e) => e.type === "session.created"));
    abort.abort();
    expect(await running).toMatchObject({ status: "cancelled", reason: "cancelled" });
    expect(events.at(-1)).toMatchObject({ type: "session.failed", data: { status: "cancelled" } });

    const stop = new AbortController();
    let release: (() => void) | undefined;
    const exec = executor(() => new Promise((resolve) => (release = () => resolve({ status: "cancelled", summary: "stopped" }))));
    exec.cancel = async () => {
      exec.cancelled += 1;
      release?.();
    };
    const solo = await input({ signal: stop.signal });
    solo.value.deps = deps(solo.projectPath, { createExecutor: () => exec });
    const soloRun = prepareModeSession(solo.value).run();
    await until(() => release !== undefined);
    stop.abort();
    expect(await soloRun).toMatchObject({ status: "cancelled", mode: "solo" });
    expect(exec.cancelled).toBe(1);

    const already = await input({ signal: AbortSignal.abort(), mode: dynamicMode(() => ({ run: async () => ({ status: "completed" }) })) });
    expect(await prepareModeSession(already.value).run()).toMatchObject({ status: "cancelled" });
  });
});

describe("autonomy floor for dynamic modes (T02B-02)", () => {
  /** A dynamic session whose controller runs `body`; user questions are answered by `reply` (undefined = leave open). */
  async function dynamic(
    autonomy: ModeSessionInput["autonomy"],
    body: (input: ModeControllerInput) => Promise<unknown>,
    reply: (question: { questionId: string; question: string; kind: string }) => string | undefined,
    over: Partial<ModeSessionInput> = {},
  ) {
    const asked: Array<{ questionId: string; question: string; kind: string }> = [];
    let session: ReturnType<typeof prepareModeSession> | undefined;
    const { value, events } = await input({
      autonomy,
      mode: dynamicMode((controllerInput) => ({
        run: async () => {
          await body(controllerInput);
          return { status: "completed" };
        },
      })),
      ...over,
    });
    value.emit = (e) => {
      events.push(e);
      if (e.type !== "user.question") return;
      const q = e.data as { questionId: string; question: string; kind: string };
      asked.push(q);
      const answer = reply(q);
      if (answer !== undefined) queueMicrotask(() => session!.answer(q.questionId, answer));
    };
    session = prepareModeSession(value);
    return { session, asked, events, result: () => session!.run() };
  }

  const stageInput = (controllerInput: ModeControllerInput) => ({
    sessionId: controllerInput.sessionId,
    stage: { id: "execute", kind: "execute" as const, options: {}, requireApproval: false },
    review: { id: "review", kind: "review" as const, options: {}, requireApproval: false },
    goal: GOAL,
    attempt: 1,
    signal: controllerInput.signal,
    emit: controllerInput.emit,
  });

  it("manual: stages.execute waits for approval; a denial blocks it without running the executor", async () => {
    const exec = executor();
    const outcomes: unknown[] = [];
    let n = 0;
    const s = await dynamic(
      "manual",
      async (ci) => {
        outcomes.push(await ci.stages.execute(stageInput(ci)));
        outcomes.push(await ci.stages.execute(stageInput(ci)));
      },
      () => ((n += 1) === 1 ? "deny" : "approve"),
      { deps: deps(await tempProject(), { createExecutor: () => exec }) },
    );
    expect(await s.result()).toMatchObject({ status: "completed" });
    expect(outcomes[0]).toEqual({ outcome: "blocked", summary: "the user did not approve this stage" });
    expect(outcomes[1]).toMatchObject({ outcome: "pass" });
    expect(exec.prompts).toHaveLength(1);
    expect(s.asked.map((q) => q.kind)).toEqual(["approval", "approval"]);
    expect(s.events.filter((e) => e.type === "user.answer").map((e) => (e.data as { answer: string }).answer)).toEqual(["deny", "approve"]);
  });

  it("manual: an executor from deps asks before its first run; a stage approved up front does not ask again", async () => {
    const results: string[] = [];
    let n = 0;
    const s = await dynamic(
      "manual",
      async (ci) => {
        const stage = { id: "work", kind: "execute" as const, options: {}, requireApproval: false };
        const task = { taskId: "t", projectPath: ci.deps.projectPath, contract: { goal: GOAL } as never, prompt: "go" };
        results.push((await ci.deps.createExecutor(stage).run(task)).status); // asks, denied
        const pre = { ...stage, id: "pre" };
        expect(await ci.requestApproval({ question: "Start pre?", stageId: pre.id })).toBe(true);
        const ex = ci.deps.createExecutor(pre);
        results.push((await ex.run(task)).status, (await ex.continue({ ...task, messages: [] })).status);
      },
      () => ((n += 1) === 1 ? "deny" : "approve"),
    );
    await s.result();
    expect(results).toEqual(["failed", "completed", "completed"]);
    expect(s.asked.map((q) => q.question)).toEqual(['Start work "work" (mock-executor)?', "Start pre?"]);
  });

  it("manual: the host's output watcher receives the inner executor, not the gated wrapper", async () => {
    const exec = executor();
    const watched: unknown[] = [];
    let created: unknown;
    const s = await dynamic(
      "manual",
      async (ci) => {
        created = ci.deps.createExecutor({ id: "work", kind: "execute", options: {}, requireApproval: false });
        const stop = ci.host.watchExecutorOutput!(created as never, () => undefined);
        expect(stop).toBeTypeOf("function");
      },
      () => "approve",
      {
        deps: deps(await tempProject(), { createExecutor: () => exec }),
        host: { watchExecutorOutput: (executor) => (watched.push(executor), () => undefined) },
      },
    );
    await s.result();
    expect(created).not.toBe(exec);
    expect(watched).toEqual([exec]);
  });

  it("supervised: stages run without asking; applying to main asks and a denial throws before anything lands", async () => {
    const applied: unknown[] = [];
    const fake = {
      create: async () => ({}),
      diff: async () => ({ files: ["a.txt"] }),
      list: async () => [],
      applyTo: async (target: unknown) => (applied.push(target), { ok: true, strategy: "squash", changed: true }),
    } as unknown as WorktreeManager;
    const seat = { sessionId: createId(), seatId: "agent-1.w1" };
    const errors: string[] = [];
    const s = await dynamic(
      "supervised",
      async (ci) => {
        expect(await ci.stages.execute(stageInput(ci))).toMatchObject({ outcome: "pass" });
        await ci.worktrees!.applyTo("main", seat, { strategy: "squash" }).catch((e: Error) => errors.push(e.message));
        await ci.worktrees!.applyTo("main", seat, { strategy: "squash" });
        await ci.worktrees!.applyTo({ ...seat, seatId: "other" }, seat, { strategy: "squash" });
      },
      (q) => (q.question.includes("Apply") && errors.length === 0 ? "deny" : "approve"),
      { worktrees: fake },
    );
    await s.result();
    expect(errors).toEqual(["the user did not approve applying agent-1.w1 to the main checkout"]);
    expect(applied).toEqual(["main", { ...seat, seatId: "other" }]);
    expect(s.asked).toHaveLength(2);

    const auto = await dynamic("autopilot", (ci) => ci.worktrees!.applyTo("main", seat, { strategy: "squash" }), () => "deny", { worktrees: fake });
    await auto.result();
    expect(auto.asked).toEqual([]);
  });

  it("answer() checks ids and options; cancel resolves open questions", async () => {
    const abort = new AbortController();
    let answer: string | undefined = "pending";
    const s = await dynamic(
      "supervised",
      async (ci) => {
        answer = await ci.ask({ question: "Pick", options: ["a", "b"] });
      },
      () => undefined,
      { signal: abort.signal },
    );
    const done = s.result();
    await until(() => s.asked.length === 1);
    const id = s.asked[0]!.questionId;
    expect(s.session.answer("nope", "a")).toBe(false);
    expect(s.session.answer(id, "c")).toBe(false);
    expect(s.session.approve(id)).toBe(false); // not an approval question
    expect(s.events.filter((e) => e.type === "session.state").at(-1)?.data).toMatchObject({ to: "waiting" });
    abort.abort();
    expect(await done).toMatchObject({ status: "cancelled" });
    expect(answer).toBeUndefined();
    // No waiting → running after the terminal state.
    const states = s.events.filter((e) => e.type === "session.state").map((e) => (e.data as { to: string }).to);
    expect(states.at(-1)).toBe("cancelled");
    expect(s.session.answer(id, "a")).toBe(false);
  });
});

describe("free-text answers (T02B-02)", () => {
  it("refuse empty and over-2000-character answers; accept a trimmed one", async () => {
    let session: ReturnType<typeof prepareModeSession> | undefined;
    let id = "";
    let got: string | undefined;
    const { value, events } = await input({
      mode: dynamicMode((ci) => ({
        run: async () => {
          got = await ci.ask({ question: "Why?" });
          return { status: "completed" };
        },
      })),
    });
    value.emit = (e) => {
      events.push(e);
      if (e.type === "user.question") id = (e.data as unknown as { questionId: string }).questionId;
    };
    session = prepareModeSession(value);
    const done = session.run();
    await until(() => id !== "");
    expect(session.answer(id, "   ")).toBe(false);
    expect(session.answer(id, "x".repeat(2001))).toBe(false);
    expect(session.answer(id, ` ${"y".repeat(1999)} `)).toBe(true);
    expect(await done).toMatchObject({ status: "completed" });
    expect(got).toBe("y".repeat(1999));
  });
});

describe("mode events (modes.md §8)", () => {
  const envelope = { seq: 1, sessionId: "s", at: new Date().toISOString() };
  it("accepts the new event types and checks their payloads", () => {
    expect(parseEngineEvent({ ...envelope, type: "mode.selected", data: { mode: "lead", kind: "dynamic", autonomy: "manual" } }).type).toBe(
      "mode.selected",
    );
    expect(parseEngineEvent({ ...envelope, type: "lead.action", data: { action: "assign", accepted: false, reason: "over budget" } }).data).toMatchObject({
      accepted: false,
    });
    expect(parseEngineEvent({ ...envelope, type: "task.rejected", data: { taskId: "t1", reason: "no tests", extra: 1 } }).data).toMatchObject({
      extra: 1,
    });
    expect(() => parseEngineEvent({ ...envelope, type: "task.assigned", data: { taskId: "t1" } })).toThrow();
    expect(() => parseEngineEvent({ ...envelope, type: "tdd.gate", data: { gate: "C", passed: true } })).toThrow();
    expect(() => parseEngineEvent({ ...envelope, type: "mode.selected", data: { mode: "solo", kind: "static", autonomy: "yolo" } })).toThrow();
  });
});
