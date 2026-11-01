import { expandSeatSpecs, type Seat, type Team } from "#assentor/protocol/seats.js";
import type { AssentorConfig } from "../config/schema.js";
import { resolveTeams, type NegotiateMode, type ReviewMode } from "../config/teams.js";
import { raceCandidateSeats, raceSeatCount } from "../modes/race.js";
import { estimateTokens } from "../usage/tokens.js";

/**
 * Pre-run cost estimate (T02-10). Pure: no I/O.
 *
 * Rough heuristics, not a quote:
 * - Each turn sends `contextTokens + 2_000` input tokens.
 * - Output per turn is 1_500 (low) to 4_000 (high) tokens.
 * - Negotiate turns per seat: debate = maxRounds × 2, vote = 2,
 *   synthesize = 1 (+1 aggregator turn on the team's first seat),
 *   best-of-n = 1 and divide = 1 (not in the card; assumed one turn per seat).
 * - Review turns per seat: low = 1 round, high = maxRounds.
 * - Teams estimated: `modes.negotiate.team`, and the review team, which is
 *   `modes.review.team` when set. When `modes.review` is unset, the optional
 *   `reviewTeam` (e.g. the legacy `resolveTeams(config).review`) is estimated
 *   instead; it is ignored whenever `modes.review` is set.
 * - Race: each of the N candidates is one build turn (low and high), so the
 *   build cost is N× one build; the judge is the review team's first seat.
 */

export const EXTRA_INPUT_TOKENS = 2_000;
export const OUTPUT_TOKENS_LOW = 1_500;
export const OUTPUT_TOKENS_HIGH = 4_000;

export interface ModelPricing {
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens. */
  outPerMTok: number;
  /** USD per million input tokens served from the prompt cache; unset = the input price (an overestimate). */
  cachedInPerMTok?: number;
}

/** Keyed by `"<provider>/<model>"`, e.g. `"openai/gpt-4o-mini"`. */
export type PricingTable = Record<string, ModelPricing>;

export interface EstimateInput {
  teams: Record<string, Team>;
  modes: { negotiate?: NegotiateMode; review?: ReviewMode };
  /** Review team for configs without `modes.review`; ignored when `modes.review` is set. */
  reviewTeam?: Team;
  /** Economy profile (TE-06): the reviewTeam's later members only count in the high estimate. */
  narrowReview?: boolean;
  /** The executor's team (solo runs): one turn low, `maxRounds` high, like a review seat. */
  executorTeam?: Team;
  /** Race candidates (T02B-R): one build turn each, so N× one build. */
  raceCandidates?: readonly Seat[];
  /** Tokens of shared context sent on every turn. */
  contextTokens: number;
  /** `limits.maxRounds`; used as the high-end review round count. */
  maxRounds: number;
  pricing?: PricingTable;
}

export interface SeatEstimate {
  seatId: string;
  low: number;
  high: number;
  unit: "tokens";
}

export interface SessionEstimate {
  perSeat: SeatEstimate[];
  totalLow: number;
  totalHigh: number;
  /** Present only when every seat has pricing. */
  usd?: { low: number; high: number };
  notes: string[];
  /** `provider/model` keys of the seats with no pricing (empty when all are priced). */
  unpriced: string[];
}

interface SeatTurns {
  seat: Seat;
  lowTurns: number;
  highTurns: number;
}

