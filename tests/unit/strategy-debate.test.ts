import { describe, expect, it } from "vitest";
import { expandSeatSpecs, NegotiationCancelledError, NegotiationResultSchema } from "../../src/index.js";
import { getStrategy, listStrategies, registerBuiltinStrategies } from "../../src/negotiation/strategies/index.js";
import { debateStrategy } from "../../src/negotiation/strategies/debate.js";
import { createMockNegotiationContext, type MockAsk } from "../../src/negotiation/testing/mock-context.js";

// Labels follow seat order: opus-1 is A, opus-2 is B, sol-1 is C.
const seats = expandSeatSpecs([
  { provider: "claude-code", model: "opus", count: 2 },
  { provider: "codex", model: "sol" },
]);
const withModerator = expandSeatSpecs([
  { provider: "claude-code", model: "opus", count: 2 },
  { provider: "codex", model: "sol" },
  { provider: "antigravity", model: "mod" },
]);
const [S1, S2, S3] = seats.map((s) => s.id) as [string, string, string];
const MOD = withModerator[3]!.id;

const A = "Proposal A";
const B = "Proposal B";
const C = "Proposal C";

interface Opts {
  /** Agreement per round (1-based) and seat; default: everyone agrees on `agree` with confidence 1. */
  agree?: (ask: MockAsk, round: number) => unknown;
  critique?: (ask: MockAsk, round: number) => unknown;
  propose?: (ask: MockAsk) => unknown;
  revise?: (ask: MockAsk) => unknown;
  moderator?: unknown;
  judge?: unknown;
}

function script(o: Opts = {}) {
  const round = (ask: MockAsk) => (ask.vars.round as number | undefined) ?? 1;
  return (ask: MockAsk): unknown => {
    switch (ask.step) {
      case "negotiate-propose":
        return o.propose ? o.propose(ask) : { proposal: `plan from ${ask.seatId}` };
      case "negotiate-revise":
        return o.revise ? o.revise(ask) : { proposal: `${ask.vars.proposal} v${round(ask)}` };
      case "negotiate-critique":
        return o.critique ? o.critique(ask, round(ask)) : { critiques: [] };
      case "negotiate-agree":
        return o.agree ? o.agree(ask, round(ask)) : { agree: true, preferred: A, confidence: 1 };
      case "moderator":
        return o.moderator ?? { consensus: false, preferred: B, reasons: ["ok"] };
      case "judge":
        return o.judge ?? { winner: C, reasons: ["ok"] };
      default:
        throw new Error(`unexpected step ${ask.step}`);
    }
  };
}

const split = (ask: MockAsk) => ({ agree: false, preferred: ask.seatId === S1 ? A : ask.seatId === S2 ? B : C, confidence: 0.8 });

async function run(o: Opts = {}, options: Record<string, unknown> = {}, team = seats, signal?: AbortSignal) {
  const mock = createMockNegotiationContext({ seats: team, script: script(o), options, signal });
  const result = await debateStrategy.run(mock.ctx);
  expect(() => NegotiationResultSchema.parse(result)).not.toThrow();
  return { result, ...mock };
}

