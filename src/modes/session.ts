import { promises as fs } from "node:fs";
import type { AssentorConfig } from "../config/schema.js";
import { createId, isId } from "../core/ids.js";
import { AutonomySchema, type Autonomy } from "../core/run-mode.js";
import { SessionSpecSchema, type SessionSpec } from "../core/seats.js";
import {
  SessionRunner,
  validateSessionGraph,
  type SessionRunResult,
  type StageRunners,
} from "../orchestrator/session-runner.js";
import { createStageRunners, type StageRunnerDeps } from "../orchestrator/session-stages.js";
import type { EngineEventDraft } from "../protocol/events.js";
import type { Executor, ExecutorResult } from "../providers/executors/types.js";
import { WorktreeError, type WorktreeManager } from "../worktrees/manager.js";
import {
  EXISTING_WORK_STRATEGY,
  getMode,
  type ControllerWorktrees,
  type ModeControllerInput,
  type ModeDefinition,
  type ModeHostServices,
  type ModeId,
  type SessionSpecInput,
} from "./registry.js";

/**
 * Runs any registered mode through its contract (T02B-01): `prepareModeSession`
 * validates everything and starts nothing; `run()` starts it.
 *
 * - static modes: `buildSession` → autonomy applied → `SessionRunner` (T02-09)
 *   with the built-in stage runners;
 * - dynamic modes: `createController` → `controller.run()`, with the same
 *   lifecycle events a stage graph emits.
 *
 * Autonomy never exceeds the configured level: `manual` puts an approval gate on
 * every non-review stage, and the Supervisor steers itself only under
 * `autopilot`, whatever the host's `deps.supervisor.autopilot` says.
 *
 * Dynamic modes get the same floor around the controller, enforced here and not
 * trusted to it (T02B-02): under `manual` every `stages` call and the first run of
 * every executor from `deps.createExecutor` wait for the user's approval; under
 * `manual` and `supervised` every `worktrees.applyTo("main")` does. Read-only
 * work (model asks, reviews, diffs) is not gated. Questions go out as
 * `user.question` events with a `questionId`; the host answers with `answer()`
 * (or `approve()` for a yes). A dynamic `resume` goes through here too, so the
 * floor is re-applied from the autonomy given now, never from saved state. Any
 * future resume path must do the same.
 *
 * Host duties are those of `SessionRunner`: a per-session lock, a grace timeout
 * for work that ignores abort, and a UUID `sessionId` (the graph is persisted
 * under `deps.projectPath`).
 */

export interface ModeSessionInput {
  /** Mode id or alias, or a definition (tests, modes not in the registry yet). */
  mode: string | ModeDefinition;
  sessionId: string;
  goal: string;
  /** Default: the goal's first line, cut to 80 characters. */
  title?: string;
  /** The configured autonomy (CLI flag over config); the session never runs with more. */
  autonomy: Autonomy;
  config: AssentorConfig;
  /** Stage runner dependencies; also handed to dynamic controllers. */
  deps: StageRunnerDeps;
  worktrees?: WorktreeManager;
  signal?: AbortSignal;
  /** Session events; must not throw (errors are swallowed). */
  emit?: (draft: EngineEventDraft) => void;
  /** See `SessionRunnerOptions.maxStageVisits`. */
  maxStageVisits?: number;
  /** Dynamic modes: model calls and roster for the controller (Lead). */
  host?: ModeHostServices;
  /** Dynamic modes: continue the state the mode persisted for this `sessionId`. */
  resume?: boolean;
}

export interface ModeRunResult extends SessionRunResult {
  mode: ModeId;
  autonomy: Autonomy;
}

export interface PreparedModeSession {
  readonly mode: ModeDefinition;
  readonly autonomy: Autonomy;
  /** Static modes: the graph that will run, approval gates included. */
  readonly spec?: SessionSpec;
  /** Starts the session. Call once. */
  run(): Promise<ModeRunResult>;
  /**
   * Static: releases a session waiting on `stageId`'s approval gate. Dynamic:
   * approves the pending approval question with this id. False otherwise.
   */
  approve(stageId: string): boolean;
  /**
   * Dynamic: answers the pending question `questionId` (from its `user.question`
   * event). An approval takes "approve" or "deny"; a question with options takes
   * one of them (any case); other questions any text up to 2000 characters. False
   * (nothing changes) for an unknown id or an answer that does not fit.
   */
  answer(questionId: string, answer: string): boolean;
}

/** Every reason a mode cannot start; nothing was started. */
export class ModeValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`cannot start the session:\n- ${problems.join("\n- ")}`);
    this.name = "ModeValidationError";
  }
}