export function estimateSession(input: EstimateInput): SessionEstimate {
  const turns = new Map<string, SeatTurns>();
  const order: string[] = [];

  const addTurns = (seat: Seat, low: number, high: number) => {
    let entry = turns.get(seat.id);
    if (!entry) {
      entry = { seat, lowTurns: 0, highTurns: 0 };
      turns.set(seat.id, entry);
      order.push(seat.id);
    }
    entry.lowTurns += low;
    entry.highTurns += high;
  };

  if (input.modes.negotiate) {
    const team = input.teams[input.modes.negotiate.team];
    if (team) {
      const seats = expandSeatSpecs(team.seats, { teamName: input.modes.negotiate.team });
      const { perSeat, aggregator } = negotiateTurns(
        input.modes.negotiate.strategy,
        input.modes.negotiate.maxRounds,
      );
      seats.forEach((seat, index) => {
        const extra = index === 0 ? aggregator : 0;
        addTurns(seat, perSeat + extra, perSeat + extra);
      });
    }
  }

  const review = input.modes.review;
  const reviewTeam = review ? input.teams[review.team] : input.reviewTeam;
  if (reviewTeam) {
    const seats = expandSeatSpecs(reviewTeam.seats, { teamName: review?.team });
    seats.forEach((seat, index) => {
      // Economy narrowing (TE-06): the low end has the first member only; a danger area brings the rest.
      addTurns(seat, input.narrowReview && index > 0 ? 0 : 1, input.maxRounds);
    });
  }
  if (input.executorTeam) {
    for (const seat of expandSeatSpecs(input.executorTeam.seats, { teamName: "executor" })) {
      addTurns(seat, 1, input.maxRounds);
    }
  }

  for (const seat of input.raceCandidates ?? []) addTurns(seat, 1, 1);

  const inPerTurn = input.contextTokens + EXTRA_INPUT_TOKENS;
  const perSeat: SeatEstimate[] = [];
  const notes: string[] = input.raceCandidates?.length ? [`race: ${input.raceCandidates.length} candidates build in parallel, ${input.raceCandidates.length}× the build cost`] : [];
  const unpriced: string[] = [];
  let totalLow = 0;
  let totalHigh = 0;
  let usdLow = 0;
  let usdHigh = 0;
  let allPriced = true;

  for (const id of order) {
    const entry = turns.get(id)!;
    const lowIn = entry.lowTurns * inPerTurn;
    const lowOut = entry.lowTurns * OUTPUT_TOKENS_LOW;
    const highIn = entry.highTurns * inPerTurn;
    const highOut = entry.highTurns * OUTPUT_TOKENS_HIGH;
    const low = lowIn + lowOut;
    const high = highIn + highOut;

    perSeat.push({ seatId: id, low, high, unit: "tokens" });
    totalLow += low;
    totalHigh += high;

    const key = `${entry.seat.provider}/${entry.seat.model}`;
    const price = input.pricing?.[key];
    if (price) {
      usdLow += (lowIn * price.inPerMTok + lowOut * price.outPerMTok) / 1_000_000;
      usdHigh += (highIn * price.inPerMTok + highOut * price.outPerMTok) / 1_000_000;
    } else {
      allPriced = false;
      if (!unpriced.includes(key)) unpriced.push(key);
      notes.push(
        entry.seat.transport === "cli"
          ? `${entry.seat.displayName} billed by subscription; no $ estimate`
          : `${entry.seat.displayName} has no pricing for ${key}; no $ estimate`,
      );
    }
  }

  const result: SessionEstimate = { perSeat, totalLow, totalHigh, notes, unpriced };
  if (allPriced) {
    result.usd = { low: usdLow, high: usdHigh };
  }
  return result;
}

function negotiateTurns(
  strategy: NegotiateMode["strategy"],
  maxRounds: number,
): { perSeat: number; aggregator: number } {
  switch (strategy) {
    case "debate":
      return { perSeat: maxRounds * 2, aggregator: 0 };
    case "vote":
      return { perSeat: 2, aggregator: 0 };
    case "synthesize":
      return { perSeat: 1, aggregator: 1 };
    case "best-of-n":
    case "divide":
      return { perSeat: 1, aggregator: 0 };
  }
}

export interface RunEstimateOptions {
  prompt: string;
  /** `solo`, or a mode id. Solo counts the executor, race its N candidates; other modes exclude it (their execute stages vary). */
  modeId: string;
  /** Observed prices (`usage/observed.ts`); seats without one stay unpriced. */
  pricing?: PricingTable;
  /** The executor model the run will use (`--executor-model`, else config); unset = AUTO. */
  executorModel?: string;
}

/**
 * The pre-run estimate of one run (TE-09): the review team's turns, the
 * executor's for solo, and the negotiate team's when the mode is `negotiate`.
 * The prompt stands in for the shared context. Pure: no model calls.
 */
export function estimateRun(config: AssentorConfig, options: RunEstimateOptions): SessionEstimate {
  const executor = resolveTeams(config).executor;
  const model = options.executorModel?.trim() || config.executor.model?.trim() || undefined;
  const executorTeam: Team = { ...executor, seats: executor.seats.map((seat) => ({ ...seat, ...(model ? { model } : {}) })) };
  let raceCandidates: Seat[] | undefined;
  if (options.modeId === "race") {
    const team = config.modes.race?.team;
    const base = typeof team === "string" && Object.hasOwn(config.teams, team) ? expandSeatSpecs(config.teams[team]!.seats, { teamName: team }) : expandSeatSpecs(executorTeam.seats);
    raceCandidates = raceCandidateSeats(base, raceSeatCount(config));
  }
  return estimateSession({
    teams: config.teams,
    modes: { negotiate: options.modeId === "negotiate" ? config.modes.negotiate : undefined },
    reviewTeam: resolveTeams(config).review,
    narrowReview: Boolean(config.run.narrowReview) && !config.modes.review,
    ...(options.modeId === "solo" ? { executorTeam } : {}),
    ...(raceCandidates ? { raceCandidates } : {}),
    contextTokens: estimateTokens(options.prompt),
    maxRounds: config.limits.maxRounds,
    pricing: options.pricing,
  });
}
