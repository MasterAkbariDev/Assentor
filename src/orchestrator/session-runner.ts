import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SessionSpecSchema, type SessionSpec, type StageSpec } from "../core/seats.js";
import { NegotiationCancelledError } from "../negotiation/strategy.js";
import { sessionPaths, writeJsonAtomic } from "../persistence/paths.js";
import type { EngineEventDraft } from "../protocol/events.js";

/**
 * Stage-graph runner (task T02-09).
 *
 * Walks a `SessionSpec` (T00-01): stages run one at a time from `stages[0]`,
 * following `next`; a review that still needs work follows its `onNeedsWork`.
 * The work itself is done by injected `StageRunners` (built-ins in
 * `session-stages.ts`: negotiation for plan/negotiate, the Supervisor for
 * execute ⇄ review). Graph rules (`validateSessionGraph`):
 * - an `execute` stage's `next` is a `review` stage, and the two run together
 *   as one execute ⇄ review loop; a review stage is reached only that way;
 * - `onNeedsWork` only on review stages; `next` edges have no cycle (loops go
 *   through `onNeedsWork` and are bounded by `maxStageVisits`);
 * - every stage is reachable from the first; stage ids are at most 40 chars.
 *
 * Lifecycle guarantees:
 * - every started stage gets exactly one `stage.completed` with an `outcome`
 *   (`pass`, `needs_work`, `blocked`, `failed`, `cancelled`, `budget`), and
 *   every run ends with `session.state` plus `session.completed|blocked|failed`;
 * - `run()`/`resume()` resolve only after the running stage has settled, so a
 *   cancelled graph leaves no asks running (stage runners must stop on abort);
 * - progress is checkpointed to `.assentor/sessions/<id>/graph.json` before and
 *   after every stage; `resume()` re-runs an interrupted stage from its start;
 * - `requireApproval` stages wait (`session.state` → `waiting`) until
 *   `approve(stageId)`; approvals are not persisted, so a resumed stage asks again.
 *
 * Host duties: `graph.json` is trusted like `tasks/<id>/state.json` (shape and
 * stage ids are checked, not its origin); hold a per-session lock around
 * run/resume and own a grace timeout for stage runners that ignore abort.
 * Supervisor budgets are per execute visit, and the scheduler's session usage
 * is not persisted, so it starts from zero after a resume.
 */

export const STAGE_OUTCOMES = ["pass", "needs_work", "blocked", "failed", "cancelled", "budget"] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export const SESSION_RUN_STATUSES = [
  "running",
  "waiting",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "budget_exceeded",
] as const;
export type SessionRunStatus = (typeof SESSION_RUN_STATUSES)[number];

/** What a stage runner returns. Failures are thrown; cancellation is the signal aborting. */
export interface StageResult {
  outcome: "pass" | "needs_work" | "blocked" | "budget";
  summary: string;
  /** Plan or decision text (plan/negotiate stages). Becomes `plan` for later stages. Never seat ids. */
  decision?: string;
  /** What a NEEDS_WORK review asked for; handed to the stage `onNeedsWork` names. */
  feedback?: string[];
}

export interface StageRunInput {
  sessionId: string;
  stage: StageSpec;
  goal: string;
  /** Decision of the latest plan/negotiate stage. */
  plan?: string;
  /** Changes asked for by the review that looped back here. */
  feedback?: string[];
  /** Unique per stage start in this session, also across resumes. Use it in run ids. */
  attempt: number;
  /** The session's signal. Stop all work when it aborts. */
  signal: AbortSignal;
  /** Session event sink; `stageId` is filled in. Never throws. */
  emit: (draft: EngineEventDraft) => void;
}

export interface StageRunners {
  /** `plan` and `negotiate` stages. */
  negotiate(input: StageRunInput): Promise<StageResult>;
  /** An `execute` stage together with its review stage (the execute ⇄ review loop). */
  execute(input: StageRunInput & { review: StageSpec }): Promise<StageResult>;
  /** Checks a stage before anything runs (team exists, strategy valid). Returns a problem or undefined. */
  validate?(stage: StageSpec, spec: SessionSpec): string | undefined;
}