/** Validates the mode, its config and (static) its graph. Throws `ModeValidationError`; starts nothing. */
export function prepareModeSession(input: ModeSessionInput): PreparedModeSession {
  const mode = typeof input.mode === "string" ? getMode(input.mode) : input.mode;
  const level = AutonomySchema.safeParse(input.autonomy);
  const problems: string[] = [];
  if (!mode) problems.push(`unknown mode "${String(input.mode)}"`);
  if (!level.success) problems.push(`unknown autonomy ${JSON.stringify(input.autonomy)}`);
  if (!input.goal?.trim()) problems.push("the goal is empty");
  // Session ids become paths (graph, event log); check before a controller or emit sees one.
  if (!isId(input.sessionId)) problems.push(`invalid session id ${JSON.stringify(input.sessionId)}`);
  if (input.resume && mode?.kind === "static") problems.push("a static session resumes through SessionRunner.resume, not resume");
  if (!mode || !level.success || problems.length > 0) throw new ModeValidationError(problems);
  const autonomy = level.data;

  const builder = mode.kind === "static" ? "buildSession" : "createController";
  if (!mode[builder]) {
    throw new ModeValidationError([`mode "${mode.id}" cannot run yet (no ${builder})`]);
  }
  problems.push(...(mode.validate?.(input.config) ?? []));
  if (problems.length > 0) throw new ModeValidationError(problems);

  const deps: StageRunnerDeps = {
    ...input.deps,
    supervisor: { ...input.deps.supervisor, autopilot: autonomy === "autopilot" },
    // Only review may skip the executor; staticSpec refuses the strategy in any other mode.
    createExecutor: (stage) =>
      mode.id === "review" && stage.strategy === EXISTING_WORK_STRATEGY
        ? existingWorkExecutor()
        : input.deps.createExecutor(stage),
  };
  const stages = createStageRunners(deps);
  const title = input.title?.trim() || input.goal.trim().split("\n")[0]!.slice(0, 80);
  const buildInput = { goal: input.goal, title, autonomy, config: input.config };
  const emit = (draft: EngineEventDraft) => {
    try {
      input.emit?.(draft);
    } catch {
      // Observability must never break a session.
    }
  };
  let started = false;
  const claim = () => {
    if (started) throw new Error("a prepared mode session runs once; prepare a new one");
    started = true;
  };
  const selected = () =>
    emit({ type: "mode.selected", sessionId: input.sessionId, data: { mode: mode.id, kind: mode.kind, autonomy } });

  if (mode.kind === "static") {
    const spec = staticSpec(mode.buildSession!(buildInput), autonomy, stages.validate, mode.id);
    const runner = new SessionRunner({
      sessionId: input.sessionId,
      projectPath: deps.projectPath,
      runners: stages,
      emit,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.maxStageVisits !== undefined ? { maxStageVisits: input.maxStageVisits } : {}),
    });
    return {
      mode,
      autonomy,
      spec,
      approve: (stageId) => runner.approve(stageId),
      answer: () => false,
      run: async () => {
        claim();
        // SessionRunner.run refuses an existing graph too, but only after we would have emitted.
        const file = runner.graphFile;
        if (file && (await fs.stat(file).catch(() => undefined))) {
          throw new Error(`session ${input.sessionId} already has a stage graph; use resume()`);
        }
        selected();
        return { ...(await runner.run(spec)), mode: mode.id, autonomy };
      },
    };
  }

  const signal = input.signal ?? new AbortController().signal;
  const questions = createQuestions(input.sessionId, signal, emit);
  /** Stage ids the user approved through `requestApproval({ stageId })`; their executors start without asking again. */
  const approvedStages = new Set<string>();
  const requestApproval: ModeControllerInput["requestApproval"] = async ({ question, stageId }) => {
    const approved = (await questions.ask(question, APPROVAL_OPTIONS, true)) === "approve";
    if (approved && stageId !== undefined) approvedStages.add(stageId);
    return approved;
  };

  return {
    mode,
    autonomy,
    approve: (questionId) => questions.answer(questionId, "approve", true),
    answer: (questionId, answer) => questions.answer(questionId, answer, false),
    run: async () => {
      claim();
      selected();
      const { sessionId } = input;
      const finish = (status: SessionRunResult["status"], reason?: string): ModeRunResult => {
        // Open questions settle first, so no waiting → running follows the terminal state.
        questions.closeAll();
        emit({ type: "session.state", sessionId, data: { to: status, ...(reason ? { reason } : {}) } });
        const data = { status, ...(reason ? { reason } : {}) };
        emit(
          status === "completed"
            ? { type: "session.completed", sessionId, data }
            : status === "blocked"
              ? { type: "session.blocked", sessionId, data }
              : { type: "session.failed", sessionId, data },
        );
        return { status, ...(reason ? { reason } : {}), history: [], mode: mode.id, autonomy };
      };

      emit({ type: "session.created", sessionId, data: { title } });
      if (signal.aborted) return finish("cancelled", "cancelled");
      try {
        const manual = autonomy === "manual";
        const controller = mode.createController!({
          ...buildInput,
          sessionId,
          stages: manual ? gateStages(stages, requestApproval) : stages,
          deps: manual
            ? {
                ...deps,
                createExecutor: (stage) =>
                  gateExecutor(deps.createExecutor(stage), stage.id, () => approvedStages.has(stage.id), requestApproval),
              }
            : deps,
          host: input.host ?? {},
          requestApproval,
          ask: ({ question, options }) => questions.ask(question, options, false),
          resume: input.resume ?? false,
          signal,
          emit,
          ...(input.worktrees ? { worktrees: gateWorktrees(input.worktrees, autonomy, requestApproval) } : {}),
        });
        const result = await controller.run();
        // Like a stage: a result that arrives while cancelling is not trusted.
        if (signal.aborted) return finish("cancelled", "cancelled");
        if (!["completed", "blocked", "budget_exceeded"].includes(result?.status)) {
          return finish("failed", `controller returned an unknown status ${JSON.stringify(result?.status)}`);
        }
        return finish(result.status, result.reason);
      } catch (error) {
        if (signal.aborted) return finish("cancelled", "cancelled");
        return finish("failed", `controller failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        questions.closeAll();
      }
    },
  };
}

const APPROVAL_OPTIONS = ["approve", "deny"] as const;
const MAX_ANSWER_LENGTH = 2000;

/**
 * Pending user questions of one dynamic session. Each goes out as `user.question`
 * with a `questionId`; the session shows `waiting` while any is open. A cancel
 * (or the controller ending) resolves the open ones with undefined.
 */
function createQuestions(sessionId: string, signal: AbortSignal, emit: (draft: EngineEventDraft) => void) {
  const pending = new Map<string, { options?: readonly string[]; approval: boolean; settle(answer?: string): void }>();
  let closed = false;
  return {
    ask(question: string, options: readonly string[] | undefined, approval: boolean): Promise<string | undefined> {
      if (signal.aborted || closed) return Promise.resolve(undefined);
      // Unique across resumes of the same session, so a replayed log never pairs an old question with a new answer.
      const questionId = createId();
      return new Promise((resolve) => {
        const settle = (answer?: string) => {
          if (!pending.delete(questionId)) return;
          signal.removeEventListener("abort", onAbort);
          if (answer !== undefined) emit({ type: "user.answer", sessionId, data: { questionId, answer } });
          if (pending.size === 0 && !signal.aborted && !closed) emit({ type: "session.state", sessionId, data: { from: "waiting", to: "running" } });
          resolve(answer);
        };
        const onAbort = () => settle();
        pending.set(questionId, { ...(options ? { options } : {}), approval, settle });
        signal.addEventListener("abort", onAbort, { once: true });
        if (pending.size === 1) emit({ type: "session.state", sessionId, data: { from: "running", to: "waiting", reason: question.slice(0, 200) } });
        emit({
          type: "user.question",
          sessionId,
          data: { questionId, question, ...(options ? { options: [...options] } : {}), kind: approval ? "approval" : "question" },
        });
      });
    },
    /** `approvalOnly`: `approve()` may answer approval questions only. */
    answer(questionId: string, raw: string, approvalOnly: boolean): boolean {
      const entry = pending.get(questionId);
      if (!entry || (approvalOnly && !entry.approval) || typeof raw !== "string") return false;
      const text = raw.trim();
      if (!text || text.length > MAX_ANSWER_LENGTH) return false;
      const answer = entry.options ? entry.options.find((o) => o.toLowerCase() === text.toLowerCase()) : text;
      if (answer === undefined) return false;
      entry.settle(answer);
      return true;
    },
    closeAll(): void {
      closed = true;
      for (const entry of [...pending.values()]) entry.settle();
    },
  };
}

/** `manual`: every stage call waits for approval; a denial ends the stage `blocked` without running it. */
function gateStages(stages: StageRunners, approve: ModeControllerInput["requestApproval"]): StageRunners {
  const denied = { outcome: "blocked" as const, summary: "the user did not approve this stage" };
  return {
    ...stages,
    negotiate: async (input) =>
      (await approve({ question: `Start stage "${input.stage.id}" (${input.stage.kind})?` })) ? stages.negotiate(input) : denied,
    execute: async (input) =>
      (await approve({ question: `Start stage "${input.stage.id}" (execute)?` })) ? stages.execute(input) : denied,
  };
}

/**
 * `manual`: the executor's first run (or continue) waits for approval, unless the
 * user already approved its stage id; a denial fails it without running. A turn
 * cancelled while it waits never starts.
 */
function gateExecutor(
  executor: Executor,
  stageId: string,
  preapproved: () => boolean,
  approve: ModeControllerInput["requestApproval"],
): Executor {
  let approval: Promise<boolean> | undefined;
  const allowed = () =>
    (approval ??= preapproved() ? Promise.resolve(true) : approve({ question: `Start work "${stageId}" (${executor.name})?`, stageId }));
  const cancelled = new Set<string>();
  const denied = { status: "failed" as const, summary: "the user did not approve starting this work", error: "not approved" };
  const gate = async (taskId: string, start: () => Promise<ExecutorResult>): Promise<ExecutorResult> => {
    if (!(await allowed())) return denied;
    if (cancelled.has(taskId)) return { status: "cancelled", summary: "cancelled before it started" };
    return start();
  };
  const gated: Executor = {
    name: executor.name,
    capabilities: () => executor.capabilities(),
    run: (task) => gate(task.taskId, () => executor.run(task)),
    continue: (task) => gate(task.taskId, () => executor.continue(task)),
    cancel: async (taskId) => {
      cancelled.add(taskId);
      await executor.cancel(taskId);
    },
  };
  if (executor.setModel) gated.setModel = (model) => executor.setModel!(model);
  if (executor.interrupt) gated.interrupt = () => executor.interrupt!();
  return gated;
}

/** Applying to the main checkout asks first unless `autopilot`; a denial throws and changes nothing. */
function gateWorktrees(
  worktrees: WorktreeManager,
  autonomy: Autonomy,
  approve: ModeControllerInput["requestApproval"],
): ControllerWorktrees {
  return {
    create: (seat, baseRef) => worktrees.create(seat, baseRef),
    diff: (seat) => worktrees.diff(seat),
    list: (sessionId) => worktrees.list(sessionId),
    applyTo: async (target, seat, options) => {
      if (target === "main" && autonomy !== "autopilot") {
        const { files } = await worktrees.diff(seat);
        const what = options.message ? `"${options.message.slice(0, 200)}" ` : "";
        const question = `Apply ${what}(${files.length} file${files.length === 1 ? "" : "s"} from ${seat.seatId}) to your branch (${options.strategy})?`;
        if (!(await approve({ question }))) {
          throw new WorktreeError(`the user did not approve applying ${seat.seatId} to the main checkout`);
        }
      }
      return worktrees.applyTo(target, seat, options);
    },
  };
}

/** The built graph with the autonomy floor applied, validated like `SessionRunner.run` does. */
function staticSpec(
  built: SessionSpecInput,
  autonomy: Autonomy,
  validateStage: ReturnType<typeof createStageRunners>["validate"],
  modeId: ModeId,
): SessionSpec {
  const gated =
    autonomy === "manual"
      ? { ...built, stages: built.stages.map((s) => (s.kind === "review" ? s : { ...s, requireApproval: true })) }
      : built;
  const problems = validateSessionGraph(gated);
  if (problems.length > 0) throw new ModeValidationError(problems);
  const spec = SessionSpecSchema.parse(gated);
  for (const stage of spec.stages) {
    if (stage.strategy === EXISTING_WORK_STRATEGY && modeId !== "review") {
      problems.push(`stage "${stage.id}": strategy "${EXISTING_WORK_STRATEGY}" (no executor) is only for review mode`);
    }
  }
  for (const stage of spec.stages) {
    const problem = validateStage?.(stage, spec);
    if (problem) problems.push(`stage "${stage.id}": ${problem}`);
  }
  if (problems.length > 0) throw new ModeValidationError(problems);
  return spec;
}

/** Review mode's executor: changes nothing and has no evidence to add. */
function existingWorkExecutor(): Executor {
  const done = async () => ({
    status: "completed" as const,
    summary: "Review mode: no executor runs; review the work already in the project.",
  });
  return {
    name: "existing-work",
    capabilities: () => ({ canEditFiles: false, canRunCommands: false, canContinueSession: true, supportsScreenshots: false }),
    run: done,
    continue: done,
    cancel: async () => undefined,
  };
}
