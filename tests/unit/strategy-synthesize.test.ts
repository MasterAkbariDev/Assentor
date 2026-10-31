import { describe, expect, it } from "vitest";
import { expandSeatSpecs, NegotiationCancelledError, NegotiationResultSchema } from "../../packages/engine/src/index.js";
import { getStrategy, registerBuiltinStrategies } from "../../packages/engine/src/negotiation/strategies/index.js";
import { synthesizeStrategy } from "../../packages/engine/src/negotiation/strategies/synthesize.js";
import { createMockNegotiationContext, type MockAsk } from "../../packages/engine/src/negotiation/testing/mock-context.js";

// The aggregator is sol-1. opus-1 proposes Proposal A and opus-2 proposes Proposal B.
const seats = expandSeatSpecs([
  { provider: "claude-code", model: "opus", count: 2 },
  { provider: "codex", model: "sol" },
]);
const AGG = "sol-1";
const A = "Proposal A";
const B = "Proposal B";

const TEXT: Record<string, string> = {
  "opus-1": "use a queue",
  "opus-2": "use a lock",
};

/**
 * Scripted seats. Proposers reply with their text (or `{ fail }` for seats in
 * `failPropose`). The aggregator replies with `synthesis`, which may be `{ fail }`.
 */
function script(synthesis: unknown, failPropose: string[] = []) {
  return (ask: MockAsk): unknown => {
    if (ask.step === "negotiate-propose") {
      return failPropose.includes(ask.seatId) ? { fail: "timeout" } : { proposal: TEXT[ask.seatId] };
    }
    if (ask.step === "negotiate-synthesize") return synthesis;
    throw new Error(`unexpected step ${ask.step}`);
  };
}

const bothCited = {
  answer: "queue for writes, lock for reads",
  sources: [
    { label: A, used: "the queue" },
    { label: B, used: "the lock" },
  ],
};

describe("synthesize strategy: validate", () => {
  it("needs an aggregator that is in the team", () => {
    const message = "synthesize requires an aggregator seat in the team";
    expect(synthesizeStrategy.validate(seats, {})).toBe(message);
    expect(synthesizeStrategy.validate(seats, { aggregator: "nobody" })).toBe(message);
    expect(synthesizeStrategy.validate(seats, { aggregator: 3 })).toBe(message);
    expect(synthesizeStrategy.validate(seats, { aggregator: AGG })).toBeUndefined();
  });

  it("needs at least one other seat besides the aggregator", () => {
    const alone = expandSeatSpecs([{ provider: "claude-code", model: "opus" }]);
    expect(synthesizeStrategy.validate(alone, { aggregator: "opus-1" })).toBe(
      "synthesize needs at least one proposing seat besides the aggregator",
    );
  });
});

