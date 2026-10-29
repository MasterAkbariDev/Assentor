import { z } from "zod";
import type { Seat } from "../core/seats.js";
import type { EngineEventData } from "../protocol/events.js";

/**
 * Negotiation strategy contract (task T02-03a).
 *
 * A strategy decides how a team of seats reaches one answer (vote, debate,
 * synthesize, best-of-n, divide). It never spawns processes, reads files or
 * talks to models directly: everything goes through `NegotiationContext`,
 * which the engine (T02-03) implements on top of the seat scheduler (T02-02)
 * and tests implement with `createMockNegotiationContext`.
 *
 * Rules every strategy follows:
 * - Proposals are shown to other seats only through `anonymizeProposals`, as
 *   "Proposal A", "Proposal B", … — never with seat names, ids or models.
 * - Implementation steps (best-of-n in worktrees, T02-06) are not in this
 *   contract yet: those cards extend `NEGOTIATION_STEPS` and the reply schemas
 *   under Opus review. Divide-and-conquer (T02-08) adds only `divide-plan`; its
 *   parts run as executors in worktrees (strategies/divide.ts), not as asks.
 * - Replies are validated with the step's schema (`STEP_REPLY_SCHEMAS`); an
 *   invalid reply is recorded as dissent, not thrown.
 * - Cancellation: check `ctx.signal` between rounds; `ctx.askSeat` rejects with
 *   `NegotiationCancelledError` once it is aborted. Strategies let that error
 *   propagate (don't catch it).
 * - Output is deterministic for the same replies (no clocks, no randomness).
 */

// ---------------------------------------------------------------------------
// Steps and their reply schemas
// ---------------------------------------------------------------------------

/** Prompt ids of the negotiation steps (built-in prompts ship in T03-03). */
export const NEGOTIATION_STEPS = [
  "negotiate-propose",
  "negotiate-critique",
  "negotiate-revise",
  "negotiate-rank",
  "negotiate-agree",
  "negotiate-synthesize",
  "judge",
  "moderator",
  "divide-plan",
] as const;
export type NegotiationStep = (typeof NEGOTIATION_STEPS)[number];

export const ProposalReplySchema = z.object({
  proposal: z.string().min(1),
});

export const CritiqueReplySchema = z.object({
  critiques: z.array(
    z.object({
      /** Anonymized label, e.g. "Proposal B". Never the critic's own proposal. */
      target: z.string().min(1),
      text: z.string().min(1),
      /** file:line, test names, doc links. Uncited critiques carry less weight. */
      citations: z.array(z.string()).default([]),
    }),
  ),
});

export const ReviseReplySchema = z.object({
  proposal: z.string().min(1),
  /** What changed and why, for the transcript. */
  changes: z.string().default(""),
});

export const RankReplySchema = z.object({
  /** Labels, best first. */
  ranking: z.array(z.string().min(1)).min(1),
});

