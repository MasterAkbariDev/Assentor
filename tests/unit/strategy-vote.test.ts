import { describe, expect, it } from "vitest";
import {
  expandSeatSpecs,
  NegotiationCancelledError,
  NegotiationResultSchema,
  proposalLabel,
} from "../../packages/engine/src/index.js";
import { getStrategy, listStrategies, registerBuiltinStrategies } from "../../packages/engine/src/negotiation/strategies/index.js";
import { voteStrategy } from "../../packages/engine/src/negotiation/strategies/vote.js";
import { createMockNegotiationContext, type MockAsk } from "../../packages/engine/src/negotiation/testing/mock-context.js";

// Labels follow seat order: opus-1 is A, opus-2 is B, sol-1 is C.
const seats = expandSeatSpecs([
  { provider: "claude-code", model: "opus", count: 2 },
  { provider: "codex", model: "sol" },
]);

const TEXT: Record<string, string> = {
  "opus-1": "use a queue",
  "opus-2": "use a lock",
  "sol-1": "use a cache",
};

/**
 * Scripted seats. `ballots` maps a seat to its ranking, or to `{ fail }` for an
 * operational failure. `failPropose` lists seats whose proposal fails.
 */
function script(ballots: Record<string, string[] | { fail: string }>, failPropose: string[] = []) {
  return (ask: MockAsk): unknown => {
    if (ask.step === "negotiate-propose") {
      return failPropose.includes(ask.seatId) ? { fail: "timeout" } : { proposal: TEXT[ask.seatId] };
    }
    if (ask.step === "negotiate-rank") {
      const ballot = ballots[ask.seatId];
      if (ballot === undefined) throw new Error(`no ballot scripted for ${ask.seatId}`);
      return Array.isArray(ballot) ? { ranking: ballot } : ballot;
    }
    throw new Error(`unexpected step ${ask.step}`);
  };
}

const A = "Proposal A";
const B = "Proposal B";
const C = "Proposal C";

/** Ballots where opus-1 and opus-2 rank C first and sol-1 ranks it first too (it is demoted). */
const clearWinner = {
  "opus-1": [C, A, B],
  "opus-2": [C, B, A],
  "sol-1": [C, A, B],
};