describe("synthesize strategy: results", () => {
  it("happy path: the aggregator's answer is the decision, and both proposals are cited", async () => {
    const { ctx, asks, events } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script(bothCited),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.decision).toBe("queue for writes, lock for reads");
    expect(result.rationale).toBe("synthesized from 2 of 2 proposals");
    expect(result.consensus).toEqual({ score: 1, reached: true });
    expect(result.rounds).toBe(2);
    expect(result.dissent).toEqual([]);
    expect(result.proposals).toEqual([
      { label: A, seatId: "opus-1", text: "use a queue" },
      { label: B, seatId: "opus-2", text: "use a lock" },
    ]);
    // Only the non-aggregator seats propose.
    expect(asks.filter((a) => a.step === "negotiate-propose").map((a) => a.seatId)).toEqual(["opus-1", "opus-2"]);
    expect(asks.find((a) => a.step === "negotiate-synthesize")!.seatId).toBe(AGG);
    expect(events.at(-1)).toEqual({ type: "negotiation.consensus", data: { round: 2, score: 1, reached: true } });
  });

  it("an unknown label is dissent, and that proposal is not counted", async () => {
    const { ctx } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script({ answer: "queue", sources: [{ label: "Proposal Z", used: "x" }, { label: A, used: "queue" }] }),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.dissent).toEqual([{ seatId: AGG, reason: "aggregator cited unknown proposal Proposal Z" }]);
    expect(result.rationale).toBe("synthesized from 1 of 2 proposals; not used: Proposal B");
    expect(result.consensus).toEqual({ score: 0.5, reached: false });
  });

  it("a proposal cited twice counts once", async () => {
    const { ctx } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script({ answer: "queue", sources: [{ label: A, used: "one" }, { label: A, used: "two" }] }),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.rationale).toBe("synthesized from 1 of 2 proposals; not used: Proposal B");
    expect(result.consensus.score).toBe(0.5);
    expect(result.dissent).toEqual([]);
  });

  it("lists the uncited proposals in the rationale", async () => {
    const { ctx } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script({ answer: "queue", sources: [{ label: "proposal a", used: "queue" }] }),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.rationale).toContain("not used: Proposal B");
    expect(result.decision).toBe("queue");
  });

  it("a failed aggregator reply gives no decision, dissent, and a round-2 consensus", async () => {
    const { ctx, events } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script({ fail: "rate limited" }),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.decision).toBe("");
    expect(result.dissent).toEqual([{ seatId: AGG, reason: "rate limited" }]);
    expect(result.consensus).toEqual({ score: 0, reached: false });
    expect(result.rounds).toBe(2);
    expect(events.at(-1)).toEqual({ type: "negotiation.consensus", data: { round: 2, score: 0, reached: false } });
  });

  it("a failed proposer is dissent, and the rest still synthesize", async () => {
    const { ctx, asks } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script({ answer: "lock", sources: [{ label: A, used: "lock" }] }, ["opus-1"]),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.dissent).toEqual([{ seatId: "opus-1", reason: "timeout" }]);
    // Labels follow the proposals that arrived, so opus-2's proposal is the only one, Proposal A.
    expect(result.proposals).toEqual([{ label: A, seatId: "opus-2", text: "use a lock" }]);
    expect(result.consensus).toEqual({ score: 1, reached: true });
    expect(asks.find((a) => a.step === "negotiate-synthesize")!.vars).toMatchObject({
      proposals: [{ label: A, text: "use a lock" }],
    });
  });

  it("synthesizes from a single proposal", async () => {
    const { ctx } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script({ answer: "queue", sources: [{ label: A, used: "queue" }] }, ["opus-2"]),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.rationale).toBe("synthesized from 1 of 1 proposals");
    expect(result.consensus).toEqual({ score: 1, reached: true });
  });

  it("zero proposals skip round 2 and emit one round-1 consensus", async () => {
    const { ctx, asks, events } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script(bothCited, ["opus-1", "opus-2"]),
    });
    const result = await synthesizeStrategy.run(ctx);

    expect(result.decision).toBe("");
    expect(result.consensus).toEqual({ score: 0, reached: false });
    expect(result.rounds).toBe(1);
    expect(result.dissent).toHaveLength(2);
    expect(asks.filter((a) => a.step === "negotiate-synthesize")).toHaveLength(0);
    expect(events).toEqual([{ type: "negotiation.consensus", data: { round: 1, score: 0, reached: false } }]);
  });
});

describe("synthesize strategy: cancellation, schema and privacy", () => {
  it("rejects with NegotiationCancelledError when aborted before round 2", async () => {
    const controller = new AbortController();
    const base = script(bothCited);
    const { ctx, asks } = createMockNegotiationContext({
      seats,
      signal: controller.signal,
      options: { aggregator: AGG },
      script: (ask) => {
        const reply = base(ask);
        if (ask.step === "negotiate-propose" && ask.seatId === "opus-2") controller.abort();
        return reply;
      },
    });

    await expect(synthesizeStrategy.run(ctx)).rejects.toBeInstanceOf(NegotiationCancelledError);
    expect(asks.filter((a) => a.step === "negotiate-synthesize")).toHaveLength(0);
  });

  it("every result passes NegotiationResultSchema and is deterministic", async () => {
    const run = () =>
      synthesizeStrategy.run(
        createMockNegotiationContext({ seats, options: { aggregator: AGG }, script: script(bothCited) }).ctx,
      );
    const first = await run();

    expect(NegotiationResultSchema.parse(first)).toEqual(first);
    expect(await run()).toEqual(first);
  });

  it("no seat id reaches any step's vars", async () => {
    const { ctx, asks } = createMockNegotiationContext({
      seats,
      options: { aggregator: AGG },
      script: script(bothCited),
    });
    await synthesizeStrategy.run(ctx);

    expect(asks.length).toBeGreaterThan(0);
    expect(JSON.stringify(asks.map((a) => a.vars))).not.toMatch(/opus-1|opus-2|sol-1/);
  });

  it("registers with the built-ins, once", () => {
    expect(getStrategy("synthesize")).toBeUndefined();
    registerBuiltinStrategies();
    registerBuiltinStrategies();
    expect(getStrategy("synthesize")).toBe(synthesizeStrategy);
  });
});