describe("debate: convergence", () => {
  it("converges in round 1", async () => {
    const { result, events, asks } = await run();
    expect(result.decision).toBe(`plan from ${S1}`);
    expect(result.rounds).toBe(1);
    expect(result.consensus).toEqual({ score: 1, reached: true });
    expect(result.dissent).toEqual([]);
    expect(asks.some((a) => a.step === "negotiate-revise")).toBe(false);
    expect(events.filter((e) => e.type === "negotiation.proposal")).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "negotiation.consensus", data: { round: 1, score: 1, reached: true, preferred: A } });
  });

  it("converges in round 3 after revisions", async () => {
    const { result, events, asks } = await run({
      agree: (ask, round) => (round < 3 ? split(ask) : { agree: true, preferred: B, confidence: 1 }),
    });
    expect(result.rounds).toBe(3);
    expect(result.consensus.reached).toBe(true);
    expect(result.decision).toBe(`plan from ${S2} v2 v3`);
    expect(asks.filter((a) => a.step === "negotiate-revise")).toHaveLength(6);
    const consensusEvents = events.filter((e) => e.type === "negotiation.consensus");
    expect(consensusEvents.map((e) => e.data.reached)).toEqual([false, false, true]);
    expect(events.filter((e) => e.type === "negotiation.proposal")).toHaveLength(9);
  });

  it("revise vars carry the critiques the seat's proposal received, without critic ids", async () => {
    const { asks } = await run({
      agree: (ask, round) => (round < 2 ? split(ask) : { agree: true, preferred: A, confidence: 1 }),
      critique: (ask) => (ask.seatId === S2 ? { critiques: [{ target: A, text: "racy", citations: ["a.ts:1"] }] } : { critiques: [] }),
    });
    const revise = asks.find((a) => a.step === "negotiate-revise" && a.seatId === S1)!;
    expect(revise.vars.critiques).toEqual([{ text: "racy", citations: ["a.ts:1"] }]);
    expect(revise.vars.label).toBe(A);
  });
});

describe("debate: no convergence", () => {
  it("the moderator decides and every seat that preferred another proposal is recorded", async () => {
    const { result, asks } = await run(
      { agree: split, moderator: { consensus: false, preferred: "proposal b", reasons: ["B is safest"] } },
      { moderator: MOD, maxRounds: 2 },
      withModerator,
    );
    expect(result.rounds).toBe(2);
    expect(result.consensus.reached).toBe(false);
    expect(result.decision).toContain(S2);
    expect(result.rationale).toContain("the moderator chose Proposal B");
    // The moderator never proposes, critiques or votes.
    expect(asks.filter((a) => a.seatId === MOD).map((a) => a.step)).toEqual(["moderator"]);
    // Every seat answered agree:false, so every seat is recorded with the label it preferred.
    expect(result.dissent.map((d) => [d.seatId, d.label])).toEqual([
      [S1, A],
      [S2, B],
      [S3, C],
    ]);
    expect(result.proposals.map((p) => p.seatId)).toEqual([S1, S2, S3]);
  });

  it("without a moderator the judge step runs on the first seat", async () => {
    const { result, asks } = await run({ agree: split }, { maxRounds: 1 });
    const judge = asks.filter((a) => a.step === "judge");
    expect(judge.map((a) => a.seatId)).toEqual([S1]);
    expect(result.rationale).toContain("the judge chose Proposal C");
    expect(result.decision).toContain(S3);
  });

  it("falls back to the leader of the last check when the ruling is unusable", async () => {
    const { result } = await run({ agree: split, judge: { winner: "Proposal Z", reasons: ["?"] } }, { maxRounds: 1 });
    expect(result.rationale).toContain("no usable ruling");
    expect(result.decision).toContain(S1); // ties go to the earliest label
  });
});

describe("debate: devil's advocate", () => {
  it("never counts toward the score and is not asked for agreement", async () => {
    // opus-2 is the devil's advocate; if it were counted, the score would be 2/3.
    const { result, asks } = await run(
      { agree: (ask) => ({ agree: true, preferred: A, confidence: 1 }) },
      { devilsAdvocate: S2, consensus: 1 },
    );
    expect(result.consensus).toEqual({ score: 1, reached: true });
    expect(asks.filter((a) => a.step === "negotiate-agree").map((a) => a.seatId)).toEqual([S1, S3]);
    // It still proposes and critiques, so its words are in the transcript.
    expect(result.proposals.map((p) => p.seatId)).toContain(S2);
    expect(asks.some((a) => a.seatId === S2 && a.step === "negotiate-critique")).toBe(true);
  });
});

