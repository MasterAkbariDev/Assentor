import { promises as fs } from "node:fs";
import type { AssentorConfig } from "../config/schema.js";
import { isId } from "../core/ids.js";
import { AutonomySchema, type Autonomy } from "../core/run-mode.js";
import { SessionSpecSchema, type SessionSpec } from "../core/seats.js";
import {
  SessionRunner,
  validateSessionGraph,
  type SessionRunResult,
} from "../orchestrator/session-runner.js";
import { createStageRunners, type StageRunnerDeps } from "../orchestrator/session-stages.js";
import type { EngineEventDraft } from "../protocol/events.js";
import type { Executor } from "../providers/executors/types.js";
import type { WorktreeManager } from "../worktrees/manager.js";
import {
  EXISTING_WORK_STRATEGY,
  getMode,
  type ModeDefinition,
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
  /** Releases a static session waiting on `stageId`'s approval gate; false otherwise. */
  approve(stageId: string): boolean;
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

  return {
    mode,
    autonomy,
    approve: () => false,
    run: async () => {
      claim();
      selected();
      const { sessionId } = input;
      const signal = input.signal ?? new AbortController().signal;
      const finish = (status: SessionRunResult["status"], reason?: string): ModeRunResult => {
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
        const controller = mode.createController!({
          ...buildInput,
          sessionId,
          stages,
          deps,
          signal,
          emit,
          ...(input.worktrees ? { worktrees: input.worktrees } : {}),
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
      }
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