export interface StageRecord {
  stageId: string;
  attempt: number;
  outcome: StageOutcome;
  summary: string;
}

export interface SessionRunResult {
  status: Exclude<SessionRunStatus, "running" | "waiting">;
  reason?: string;
  /** Stage to continue from on resume (unset when completed). */
  current?: string;
  plan?: string;
  history: StageRecord[];
}

export interface SessionRunnerOptions {
  /** Engine session id (UUID when `projectPath` is set). */
  sessionId: string;
  /** Project root; without it nothing is persisted and `resume()` is unavailable. */
  projectPath?: string;
  runners: StageRunners;
  /** Session events; must not throw (errors are swallowed). */
  emit?: (draft: EngineEventDraft) => void;
  /** Session cancellation. Pass the same signal the scheduler's negotiations use. */
  signal?: AbortSignal;
  /** How many times one stage may complete before the session blocks. Default 3. */
  maxStageVisits?: number;
}

const MAX_STAGE_ID_LENGTH = 40;
const DEFAULT_MAX_STAGE_VISITS = 3;
const GRAPH_FILE = "graph.json";

const GraphStateSchema = z.object({
  version: z.literal(1),
  spec: SessionSpecSchema,
  status: z.enum(SESSION_RUN_STATUSES),
  current: z.string().optional(),
  /** Stage starts so far; the next start gets `attempts + 1`. */
  attempts: z.number().int().nonnegative(),
  /** Completed runs per stage id (an interrupted run does not count). */
  visits: z.record(z.number().int().nonnegative()),
  plan: z.string().optional(),
  feedback: z.array(z.string()).optional(),
  history: z.array(
    z.object({
      stageId: z.string(),
      attempt: z.number().int().positive(),
      outcome: z.enum(STAGE_OUTCOMES),
      summary: z.string(),
    }),
  ),
  reason: z.string().optional(),
});
type GraphState = z.infer<typeof GraphStateSchema>;

/** Every problem with a session graph, or `[]` when it can run. Does not check teams or strategies. */
export function validateSessionGraph(input: unknown): string[] {
  const parsed = SessionSpecSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join(".") || "session"}: ${issue.message}`);
  }
  const spec = parsed.data;
  const problems: string[] = [];
  const byId = new Map(spec.stages.map((stage) => [stage.id, stage]));
  const reviewOwners = new Map<string, number>();

  for (const stage of spec.stages) {
    if (stage.id.length > MAX_STAGE_ID_LENGTH) {
      problems.push(`stage "${stage.id}": id is longer than ${MAX_STAGE_ID_LENGTH} characters`);
    }
    if (stage.onNeedsWork && stage.kind !== "review") {
      problems.push(`stage "${stage.id}": onNeedsWork is only allowed on review stages`);
    }
    if (stage.kind === "execute") {
      const next = stage.next ? byId.get(stage.next) : undefined;
      if (next?.kind !== "review") {
        problems.push(`stage "${stage.id}": an execute stage's next must be a review stage`);
      } else {
        reviewOwners.set(next.id, (reviewOwners.get(next.id) ?? 0) + 1);
      }
    }
  }
  for (const stage of spec.stages) {
    if (stage.kind !== "review") continue;
    if (reviewOwners.get(stage.id) !== 1) {
      problems.push(`stage "${stage.id}": a review stage must be the next of exactly one execute stage`);
    }
    if (stage.requireApproval) {
      problems.push(`stage "${stage.id}": a review stage runs with its execute stage; put requireApproval on that stage`);
    }
    for (const other of spec.stages) {
      if (other.onNeedsWork === stage.id || (other.next === stage.id && other.kind !== "execute")) {
        problems.push(`stage "${other.id}": only an execute stage may lead to review stage "${stage.id}"`);
      }
    }
  }
  if (spec.stages[0]!.kind === "review") {
    problems.push(`stage "${spec.stages[0]!.id}": a session cannot start with a review stage`);
  }

  // `next` gives each stage at most one successor, so a cycle shows up as a revisit along one chain.
  cycles: for (const start of spec.stages) {
    const seen: string[] = [];
    for (let id: string | undefined = start.id; id; id = byId.get(id)?.next) {
      if (seen.includes(id)) {
        problems.push(`next edges form a cycle: ${[...seen.slice(seen.indexOf(id)), id].join(" → ")}`);
        break cycles; // report one cycle, not one per stage on it
      }
      seen.push(id);
    }
  }

  const reached = new Set<string>();
  const queue = [spec.stages[0]!.id];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    const stage = byId.get(id)!;
    for (const target of [stage.next, stage.onNeedsWork]) {
      if (target) queue.push(target);
    }
  }
  for (const stage of spec.stages) {
    if (!reached.has(stage.id)) {
      problems.push(`stage "${stage.id}": unreachable from the first stage "${spec.stages[0]!.id}"`);
    }
  }
  return problems;
}