describe("debate: critiques", () => {
  it("drops self-targeted and unknown-target critiques and records them", async () => {
    const { result, events } = await run({
      critique: (ask) =>
        ask.seatId === S1
          ? {
              critiques: [
                { target: A, text: "mine is fine", citations: [] },
                { target: "Proposal Q", text: "who?", citations: [] },
                { target: "b", text: "ok", citations: ["x.ts:2"] },
              ],
            }
          : { critiques: [] },
    });
    const critiqueEvents = events.filter((e) => e.type === "negotiation.critique");
    expect(critiqueEvents).toHaveLength(1);
    expect(critiqueEvents[0]).toMatchObject({ seatId: S1, data: { round: 1, targetLabel: B } });
    expect(result.dissent.map((d) => d.reason)).toEqual([
      "critique dropped in round 1: targets the critic's own proposal",
      'critique dropped in round 1: unknown target "Proposal Q"',
    ]);
    expect(result.dissent.every((d) => d.seatId === S1)).toBe(true);
  });

  it("critics are never shown their own proposal", async () => {
    const { asks } = await run();
    for (const ask of asks.filter((a) => a.step === "negotiate-critique")) {
      const own = ask.seatId === S1 ? A : ask.seatId === S2 ? B : C;
      expect((ask.vars.proposals as Array<{ label: string }>).map((p) => p.label)).not.toContain(own);
    }
  });

  it("an uncited critique weighs 0.5 against the leader, a cited one 1", async () => {
    const against = (citations: string[]) => (ask: MockAsk) =>
      ask.seatId === S2 ? { critiques: [{ target: A, text: "hmm", citations }] } : { critiques: [] };
    // base score 1, V = 3 voters: score = 1 − 0.5·W/(W+3)
    const cited = await run({ critique: against(["a.ts:1"]) }, { consensus: 0 });
    const uncited = await run({ critique: against([]) }, { consensus: 0 });
    const blank = await run({ critique: against(["  "]) }, { consensus: 0 });
    expect(cited.result.consensus.score).toBeCloseTo(1 - (0.5 * 1) / (1 + 3));
    expect(uncited.result.consensus.score).toBeCloseTo(1 - (0.5 * 0.5) / (0.5 + 3));
    expect(blank.result.consensus.score).toBeCloseTo(uncited.result.consensus.score);
    expect(uncited.result.consensus.score).toBeGreaterThan(cited.result.consensus.score);
  });

  it("enough cited criticism keeps an otherwise unanimous round below the threshold", async () => {
    const allCite = (ask: MockAsk) => ({
      critiques: [A, B, C].filter((l) => l !== (ask.seatId === S1 ? A : ask.seatId === S2 ? B : C)).map((target) => ({ target, text: "x", citations: ["f.ts:1"] })),
    });
    // A is criticised by two seats: W = 2, V = 3 → 1 − 0.5·2/5 = 0.8
    const { result } = await run({ critique: allCite }, { consensus: 0.9, maxRounds: 1 });
    expect(result.consensus.reached).toBe(false);
    expect(result.consensus.score).toBeCloseTo(0.8);
  });
});

