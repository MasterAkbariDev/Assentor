import { expandSeatSpecs, type Seat, type Team } from "../core/seats.js";
import type { NegotiateMode, ReviewMode } from "../config/teams.js";

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
 * - Only teams referenced by `modes` are estimated.
 */

export const EXTRA_INPUT_TOKENS = 2_000;
export const OUTPUT_TOKENS_LOW = 1_500;
export const OUTPUT_TOKENS_HIGH = 4_000;

export interface ModelPricing {
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens. */
  outPerMTok: number;
}

/** Keyed by `"<provider>/<model>"`, e.g. `"openai/gpt-4o-mini"`. */
export type PricingTable = Record<string, ModelPricing>;

export interface EstimateInput {
  teams: Record<string, Team>;
  modes: { negotiate?: NegotiateMode; review?: ReviewMode };
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

  if (input.modes.review) {
    const team = input.teams[input.modes.review.team];
    if (team) {
      const seats = expandSeatSpecs(team.seats, { teamName: input.modes.review.team });
      for (const seat of seats) {
        addTurns(seat, 1, input.maxRounds);
      }
    }
  }

  const inPerTurn = input.contextTokens + EXTRA_INPUT_TOKENS;
  const perSeat: SeatEstimate[] = [];
  const notes: string[] = [];
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
      notes.push(
        entry.seat.transport === "cli"
          ? `${entry.seat.displayName} billed by subscription; no $ estimate`
          : `${entry.seat.displayName} has no pricing for ${key}; no $ estimate`,
      );
    }
  }

  const result: SessionEstimate = { perSeat, totalLow, totalHigh, notes };
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