describe("vote strategy: results", () => {
  it("a 3-seat team picks the clear winner, after the self-vote move", async () => {
    const { ctx, events } = createMockNegotiationContext({ seats, script: script(clearWinner) });
    const result = await voteStrategy.run(ctx);

    expect(result.decision).toBe("use a cache");
    expect(result.rationale).toBe("Proposal C won with 4 of 6 points from 3 valid ballot(s)");
    expect(result.tallies).toEqual({ [A]: 3, [B]: 2, [C]: 4 });
    // sol-1 ranked its own proposal first, so C moved to last in its ballot.
    expect(result.votes).toEqual([
      { seatId: "opus-1", ranking: [C, A, B] },
      { seatId: "opus-2", ranking: [C, B, A] },
      { seatId: "sol-1", ranking: [A, B, C] },
    ]);
    expect(result.consensus.score).toBeCloseTo(4 / 6);
    expect(result.consensus.reached).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.dissent).toEqual([]);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "negotiation.proposal")).toHaveLength(3);
    expect(types.filter((t) => t === "negotiation.vote")).toHaveLength(3);
    expect(types.filter((t) => t === "negotiation.consensus")).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: "negotiation.consensus",
      data: { round: 2, score: 4 / 6, reached: true, preferred: C },
    });
  });

  it("breaks a tie toward the label that sorts first, and says so", async () => {
    const two = expandSeatSpecs([
      { provider: "claude-code", model: "opus" },
      { provider: "codex", model: "sol" },
    ]);
    const [first, second] = two.map((seat) => seat.id);
    // Two seats: A and B each get one point.
    const { ctx } = createMockNegotiationContext({
      seats: two,
      script: script({ [first!]: [B, A], [second!]: [A, B] }),
    });
    const result = await voteStrategy.run(ctx);

    expect(result.decision).toBe("use a queue");
    expect(result.tallies).toEqual({ [A]: 1, [B]: 1 });
    expect(result.rationale).toContain("tie-break: Proposal A is the earliest");
    // 1 of 2 possible points is 0.5, which is not above the threshold.
    expect(result.consensus).toEqual({ score: 0.5, reached: false });
  });

  it("breaks a tie between B and AA toward B (earliest in proposal order), not by sort order", async () => {
    // 27 proposals: index 26 is "Proposal AA". Sorted as text, "Proposal AA" would come before "Proposal B".
    // A spec holds at most 8 seats, so 27 seats take four specs.
    const big = expandSeatSpecs([
      { provider: "claude-code", model: "opus", count: 8 },
      { provider: "claude-code", model: "sonnet", count: 8 },
      { provider: "claude-code", model: "haiku", count: 8 },
      { provider: "codex", model: "sol", count: 3 },
    ]);
    expect(big).toHaveLength(27);
    const ids = big.map((seat) => seat.id);
    const labels = big.map((_, i) => proposalLabel(i));
    expect(labels[1]).toBe(B);
    expect(labels[26]).toBe("Proposal AA");
    const rest = labels.filter((label) => label !== B && label !== "Proposal AA");
    const bFirst = [B, "Proposal AA", ...rest];
    const aaFirst = ["Proposal AA", B, ...rest];
    // 0-based seats 0 and 2..13 rank B first; seat 1 and seats 14..25 rank AA first (each seat's
    // own proposal is never first, so no self-vote move); seat 26 submits an invalid ballot.
    // 26 ballots count and B and AA each get 663 points.
    const ballots: Record<string, string[]> = {};
    ids.forEach((id, i) => {
      ballots[id] = i === 26 ? ["Proposal Z"] : i === 1 || (i >= 14 && i <= 25) ? aaFirst : bFirst;
    });
    const { ctx } = createMockNegotiationContext({
      seats: big,
      script: (ask) => {
        if (ask.step === "negotiate-propose") return { proposal: `idea ${ids.indexOf(ask.seatId)}` };
        return { ranking: ballots[ask.seatId] };
      },
    });
    const result = await voteStrategy.run(ctx);

    expect(result.tallies![B]).toBe(result.tallies!["Proposal AA"]);
    expect(result.tallies![B]).toBeGreaterThan(result.tallies![A]!);
    expect(result.decision).toBe("idea 1");
    expect(result.rationale).toContain("tie-break: Proposal B is the earliest");
  });

  it("a seat that ranks its own proposal first has it moved to last, and says so", async () => {
    const { ctx } = createMockNegotiationContext({
      seats,
      script: script({
        "opus-1": [A, B, C], // own A first: moved to last
        "opus-2": [A, B, C], // own B not first: kept
        "sol-1": [C, A, B], // own C first: moved to last
      }),
    });
    const result = await voteStrategy.run(ctx);

    expect(result.votes).toEqual([
      { seatId: "opus-1", ranking: [B, C, A] },
      { seatId: "opus-2", ranking: [A, B, C] },
      { seatId: "sol-1", ranking: [A, B, C] },
    ]);
    expect(result.tallies).toEqual({ [A]: 4, [B]: 4, [C]: 1 });
    expect(result.dissent).toEqual([]);
  });
});

describe("vote strategy: invalid ballots", () => {
  it.each([
    ["an unknown label", [C, A, "Proposal Z"]],
    ["a duplicate label", [C, C, A]],
    ["a missing proposal", [C, A]],
  ])("ignores a ballot with %s and records it as dissent", async (_kind, ranking) => {
    const { ctx, events } = createMockNegotiationContext({
      seats,
      script: script({ "opus-1": [C, A, B], "opus-2": [C, A, B], "sol-1": ranking }),
    });
    const result = await voteStrategy.run(ctx);

    expect(result.dissent).toEqual([{ seatId: "sol-1", reason: "invalid ballot" }]);
    expect(result.votes!.map((v) => v.seatId)).toEqual(["opus-1", "opus-2"]);
    expect(result.tallies).toEqual({ [A]: 2, [B]: 0, [C]: 4 });
    expect(result.consensus.score).toBe(1);
    expect(events.filter((e) => e.type === "negotiation.vote")).toHaveLength(2);
  });

  it("records a failed ranking reply as dissent with its error", async () => {
    const { ctx } = createMockNegotiationContext({
      seats,
      script: script({ "opus-1": [C, A, B], "opus-2": [C, A, B], "sol-1": { fail: "rate limited" } }),
    });
    const result = await voteStrategy.run(ctx);
    expect(result.dissent).toEqual([{ seatId: "sol-1", reason: "rate limited" }]);
    expect(result.votes!).toHaveLength(2);
  });

  it("with no valid ballot there is no winner, and the score is 0", async () => {
    const { ctx, events } = createMockNegotiationContext({
      seats,
      script: script({ "opus-1": ["Proposal Z"], "opus-2": ["Proposal Z"], "sol-1": ["Proposal Z"] }),
    });
    const result = await voteStrategy.run(ctx);

    expect(result.decision).toBe("");
    expect(result.rationale).toBe("no valid ballots, so no winner");
    expect(result.votes).toEqual([]);
    expect(result.tallies).toEqual({ [A]: 0, [B]: 0, [C]: 0 });
    expect(result.dissent).toHaveLength(3);
    expect(result.consensus).toEqual({ score: 0, reached: false });
    expect(events.at(-1)).toEqual({ type: "negotiation.consensus", data: { round: 2, score: 0, reached: false } });
  });
});

