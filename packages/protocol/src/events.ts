import { z } from "zod";
import { SeatStatusSchema } from "./seats.js";

/** Autonomy levels (meaning and parsing: the engine's `core/run-mode.ts`). */
export const AUTONOMY_LEVELS = ["manual", "supervised", "autopilot"] as const;

/**
 * Engine event envelope (task T00-01).
 *
 * Every observable thing the engine does becomes one `EngineEvent`. Events are
 * appended to `.assentor/sessions/<id>/events.ndjson` (T00-05) before they are
 * sent to any client, so clients can resubscribe from their last `seq`.
 *
 * Rules for payloads:
 * - JSON-serializable only (no class instances, Dates, Maps).
 * - Typed payloads below use `.passthrough()` so extra fields survive; readers
 *   must ignore fields they don't know.
 */

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

/** Untyped payload for events whose shape still follows legacy supervisor data. */
const Open = z.object({}).passthrough();

const SessionCreated = z.object({ title: z.string().optional() }).passthrough();
const SessionState = z
  .object({ from: z.string().optional(), to: z.string(), reason: z.string().optional() })
  .passthrough();
const SessionWarning = z
  .object({ kind: z.string(), message: z.string().optional() })
  .passthrough();
/** Pre-run estimate of a run (TE-09): tokens and, when priced, USD, each as a low-high range. */
export const RunEstimateSchema = z.object({
  tokens: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  usd: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }).optional(),
}).passthrough();
export type RunEstimate = z.infer<typeof RunEstimateSchema>;

const StageEvent = z
  .object({ kind: z.string(), strategy: z.string().optional() })
  .passthrough();

const RoundEvent = z.object({ round: z.number().int().nonnegative() }).passthrough();

const SeatSpawned = z
  .object({
    displayName: z.string(),
    provider: z.string(),
    transport: z.enum(["cli", "api"]),
    model: z.string(),
    role: z.string(),
    permissions: z.enum(["read-only", "edit"]),
  })
  .passthrough();
const SeatStatusChanged = z
  .object({ status: SeatStatusSchema, detail: z.string().optional() })
  .passthrough();
const SeatOutputDelta = z.object({ text: z.string() }).passthrough();
/** FU-18a: a user message queued for the seat's next turn; `preview` is redacted and cut short. */
const SeatInjected = z.object({ preview: z.string(), chars: z.number().int().nonnegative() }).passthrough();
const SeatThinking = z.object({ text: z.string().optional() }).passthrough();
const SeatToolCall = z
  .object({
    name: z.string(),
    summary: z.string().optional(),
    file: z.string().optional(),
  })
  .passthrough();
const SeatTokens = z
  .object({
    tokensIn: z.number().nonnegative(),
    tokensOut: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    /** Input tokens served from the provider's prompt cache; a part of `tokensIn`. Absent in older logs. */
    cachedTokens: z.number().nonnegative().optional(),
    /** Model turns this report covers (a CLI run makes several); absent = 1. */
    turns: z.number().int().positive().optional(),
  })
  .passthrough();
const SeatModelChanged = z
  .object({ from: z.string().optional(), to: z.string(), pending: z.boolean() })
  .passthrough();
const SeatRetry = z
  .object({
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    reason: z.string().optional(),
  })
  .passthrough();
const SeatError = z
  .object({ message: z.string(), retryable: z.boolean().optional() })
  .passthrough();
const SeatDone = z.object({ ok: z.boolean(), summary: z.string().optional() }).passthrough();

const NegotiationProposal = z
  .object({ round: z.number().int().positive(), label: z.string(), text: z.string() })
  .passthrough();
const NegotiationCritique = z
  .object({
    round: z.number().int().positive(),
    targetLabel: z.string(),
    text: z.string(),
    citations: z.array(z.string()).default([]),
  })
  .passthrough();
const NegotiationVote = z
  .object({ round: z.number().int().positive(), ranking: z.array(z.string()) })
  .passthrough();
const NegotiationConsensus = z
  .object({
    round: z.number().int().positive(),
    score: z.number().min(0).max(1),
    reached: z.boolean(),
    preferred: z.string().optional(),
    /** Debate: reached when score >= threshold. Vote and synthesize: reached when score > threshold. */
    threshold: z.number().min(0).max(1).optional(),
  })
  .passthrough();
/** The strategy's final decision: why, and which proposal label won (none for a synthesized answer). */
const NegotiationDecided = z
  .object({ rationale: z.string().max(4000), winner: z.string().max(200).optional() })
  .passthrough();