describe("debate: failures, cancellation, determinism", () => {
  it("a failed proposal drops the seat; failed revise/critique/agree replies are dissent", async () => {
    const { result, asks } = await run({
      propose: (ask) => (ask.seatId === S3 ? { fail: "timeout" } : { proposal: `plan from ${ask.seatId}` }),
      agree: (ask, round) => (round === 1 ? { fail: "rate limit" } : { agree: true, preferred: A, confidence: 1 }),
      critique: (ask) => (ask.seatId === S2 ? { fail: "boom" } : { critiques: [] }),
      revise: (ask) => (ask.seatId === S1 ? { fail: "nope" } : { proposal: "better" }),
    });
    expect(result.proposals.map((p) => p.seatId)).toEqual([S1, S2]);
    expect(asks.some((a) => a.seatId === S3 && a.step !== "negotiate-propose")).toBe(false);
    const reasons = result.dissent.map((d) => `${d.seatId}: ${d.reason}`);
    expect(reasons).toContain(`${S3}: negotiate-propose failed in round 1: timeout`);
    expect(reasons).toContain(`${S2}: negotiate-critique failed in round 1: boom`);
    expect(reasons).toContain(`${S1}: negotiate-agree failed in round 1: rate limit`);
    expect(reasons).toContain(`${S1}: negotiate-revise failed in round 2: nope`);
    expect(result.rounds).toBe(2);
    // S1's failed revision kept its previous text.
    expect(result.proposals.find((p) => p.seatId === S1)!.text).toBe(`plan from ${S1}`);
  });

  it("one surviving proposal wins with a vacuous consensus; none is no decision", async () => {
    const one = await run({ propose: (ask) => (ask.seatId === S1 ? { proposal: "solo" } : { fail: "down" }) });
    expect(one.result.decision).toBe("solo");
    expect(one.result.consensus).toEqual({ score: 1, reached: true });
    const none = await run({ propose: () => ({ fail: "down" }) });
    expect(none.result.decision).toBe("");
    expect(none.result.consensus).toEqual({ score: 0, reached: false });
  });

  it("cancellation between rounds propagates", async () => {
    const controller = new AbortController();
    const promise = run(
      {
        agree: (ask) => {
          controller.abort();
          return split(ask);
        },
      },
      {},
      seats,
      controller.signal,
    );
    await expect(promise).rejects.toBeInstanceOf(NegotiationCancelledError);
  });

  it("is deterministic", async () => {
    const o = { agree: (ask: MockAsk, round: number) => (round < 2 ? split(ask) : { agree: true, preferred: C, confidence: 0.9 }) };
    const first = await run(o);
    const second = await run(o);
    expect(second.result).toEqual(first.result);
    expect(second.events).toEqual(first.events);
    expect(second.asks.map((a) => [a.seatId, a.step, a.vars])).toEqual(first.asks.map((a) => [a.seatId, a.step, a.vars]));
  });

  it("never puts seat ids or names into vars", async () => {
    const { asks } = await run({
        agree: split,
        propose: (ask) => ({ proposal: `idea ${ask.seatId.length}${ask.seatId.slice(-1)}x` }),
        revise: () => ({ proposal: "improved idea" }),
        critique: (ask) => ({ critiques: [{ target: ask.seatId === S1 ? B : A, text: "t", citations: [] }] }),
      },
      { maxRounds: 2 },
    );
    const serialized = JSON.stringify(asks.map((a) => a.vars));
    for (const seat of seats) {
      expect(serialized).not.toContain(seat.id);
      expect(serialized).not.toContain(seat.displayName);
    }
  });
});

describe("debate: validation and registry", () => {
  it("validates options and seats", () => {
    expect(debateStrategy.validate(seats, {})).toBeUndefined();
    expect(debateStrategy.validate(seats, { maxRounds: 0 })).toMatch(/maxRounds/);
    expect(debateStrategy.validate(seats, { maxRounds: 11 })).toMatch(/maxRounds/);
    expect(debateStrategy.validate(seats, { maxRounds: 2.5 })).toMatch(/maxRounds/);
    expect(debateStrategy.validate(seats, { consensus: 1.2 })).toMatch(/consensus/);
    expect(debateStrategy.validate(seats, { moderator: "nobody" })).toMatch(/moderator/);
    expect(debateStrategy.validate(seats, { devilsAdvocate: "nobody" })).toMatch(/devilsAdvocate/);
    expect(debateStrategy.validate(withModerator, { moderator: MOD, devilsAdvocate: MOD })).toMatch(/different seats/);
    expect(debateStrategy.validate(withModerator, { moderator: MOD })).toBeUndefined();
    expect(debateStrategy.validate(seats.slice(0, 1), {})).toMatch(/at least two/);
    expect(debateStrategy.validate(seats.slice(0, 2), { moderator: S2 })).toMatch(/at least two/);
  });

  it("is registered with the builtins, idempotently", () => {
    registerBuiltinStrategies();
    registerBuiltinStrategies();
    expect(getStrategy("debate")).toBe(debateStrategy);
    expect(listStrategies()).toContain("debate");
  });
});
