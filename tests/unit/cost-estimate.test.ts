import { describe, expect, it } from "vitest";
import { TeamSchema } from "../../src/core/seats.js";
import { estimateSession, type PricingTable } from "../../src/estimate/cost.js";

// Heuristic constants (see src/estimate/cost.ts):
//   input per turn  = contextTokens + 2_000
//   output per turn = 1_500 (low), 4_000 (high)
// A debate with maxRounds 3 is 3 × 2 = 6 turns per seat.

const debate = { team: "t", strategy: "debate" as const, maxRounds: 3, consensus: 0.7 };

describe("estimateSession", () => {
  it("single CLI seat in a debate with contextTokens 10_000 and no pricing", () => {
    // inPerTurn = 10_000 + 2_000 = 12_000
    // low  = 6 × 12_000 + 6 × 1_500 = 72_000 + 9_000 = 81_000
    // high = 6 × 12_000 + 6 × 4_000 = 72_000 + 24_000 = 96_000
    const estimate = estimateSession({
      teams: { t: TeamSchema.parse({ seats: [{ provider: "claude-code", model: "opus" }] }) },
      modes: { negotiate: debate },
      contextTokens: 10_000,
      maxRounds: 3,
    });

    expect(estimate.perSeat).toEqual([{ seatId: "t.opus-1", low: 81_000, high: 96_000, unit: "tokens" }]);
    expect(estimate.totalLow).toBe(81_000);
    expect(estimate.totalHigh).toBe(96_000);
    expect(estimate.usd).toBeUndefined();
    expect(estimate.notes).toEqual(["Opus#1 billed by subscription; no $ estimate"]);
  });

  it("five CLI seats in a debate: each seat is 81_000 / 96_000, totals are 5×", () => {
    // Per seat as above: low 81_000, high 96_000.
    // Totals: low 5 × 81_000 = 405_000, high 5 × 96_000 = 480_000.
    const estimate = estimateSession({
      teams: { t: TeamSchema.parse({ seats: [{ provider: "claude-code", model: "opus", count: 5 }] }) },
      modes: { negotiate: debate },
      contextTokens: 10_000,
      maxRounds: 3,
    });

    expect(estimate.perSeat).toHaveLength(5);
    expect(estimate.perSeat.every((s) => s.low === 81_000 && s.high === 96_000)).toBe(true);
    expect(estimate.totalLow).toBe(405_000);
    expect(estimate.totalHigh).toBe(480_000);
    expect(estimate.usd).toBeUndefined();
    expect(estimate.notes).toHaveLength(5);
  });

  it("mixed pricing: usd is omitted and only the unpriced CLI seat gets a note", () => {
    const pricing: PricingTable = { "openai/gpt-4o-mini": { inPerMTok: 0.15, outPerMTok: 0.6 } };
    const estimate = estimateSession({
      teams: {
        t: TeamSchema.parse({
          seats: [
            { provider: "openai", model: "gpt-4o-mini" },
            { provider: "claude-code", model: "opus" },
          ],
        }),
      },
      modes: { negotiate: debate },
      contextTokens: 10_000,
      maxRounds: 3,
      pricing,
    });

    expect(estimate.usd).toBeUndefined();
    expect(estimate.notes).toEqual(["Opus#1 billed by subscription; no $ estimate"]);
    expect(estimate.perSeat).toHaveLength(2);
  });

  it("every seat priced: usd is computed from the per-seat in and out tokens", () => {
    // Single openai/gpt-4o-mini seat, same debate as above: 72_000 input tokens and
    // 9_000 (low) / 24_000 (high) output tokens.
    // low  usd = 72_000 × 0.15 / 1e6 + 9_000 × 0.6 / 1e6 = 0.0108 + 0.0054 = 0.0162
    // high usd = 72_000 × 0.15 / 1e6 + 24_000 × 0.6 / 1e6 = 0.0108 + 0.0144 = 0.0252
    const estimate = estimateSession({
      teams: { t: TeamSchema.parse({ seats: [{ provider: "openai", model: "gpt-4o-mini" }] }) },
      modes: { negotiate: debate },
      contextTokens: 10_000,
      maxRounds: 3,
      pricing: { "openai/gpt-4o-mini": { inPerMTok: 0.15, outPerMTok: 0.6 } },
    });

    expect(estimate.usd?.low).toBeCloseTo(0.0162, 10);
    expect(estimate.usd?.high).toBeCloseTo(0.0252, 10);
    expect(estimate.notes).toEqual([]);
  });

  it("review: low uses 1 round and high uses maxRounds", () => {
    // contextTokens 0 → inPerTurn 2_000.
    // low  (1 round)  = 1 × 2_000 + 1 × 1_500 = 3_500
    // high (4 rounds) = 4 × 2_000 + 4 × 4_000 = 8_000 + 16_000 = 24_000
    const estimate = estimateSession({
      teams: { r: TeamSchema.parse({ seats: [{ provider: "mock" }] }) },
      modes: { review: { team: "r", policy: "security-veto", tiebreak: "adjudicator" } },
      contextTokens: 0,
      maxRounds: 4,
    });

    expect(estimate.perSeat).toEqual([{ seatId: "r.mock-1", low: 3_500, high: 24_000, unit: "tokens" }]);
    expect(estimate.totalLow).toBe(3_500);
    expect(estimate.totalHigh).toBe(24_000);
    expect(estimate.notes).toEqual(["Mock#1 has no pricing for mock/AUTO; no $ estimate"]);
  });

  it("synthesize: the aggregator turn is added to the team's first seat only", () => {
    // contextTokens 0 → inPerTurn 2_000. Synthesize is 1 turn per seat, plus 1 aggregator turn.
    // seat 1: 2 turns → low 2 × (2_000 + 1_500) = 7_000, high 2 × (2_000 + 4_000) = 12_000
    // seat 2: 1 turn  → low 1 × (2_000 + 1_500) = 3_500, high 1 × (2_000 + 4_000) = 6_000
    // totals: low 10_500, high 18_000
    const estimate = estimateSession({
      teams: { s: TeamSchema.parse({ seats: [{ provider: "mock" }, { provider: "mock" }] }) },
      modes: { negotiate: { team: "s", strategy: "synthesize", maxRounds: 3, consensus: 0.7 } },
      contextTokens: 0,
      maxRounds: 3,
    });

    expect(estimate.perSeat.map((s) => [s.seatId, s.low, s.high])).toEqual([
      ["s.mock-1", 7_000, 12_000],
      ["s.mock-2", 3_500, 6_000],
    ]);
    expect(estimate.totalLow).toBe(10_500);
    expect(estimate.totalHigh).toBe(18_000);
  });

  it("vote: 2 turns per seat", () => {
    // contextTokens 0 → inPerTurn 2_000. 2 turns:
    // low 2 × (2_000 + 1_500) = 7_000, high 2 × (2_000 + 4_000) = 12_000
    const estimate = estimateSession({
      teams: { v: TeamSchema.parse({ seats: [{ provider: "mock" }] }) },
      modes: { negotiate: { team: "v", strategy: "vote", maxRounds: 3, consensus: 0.7 } },
      contextTokens: 0,
      maxRounds: 3,
    });

    expect(estimate.perSeat).toEqual([{ seatId: "v.mock-1", low: 7_000, high: 12_000, unit: "tokens" }]);
  });

  it("a mode that names no team in the config estimates nothing", () => {
    const estimate = estimateSession({
      teams: {},
      modes: { negotiate: { team: "missing", strategy: "debate", maxRounds: 3, consensus: 0.7 } },
      contextTokens: 10_000,
      maxRounds: 3,
    });

    expect(estimate.perSeat).toEqual([]);
    expect(estimate.totalLow).toBe(0);
    expect(estimate.totalHigh).toBe(0);
  });
});