describe("vote strategy: proposals and failures", () => {
  it("a failed proposal is dissent, and that seat still ranks", async () => {
    const { ctx, asks } = createMockNegotiationContext({
      seats,
      script: script({ "opus-1": [B, A], "opus-2": [A, B], "sol-1": [B, A] }, ["sol-1"]),
    });
    const result = await voteStrategy.run(ctx);

    expect(result.proposals.map((p) => p.label)).toEqual([A, B]);
    expect(result.dissent).toEqual([{ seatId: "sol-1", reason: "timeout" }]);
    expect(asks.filter((a) => a.step === "negotiate-rank").map((a) => a.seatId)).toEqual(["opus-1", "opus-2", "sol-1"]);
    expect(result.decision).toBe("use a lock");
    expect(result.tallies).toEqual({ [A]: 1, [B]: 2 });
    expect(result.consensus.score).toBeCloseTo(2 / 3);
  });

  it("one proposal wins without a vote round", async () => {
    const { ctx, asks, events } = createMockNegotiationContext({
      seats,
      script: script({}, ["opus-2", "sol-1"]),
    });
    const result = await voteStrategy.run(ctx);

    expect(result.decision).toBe("use a queue");
    expect(result.rationale).toBe("only one proposal");
    expect(result.rounds).toBe(1);
    expect(result.consensus).toEqual({ score: 1, reached: true });
    expect(asks.filter((a) => a.step === "negotiate-rank")).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: "negotiation.consensus",
      data: { round: 1, score: 1, reached: true, preferred: A },
    });
  });

  it("no proposal means no decision", async () => {
    const { ctx, events } = createMockNegotiationContext({
      seats,
      script: script({}, ["opus-1", "opus-2", "sol-1"]),
    });
    const result = await voteStrategy.run(ctx);

    expect(result.decision).toBe("");
    expect(result.rationale).toBe("no proposals");
    expect(result.consensus).toEqual({ score: 0, reached: false });
    expect(result.dissent).toHaveLength(3);
    expect(events).toEqual([{ type: "negotiation.consensus", data: { round: 1, score: 0, reached: false } }]);
  });
});

describe("vote strategy: cancellation, schema and privacy", () => {
  it("rejects with NegotiationCancelledError when aborted before round 2", async () => {
    const controller = new AbortController();
    const base = script(clearWinner);
    const { ctx, asks } = createMockNegotiationContext({
      seats,
      signal: controller.signal,
      script: (ask) => {
        const reply = base(ask);
        // Abort while round 1 is still in flight, after the last proposal arrives.
        if (ask.step === "negotiate-propose" && ask.seatId === "sol-1") controller.abort();
        return reply;
      },
    });

    await expect(voteStrategy.run(ctx)).rejects.toBeInstanceOf(NegotiationCancelledError);
    expect(asks.filter((a) => a.step === "negotiate-rank")).toHaveLength(0);
  });

  it("every result passes NegotiationResultSchema and is deterministic", async () => {
    const run = () => voteStrategy.run(createMockNegotiationContext({ seats, script: script(clearWinner) }).ctx);
    const first = await run();

    expect(NegotiationResultSchema.parse(first)).toEqual(first);
    expect(await run()).toEqual(first);
  });

  it("no seat id reaches any step's vars", async () => {
    const { ctx, asks } = createMockNegotiationContext({ seats, script: script(clearWinner) });
    await voteStrategy.run(ctx);

    expect(asks.length).toBeGreaterThan(0);
    expect(JSON.stringify(asks.map((a) => a.vars))).not.toMatch(/opus-1|opus-2|sol-1/);
  });

  it("validate needs at least two seats", () => {
    expect(voteStrategy.validate(expandSeatSpecs([{ provider: "claude-code", model: "opus" }]), {})).toBe(
      "needs at least two seats",
    );
    expect(voteStrategy.validate(seats, {})).toBeUndefined();
  });

  it("registers only when asked, and only once", () => {
    expect(getStrategy("vote")).toBeUndefined();
    registerBuiltinStrategies();
    registerBuiltinStrategies();
    expect(getStrategy("vote")).toBe(voteStrategy);
    expect(listStrategies()).toContain("vote");
  });
});