const ReviewFinding = z
  .object({
    key: z.string(),
    description: z.string(),
    severity: z.string(),
    affectedFiles: z.array(z.string()).default([]),
    agreement: z
      .object({ count: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
      .optional(),
    /** Seat ids of the panel members who flagged it (the member names when the panel has no seat ids). */
    reviewerIds: z.array(z.string().max(200)).max(50).optional(),
    category: z.string().max(40).optional(),
    evidence: z.array(z.string().max(2000)).max(20).optional(),
  })
  .passthrough();
const ReviewVerdict = z
  .object({
    status: z.string(),
    summary: z.string().optional(),
    confidence: z.number().optional(),
    /** Panel decision policy, on the merged verdict of a panel. */
    policy: z.string().max(64).optional(),
    /** True on one panel member's own verdict; the merged verdict (from the panel seat) does not set it. */
    panelMember: z.boolean().optional(),
  })
  .passthrough();

const GateResult = z.object({ passed: z.boolean() }).passthrough();

const BudgetWarning = z
  .object({ kind: z.string(), used: z.number(), limit: z.number() })
  .passthrough();

// Mode events (modes.md §8, T02B-01). Producers arrive with their modes; the
// payloads name only what every producer must send.
const ModeSelected = z
  .object({ mode: z.string(), kind: z.enum(["static", "dynamic"]), autonomy: z.enum(AUTONOMY_LEVELS) })
  .passthrough();
const LeadTurn = z.object({ turn: z.number().int().positive(), note: z.string().optional() }).passthrough();
const LeadAction = z
  // `by: "user"` (FU-18b): an override, pin, pause or resume from a client, not the lead's own action.
  .object({ action: z.string(), accepted: z.boolean(), reason: z.string().optional(), by: z.enum(["lead", "user"]).optional() })
  .passthrough();
const TaskEvent = z.object({ taskId: z.string() }).passthrough();
const TaskAssigned = TaskEvent.extend({ seatId: z.string() });
const TaskStatus = TaskEvent.extend({ status: z.string() });
const TaskEscalated = TaskEvent.extend({ to: z.string(), from: z.string().optional(), reason: z.string().optional() });
const TaskRejected = TaskEvent.extend({ reason: z.string() });
const CascadeEscalated = z
  // `fromTier` is absent for a danger start: no lower tier ran.
  .object({ fromTier: z.number().int().nonnegative().optional(), toTier: z.number().int().nonnegative(), reason: z.string() })
  .passthrough();
const CascadeTierSucceeded = z
  .object({
    tier: z.number().int().nonnegative(),
    team: z.string(),
    escalations: z.number().int().nonnegative(),
    triggers: z.array(z.string()),
  })
  .passthrough();
const PairInterjection = z.object({ text: z.string() }).passthrough();
const RedteamAttack = z.object({ round: z.number().int().positive() }).passthrough();
const TddGate = z.object({ gate: z.enum(["A", "B"]), passed: z.boolean() }).passthrough();
const SwarmItem = z.object({ itemId: z.string(), status: z.string() }).passthrough();
const UserQuestion = z
  .object({ question: z.string(), options: z.array(z.string()).optional() })
  .passthrough();
const UserAnswer = z.object({ answer: z.string() }).passthrough();
/**
 * A skill body was sent in a seat's prompt (TE-07): one event per delivery, re-sends included
 * (`delivery` counts them), so usage sees every copy. `tokens` is the estimated fenced size.
 * The seat is the envelope's `seatId`.
 */
const SkillLoaded = z
  .object({
    name: z.string(),
    tokens: z.number().int().nonnegative(),
    via: z.enum(["trigger", "request"]).optional(),
    delivery: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * Catalog: event type → payload schema. Adding a type here is the only way to
 * introduce a new event; the envelope schema rejects unknown types.
 */
export const EngineEventDataSchemas = {
  "session.created": SessionCreated,
  "session.state": SessionState,
  "session.warning": SessionWarning,
  "session.completed": Open,
  "session.blocked": Open,
  "session.failed": Open,
  "session.estimate": RunEstimateSchema,
  /** FU-18a: no new turn starts until `session.resumed`; turns in flight finish. */
  "session.paused": Open,
  "session.resumed": Open,

  "stage.started": StageEvent,
  "stage.completed": StageEvent,

  "round.started": RoundEvent,
  "round.completed": RoundEvent,

  "seat.spawned": SeatSpawned,
  "seat.status": SeatStatusChanged,
  "seat.output.delta": SeatOutputDelta,
  "seat.thinking": SeatThinking,
  "seat.tool_call": SeatToolCall,
  "seat.tokens": SeatTokens,
  "seat.model.changed": SeatModelChanged,
  "seat.injected": SeatInjected,
  "seat.retry": SeatRetry,
  "seat.error": SeatError,
  "seat.done": SeatDone,

  "negotiation.proposal": NegotiationProposal,
  "negotiation.critique": NegotiationCritique,
  "negotiation.vote": NegotiationVote,
  "negotiation.consensus": NegotiationConsensus,
  "negotiation.decided": NegotiationDecided,

  "review.finding": ReviewFinding,
  "review.verdict": ReviewVerdict,
  "review.changes_requested": Open,

  "evidence.requested": Open,
  "evidence.fulfilled": Open,

  "gate.started": Open,
  "gate.result": GateResult,

  "budget.warning": BudgetWarning,
  "budget.exceeded": Open,

  "mode.selected": ModeSelected,
  "lead.turn": LeadTurn,
  "lead.action": LeadAction,
  "task.created": TaskEvent,
  "task.assigned": TaskAssigned,
  "task.status": TaskStatus,
  "task.report": TaskStatus,
  "task.escalated": TaskEscalated,
  "task.accepted": TaskEvent,
  "task.rejected": TaskRejected,
  "cascade.escalated": CascadeEscalated,
  "cascade.tier_succeeded": CascadeTierSucceeded,
  "pair.interjection": PairInterjection,
  "redteam.attack": RedteamAttack,
  "tdd.gate": TddGate,
  "swarm.item": SwarmItem,
  "user.question": UserQuestion,
  "user.answer": UserAnswer,
  "skill.loaded": SkillLoaded,
} as const satisfies Record<string, z.ZodTypeAny>;

export type EngineEventType = keyof typeof EngineEventDataSchemas;

export const ENGINE_EVENT_TYPES = Object.keys(
  EngineEventDataSchemas,
) as EngineEventType[];

export type EngineEventData<T extends EngineEventType> = z.infer<
  (typeof EngineEventDataSchemas)[T]
>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

interface EngineEventBase {
  /** Monotonic per session, starting at 1. Assigned by the event log. */
  seq: number;
  sessionId: string;
  /** Present for seat-scoped events. */
  seatId?: string;
  stageId?: string;
  /** ISO-8601 timestamp. */
  at: string;
}

/** Discriminated union: narrowing on `type` narrows `data`. */
export type EngineEvent = {
  [K in EngineEventType]: EngineEventBase & { type: K; data: EngineEventData<K> };
}[EngineEventType];

export type EngineEventOf<K extends EngineEventType> = Extract<EngineEvent, { type: K }>;

/**
 * An event before the log assigns `seq` (and optionally `at`). This is what
 * producers create and what `EventLog.append` accepts.
 */
export type EngineEventDraft = {
  [K in EngineEventType]: Omit<EngineEventBase, "seq" | "at"> & {
    at?: string;
    type: K;
    data: EngineEventData<K>;
  };
}[EngineEventType];

const EnvelopeSchema = z.object({
  seq: z.number().int().positive(),
  sessionId: z.string().min(1),
  seatId: z.string().min(1).optional(),
  stageId: z.string().min(1).optional(),
  at: z.string().datetime({ offset: true }),
  type: z.enum(ENGINE_EVENT_TYPES as [EngineEventType, ...EngineEventType[]]),
  data: z.record(z.unknown()),
});

/** Validates the envelope and the payload for its `type`. */
export const EngineEventSchema = EnvelopeSchema.transform((envelope, ctx) => {
  const parsed = EngineEventDataSchemas[envelope.type].safeParse(envelope.data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: ["data", ...issue.path] });
    }
    return z.NEVER;
  }
  return { ...envelope, data: parsed.data } as EngineEvent;
});

export function parseEngineEvent(input: unknown): EngineEvent {
  return EngineEventSchema.parse(input);
}

export function safeParseEngineEvent(
  input: unknown,
): { success: true; data: EngineEvent } | { success: false; error: z.ZodError } {
  const result = EngineEventSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}

export function isEngineEventType(value: string): value is EngineEventType {
  return Object.prototype.hasOwnProperty.call(EngineEventDataSchemas, value);
}