/** Debate consensus check: each seat says whether it agrees and which label it prefers. */
export const AgreeReplySchema = z.object({
  agree: z.boolean(),
  /** Preferred label, e.g. "Proposal B". */
  preferred: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const SynthesizeReplySchema = z.object({
  answer: z.string().min(1),
  sources: z.array(z.object({ label: z.string().min(1), used: z.string() })),
});

export const JudgeReplySchema = z.object({
  /** Winning label. */
  winner: z.string().min(1),
  reasons: z.array(z.string()).min(1),
});

export const ModeratorReplySchema = z.object({
  consensus: z.boolean(),
  /** Preferred label when there is one. */
  preferred: z.string().optional(),
  reasons: z.array(z.string()).default([]),
});

/**
 * Divide-and-conquer split plan. Only the envelope is checked here; the
 * strategy validates each subtask with `SplitPlanSchema` (strategies/divide.ts)
 * so a bad plan is reported with the reason, not just a field path.
 */
export const DividePlanReplySchema = z.object({
  subtasks: z.array(z.unknown()),
});

export const STEP_REPLY_SCHEMAS = {
  "negotiate-propose": ProposalReplySchema,
  "negotiate-critique": CritiqueReplySchema,
  "negotiate-revise": ReviseReplySchema,
  "negotiate-rank": RankReplySchema,
  "negotiate-agree": AgreeReplySchema,
  "negotiate-synthesize": SynthesizeReplySchema,
  judge: JudgeReplySchema,
  moderator: ModeratorReplySchema,
  "divide-plan": DividePlanReplySchema,
} as const satisfies Record<NegotiationStep, z.ZodTypeAny>;

export type StepReply<S extends NegotiationStep> = z.infer<(typeof STEP_REPLY_SCHEMAS)[S]>;

// ---------------------------------------------------------------------------
// Anonymized proposals
// ---------------------------------------------------------------------------

export interface SeatProposal {
  seatId: string;
  text: string;
}

/** What other seats see. No seat id, name or model. */
export interface AnonymizedProposal {
  label: string;
  text: string;
}

/** "Proposal A" … "Proposal Z", "Proposal AA", "Proposal AB", … for index 0, 1, … */
export function proposalLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`proposal index must be a non-negative integer, got ${index}`);
  }
  let n = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Proposal ${letters}`;
}

/**
 * Label proposals in the order given (callers pass them in seat order, so the
 * result is deterministic). Returns the anonymized list and a label → seatId
 * map that stays on the engine side for results and dissent.
 */
export function anonymizeProposals(proposals: readonly SeatProposal[]): {
  anonymized: AnonymizedProposal[];
  seatByLabel: Record<string, string>;
} {
  const anonymized: AnonymizedProposal[] = [];
  const seatByLabel: Record<string, string> = {};
  proposals.forEach((proposal, index) => {
    const label = proposalLabel(index);
    anonymized.push({ label, text: proposal.text });
    seatByLabel[label] = proposal.seatId;
  });
  return { anonymized, seatByLabel };
}

/**
 * Match a label a model wrote ("Proposal B", "proposal b", "B", " b ") to one of
 * `labels`. Returns the canonical label or undefined. Use it for every ballot,
 * critique target and source, so strategies treat bad labels the same way.
 */
export function matchLabel(raw: string, labels: readonly string[]): string | undefined {
  const wanted = raw.trim().toLowerCase().replace(/^proposal\s+/, "");
  return labels.find((label) => label.toLowerCase().replace(/^proposal\s+/, "") === wanted);
}

/**
 * Debate consensus: each valid reply weighs its `confidence` toward its
 * preferred label (only when `agree` is true; a disagreeing reply adds its
 * weight to the total only). Score = top label's weight / total weight, 0 when
 * nothing was said. A reply naming an unknown label still adds its confidence
 * to the total (so it lowers the score) but counts for no label. Ties go to the earliest label in
 * `labels`. Callers exclude devil's-advocate seats before calling.
 */
export function agreementScore(
  replies: ReadonlyArray<z.infer<typeof AgreeReplySchema>>,
  labels: readonly string[],
): { score: number; preferred?: string } {
  const weights = new Map<string, number>();
  let total = 0;
  for (const reply of replies) {
    total += reply.confidence;
    const label = matchLabel(reply.preferred, labels);
    if (reply.agree && label) {
      weights.set(label, (weights.get(label) ?? 0) + reply.confidence);
    }
  }
  let preferred: string | undefined;
  let best = 0;
  for (const label of labels) {
    const weight = weights.get(label) ?? 0;
    if (weight > best) {
      best = weight;
      preferred = label;
    }
  }
  return total > 0 && preferred ? { score: best / total, preferred } : { score: 0 };
}

// ---------------------------------------------------------------------------
// Context (implemented by the engine and by the mock)
// ---------------------------------------------------------------------------

export interface AskSeatOptions {
  /** True for every negotiation step except implementation steps (best-of-n, divide). */
  readOnly: boolean;
  /** Worktree for editing steps; set by strategies that own worktrees (T02-06, T02-08). */
  worktreePath?: string;
}

export type SeatReply<S extends NegotiationStep> =
  | { ok: true; seatId: string; data: StepReply<S> }
  /** The seat answered but the reply failed the step schema, or the seat failed operationally. */
  | { ok: false; seatId: string; error: string };

/** Negotiation events a strategy may emit; `sessionId`/`seq`/`at` are added by the engine. */
export type NegotiationEventInput =
  | { type: "negotiation.proposal"; seatId?: string; data: EngineEventData<"negotiation.proposal"> }
  | { type: "negotiation.critique"; seatId?: string; data: EngineEventData<"negotiation.critique"> }
  | { type: "negotiation.vote"; seatId?: string; data: EngineEventData<"negotiation.vote"> }
  | { type: "negotiation.consensus"; seatId?: string; data: EngineEventData<"negotiation.consensus"> };

export interface NegotiationContext {
  readonly sessionId: string;
  readonly goal: string;
  /** Participating seats in team order. */
  readonly seats: readonly Seat[];
  /** Strategy options from config/playbook (validated by `strategy.validate`). */
  readonly options: Readonly<Record<string, unknown>>;
  /** Aborted when the session is cancelled or the budget runs out. */
  readonly signal: AbortSignal;
  /**
   * Run one step on one seat and validate its reply. Never throws for a bad or
   * failed reply, a per-ask timeout or the seat's own budget running out
   * (returns `ok: false`). Rejects with `NegotiationCancelledError` when the
   * session is cancelled or its budget is exhausted (also for asks in flight).
   * The one other exception is a programmer error: a `seatId` that is not in
   * `seats` throws.
   */
  askSeat<S extends NegotiationStep>(
    seatId: string,
    step: S,
    vars: Readonly<Record<string, unknown>>,
    options: AskSeatOptions,
  ): Promise<SeatReply<S>>;
  emit(event: NegotiationEventInput): void;
}

export class NegotiationCancelledError extends Error {
  readonly reason: "cancelled" | "budget";
  constructor(reason: "cancelled" | "budget" = "cancelled", message?: string) {
    super(message ?? (reason === "budget" ? "negotiation stopped: budget exhausted" : "negotiation cancelled"));
    this.name = "NegotiationCancelledError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const NegotiationResultSchema = z.object({
  strategy: z.string().min(1),
  /** The agreed answer (plan, decision text, synthesized answer). */
  decision: z.string(),
  rationale: z.string(),
  /** Every proposal with its label and author (author is engine-side only; UIs may reveal it). */
  proposals: z.array(z.object({ label: z.string(), seatId: z.string(), text: z.string() })),
  /** Per-seat rankings when the strategy votes. */
  votes: z.array(z.object({ seatId: z.string(), ranking: z.array(z.string()) })).optional(),
  /** Points per label when the strategy tallies. */
  tallies: z.record(z.number()).optional(),
  dissent: z.array(
    z.object({
      seatId: z.string().optional(),
      label: z.string().optional(),
      reason: z.string().min(1),
    }),
  ),
  rounds: z.number().int().nonnegative(),
  consensus: z.object({ score: z.number().min(0).max(1), reached: z.boolean() }),
  /** Set by the engine (T02-03): where the full transcript is persisted. */
  transcriptRef: z.string().optional(),
});
export type NegotiationResult = z.infer<typeof NegotiationResultSchema>;

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export interface NegotiationStrategy {
  /** e.g. "vote", "debate", "synthesize", "best-of-n", "divide". */
  readonly id: string;
  /** Returns an error message when the team/options can't run this strategy, else undefined. */
  validate(seats: readonly Seat[], options: Readonly<Record<string, unknown>>): string | undefined;
  run(ctx: NegotiationContext): Promise<NegotiationResult>;
}