/**
 * Runs one session graph. One runner per session run: call `run(spec)` for a
 * new session or `resume()` to continue a persisted one, once.
 */
export class SessionRunner {
  private readonly options: SessionRunnerOptions;
  private readonly signal: AbortSignal;
  private readonly maxStageVisits: number;
  private started = false;
  private waiting?: { stageId: string; release: (approved: boolean) => void };

  constructor(options: SessionRunnerOptions) {
    this.options = options;
    this.signal = options.signal ?? new AbortController().signal;
    this.maxStageVisits = options.maxStageVisits ?? DEFAULT_MAX_STAGE_VISITS;
    if (!Number.isInteger(this.maxStageVisits) || this.maxStageVisits < 1) {
      throw new Error(`maxStageVisits must be a positive integer, got ${this.maxStageVisits}`);
    }
  }

  /** Path of the persisted graph state, or undefined without a project. */
  get graphFile(): string | undefined {
    return this.options.projectPath
      ? path.join(sessionPaths(this.options.projectPath, this.options.sessionId).root, GRAPH_FILE)
      : undefined;
  }

  /**
   * Release the approval gate of `stageId`. Returns true when the session was
   * waiting on that stage; approving ahead of time is not possible.
   */
  approve(stageId: string): boolean {
    if (this.waiting?.stageId !== stageId) {
      return false;
    }
    this.waiting.release(true);
    return true;
  }

  /** Validate and run a new session. Refuses a session that already has a graph. */
  async run(input: z.input<typeof SessionSpecSchema>): Promise<SessionRunResult> {
    this.claim();
    const spec = this.checkSpec(input);
    const file = this.graphFile;
    if (file && (await fs.stat(file).catch(() => undefined))) {
      throw new Error(`session ${this.options.sessionId} already has a stage graph; use resume()`);
    }
    this.emit({ type: "session.created", sessionId: this.options.sessionId, data: { title: spec.title } });
    return this.walk({
      version: 1,
      spec,
      status: "running",
      current: spec.stages[0]!.id,
      attempts: 0,
      visits: {},
      history: [],
    });
  }

  /** Continue a persisted session from its current stage. A completed session is returned as is. */
  async resume(): Promise<SessionRunResult> {
    this.claim();
    const file = this.graphFile;
    if (!file) {
      throw new Error("resume needs a projectPath");
    }
    const state = GraphStateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    const spec = this.checkSpec(state.spec);
    if (state.status === "completed" && state.current === undefined) {
      return toResult(state);
    }
    const current = spec.stages.find((stage) => stage.id === state.current);
    if (state.status === "completed" || !current || current.kind === "review") {
      // A review stage only runs with its execute stage; resuming at one would skip the execute.
      throw new Error(
        `invalid stage graph file ${file}: status "${state.status}" cannot resume at ${JSON.stringify(state.current)}`,
      );
    }
    return this.walk({ ...state, status: "running" });
  }

