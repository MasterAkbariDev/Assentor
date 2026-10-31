import type { SeatStatus } from "#assentor/protocol/seats.js";
import type { EngineEventDraft, EngineEventType } from "#assentor/protocol/events.js";
import type { SupervisorEvent, SupervisorEventType } from "./supervisor.js";

/**
 * Bridge from legacy `SupervisorEvent` to `EngineEvent` drafts (T00-01).
 * Lives in the orchestrator (not protocol) so the protocol layer stays free of
 * engine imports. T00-07 calls this from `Supervisor.emit`.
 */

export interface SupervisorEventContext {
  sessionId: string;
  /** Seat id used for executor-scoped events. Default `executor`. */
  executorSeatId?: string;
  /** Seat id used for reviewer-scoped events (the panel as a whole). Default `reviewer`. */
  reviewerSeatId?: string;
  stageId?: string;
}

type SeatScope = "executor" | "reviewer";

interface MappingRule {
  type: EngineEventType;
  seat?: SeatScope;
  /** Extra fields merged into data (legacy fields win only where not set here). */
  build?: (data: Record<string, unknown>) => Record<string, unknown>;
}

function status(value: SeatStatus): (data: Record<string, unknown>) => Record<string, unknown> {
  return () => ({ status: value });
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Compile-time exhaustive: adding a SupervisorEventType without a rule fails typecheck. */
const RULES: Record<SupervisorEventType, MappingRule> = {
  "state.changed": {
    type: "session.state",
    build: (d) => ({ to: text(d.to, "unknown") }),
  },
  "round.started": { type: "round.started" },
  "round.completed": { type: "round.completed" },
  "executor.started": { type: "seat.status", seat: "executor", build: status("starting") },
  "executor.completed": {
    type: "seat.done",
    seat: "executor",
    build: (d) => ({ ok: true, ...(typeof d.summary === "string" ? { summary: d.summary } : {}) }),
  },
  "executor.failed": {
    type: "seat.error",
    seat: "executor",
    build: (d) => ({ message: text(d.error ?? d.summary, "executor failed") }),
  },
  "executor.retry": { type: "seat.retry", seat: "executor" },
  // The interrupted attempt ends here; the restart starts a new turn on the seat.
  "executor.interrupted": {
    type: "seat.done",
    seat: "executor",
    build: (d) => ({ ok: false, summary: text(d.reason, "turn interrupted") }),
  },
  "review.started": { type: "seat.status", seat: "reviewer", build: status("starting") },
  "review.completed": {
    type: "review.verdict",
    seat: "reviewer",
    build: (d) => ({ status: text(d.status, "UNKNOWN") }),
  },
  "review.retry": { type: "seat.retry", seat: "reviewer" },
  "evidence.requested": { type: "evidence.requested", seat: "reviewer" },
  "evidence.fulfilled": { type: "evidence.fulfilled" },
  "change.requested": { type: "review.changes_requested", seat: "reviewer" },
  "verification.started": { type: "gate.started" },
  "verification.passed": { type: "gate.result", build: () => ({ passed: true }) },
  "verification.failed": { type: "gate.result", build: () => ({ passed: false }) },
  "loop.detected": {
    type: "session.warning",
    build: () => ({ kind: "loop_detected" }),
  },
  "budget.exceeded": { type: "budget.exceeded" },
  "task.completed": { type: "session.completed" },
  "task.blocked": { type: "session.blocked" },
  "task.failed": { type: "session.failed" },
};

/**
 * Convert one supervisor event into an engine event draft. The original type
 * is kept as `data.legacyType` and all legacy fields are preserved.
 */
export function fromSupervisorEvent(
  event: SupervisorEvent,
  context: SupervisorEventContext,
): EngineEventDraft {
  const rule = RULES[event.type];
  const legacy = { ...(event.data ?? {}) };
  const data = { ...legacy, ...(rule.build?.(legacy) ?? {}), legacyType: event.type };

  const seatId =
    rule.seat === "executor"
      ? (context.executorSeatId ?? "executor")
      : rule.seat === "reviewer"
        ? (context.reviewerSeatId ?? "reviewer")
        : undefined;

  return {
    type: rule.type,
    sessionId: context.sessionId,
    ...(seatId ? { seatId } : {}),
    ...(context.stageId ? { stageId: context.stageId } : {}),
    at: event.at,
    data,
  } as EngineEventDraft;
}

/** The engine event type a supervisor event maps to (for tests and docs). */
export function engineTypeForSupervisorEvent(type: SupervisorEventType): EngineEventType {
  return RULES[type].type;
}