  private claim(): void {
    if (this.started) {
      throw new Error("a SessionRunner runs once; create a new one");
    }
    this.started = true;
  }

  private checkSpec(input: unknown): SessionSpec {
    const problems = validateSessionGraph(input);
    const spec = problems.length === 0 ? SessionSpecSchema.parse(input) : undefined;
    if (spec && this.options.runners.validate) {
      for (const stage of spec.stages) {
        const problem = this.options.runners.validate(stage, spec);
        if (problem) problems.push(`stage "${stage.id}": ${problem}`);
      }
    }
    if (!spec || problems.length > 0) {
      throw new Error(`invalid session graph:\n- ${problems.join("\n- ")}`);
    }
    return spec;
  }

  private emit(draft: EngineEventDraft): void {
    try {
      this.options.emit?.(draft);
    } catch {
      // Observability must never break a session.
    }
  }

  private async save(state: GraphState): Promise<void> {
    const file = this.graphFile;
    if (file) {
      await writeJsonAtomic(file, state).catch((error: unknown) => {
        throw new Error(`checkpoint write failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async walk(state: GraphState): Promise<SessionRunResult> {
    const { sessionId } = this.options;
    const byId = new Map(state.spec.stages.map((stage) => [stage.id, stage]));
    let ended = false;
    const finish = async (status: SessionRunResult["status"], reason?: string): Promise<SessionRunResult> => {
      ended = true;
      state.status = status;
      state.reason = reason;
      if (status === "completed") delete state.current;
      // Events first: a failed checkpoint write must not swallow the terminal events.
      this.emit({ type: "session.state", sessionId, data: { to: status, ...(reason ? { reason } : {}) } });
      const data = { status, ...(reason ? { reason } : {}) };
      this.emit(
        status === "completed"
          ? { type: "session.completed", sessionId, data }
          : status === "blocked"
            ? { type: "session.blocked", sessionId, data }
            : { type: "session.failed", sessionId, data },
      );
      // Terminal events are already out; a failing save still rejects so the host knows the file is stale.
      await this.save(state);
      return toResult(state);
    };

    try {
      return await this.steps(state, byId, finish);
    } catch (error) {
      if (ended) throw error;
      return finish("failed", error instanceof Error ? error.message : String(error));
    }
  }

  private async steps(
    state: GraphState,
    byId: ReadonlyMap<string, StageSpec>,
    finish: (status: SessionRunResult["status"], reason?: string) => Promise<SessionRunResult>,
  ): Promise<SessionRunResult> {
    const { sessionId } = this.options;
    while (state.current) {
      const stage = byId.get(state.current);
      if (!stage || stage.kind === "review") {
        return finish("failed", `cannot run stage ${JSON.stringify(state.current)} on its own`);
      }
      if (this.signal.aborted) {
        return finish("cancelled", "cancelled");
      }
      if ((state.visits[stage.id] ?? 0) >= this.maxStageVisits) {
        return finish("blocked", `loop limit: stage "${stage.id}" already ran ${this.maxStageVisits} times`);
      }
      if (stage.requireApproval) {
        state.status = "waiting";
        await this.save(state);
        const approved = await this.awaitApproval(stage.id);
        if (!approved) {
          return finish("cancelled", "cancelled while waiting for approval");
        }
        this.emit({ type: "session.state", sessionId, stageId: stage.id, data: { from: "waiting", to: "running" } });
      }

      state.attempts += 1;
      state.status = "running";
      const attempt = state.attempts;
      await this.save(state);

      const review = stage.kind === "execute" ? byId.get(stage.next!)! : undefined;
      const together = review ? [stage, review] : [stage];
      for (const s of together) {
        this.emit({
          type: "stage.started",
          sessionId,
          stageId: s.id,
          data: { kind: s.kind, ...(s.strategy ? { strategy: s.strategy } : {}), attempt },
        });
      }

      const input: StageRunInput = {
        sessionId,
        stage,
        goal: state.spec.goal,
        ...(state.plan !== undefined ? { plan: state.plan } : {}),
        ...(state.feedback ? { feedback: state.feedback } : {}),
        attempt,
        signal: this.signal,
        emit: (draft) => this.emit({ ...draft, stageId: draft.stageId ?? stage.id } as EngineEventDraft),
      };
      let outcome: StageOutcome;
      let summary: string;
      let result: StageResult | undefined;
      try {
        result = review
          ? await this.options.runners.execute({ ...input, review })
          : await this.options.runners.negotiate(input);
        if ((["pass", "needs_work", "blocked", "budget"] as unknown[]).includes(result?.outcome)) {
          outcome = result.outcome;
          summary = String(result.summary);
        } else {
          outcome = "failed";
          summary = `unknown stage outcome ${JSON.stringify(result?.outcome)}`;
        }
      } catch (error) {
        outcome =
          error instanceof NegotiationCancelledError ? (error.reason === "budget" ? "budget" : "cancelled") : "failed";
        summary = error instanceof Error ? error.message : String(error);
      }
      // A stage that finished while the session was being cancelled is not trusted (e.g. a tiebreak cut short).
      if (this.signal.aborted && outcome !== "budget") {
        outcome = "cancelled";
        summary = "cancelled"; // not e.g. the Supervisor's "Interrupted (Ctrl+C)…" hint
      }

      for (const s of [...together].reverse()) {
        this.emit({
          type: "stage.completed",
          sessionId,
          stageId: s.id,
          data: { kind: s.kind, ...(s.strategy ? { strategy: s.strategy } : {}), attempt, outcome, summary },
        });
      }
      state.history.push({ stageId: stage.id, attempt, outcome, summary });

      switch (outcome) {
        case "cancelled":
          return finish("cancelled", summary);
        case "failed":
          return finish("failed", `stage "${stage.id}" failed: ${summary}`);
        case "budget":
          return finish("budget_exceeded", summary);
        case "blocked":
          state.visits[stage.id] = (state.visits[stage.id] ?? 0) + 1;
          return finish("blocked", summary);
        case "pass": {
          state.visits[stage.id] = (state.visits[stage.id] ?? 0) + 1;
          if (result?.decision !== undefined && (stage.kind === "plan" || stage.kind === "negotiate")) {
            state.plan = result.decision;
          }
          delete state.feedback;
          state.current = (review ?? stage).next;
          break;
        }
        case "needs_work": {
          state.visits[stage.id] = (state.visits[stage.id] ?? 0) + 1;
          const target = review?.onNeedsWork;
          if (!target) {
            return finish("blocked", `review still needs work and stage "${(review ?? stage).id}" has no onNeedsWork: ${summary}`);
          }
          state.feedback = result?.feedback ?? [];
          state.current = target;
          break;
        }
        default:
          return finish("failed", `stage "${stage.id}" returned an unknown outcome ${JSON.stringify(outcome)}`);
      }
      await this.save(state);
    }
    return finish("completed");
  }

  /** Waits for `approve(stageId)`; resolves false when the session is cancelled first. */
  private awaitApproval(stageId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onAbort = () => release(false);
      const release = (approved: boolean) => {
        this.signal.removeEventListener("abort", onAbort);
        this.waiting = undefined;
        resolve(approved);
      };
      this.waiting = { stageId, release };
      if (this.signal.aborted) {
        release(false);
        return;
      }
      this.signal.addEventListener("abort", onAbort, { once: true });
      // Emitted after the gate is armed, so an approve() reacting to this event always lands.
      this.emit({
        type: "session.state",
        sessionId: this.options.sessionId,
        stageId,
        data: { to: "waiting", reason: `approval required before stage "${stageId}"` },
      });
    });
  }
}

function toResult(state: GraphState): SessionRunResult {
  return {
    status: state.status as SessionRunResult["status"],
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.current ? { current: state.current } : {}),
    ...(state.plan !== undefined ? { plan: state.plan } : {}),
    history: state.history,
  };
}
