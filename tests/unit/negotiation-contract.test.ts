import { describe, expect, it } from "vitest";
import {
  NegotiationCancelledError,
  NegotiationResultSchema,
  anonymizeProposals,
  expandSeatSpecs,
  getStrategy,
  listStrategies,
  proposalLabel,
  registerStrategy,
  type NegotiationStrategy,
} from "../../src/index.js";
import { createMockNegotiationContext } from "../../src/negotiation/testing/mock-context.js";

const seats = expandSeatSpecs([
  { provider: "claude-code", model: "opus", count: 2 },
  { provider: "codex", model: "sol" },
]);

describe("proposal labels", () => {
  it("counts A…Z, then AA, AB, …", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(proposalLabel)).toEqual([
      "Proposal A",
      "Proposal B",
      "Proposal Z",
      "Proposal AA",
      "Proposal AB",
      "Proposal AZ",
      "Proposal BA",
      "Proposal ZZ",
      "Proposal AAA",
    ]);
    expect(() => proposalLabel(-1)).toThrow(RangeError);
    expect(() => proposalLabel(1.5)).toThrow(RangeError);
  });

  it("anonymizes in the order given and keeps authors engine-side", () => {
    const { anonymized, seatByLabel } = anonymizeProposals([
      { seatId: "opus-1", text: "use a queue" },
      { seatId: "sol-1", text: "use a lock" },
    ]);
    expect(anonymized).toEqual([
      { label: "Proposal A", text: "use a queue" },
      { label: "Proposal B", text: "use a lock" },
    ]);
    expect(JSON.stringify(anonymized)).not.toMatch(/opus|sol-1/);
    expect(seatByLabel).toEqual({ "Proposal A": "opus-1", "Proposal B": "sol-1" });
  });
});

describe("mock negotiation context", () => {
  it("validates replies against the step schema", async () => {
    const { ctx, asks } = createMockNegotiationContext({
      seats,
      script: (ask) =>
        ask.seatId === "opus-1"
          ? { proposal: "plan A" }
          : ask.seatId === "opus-2"
            ? { wrong: true }
            : { fail: "rate limited" },
    });
    const replies = await Promise.all(
      seats.map((seat) => ctx.askSeat(seat.id, "negotiate-propose", { goal: ctx.goal }, { readOnly: true })),
    );
    expect(replies[0]).toEqual({ ok: true, seatId: "opus-1", data: { proposal: "plan A" } });
    expect(replies[1]).toMatchObject({ ok: false, seatId: "opus-2" });
    expect(replies[1]!.ok ? "" : replies[1]!.error).toContain("invalid negotiate-propose reply");
    expect(replies[2]).toEqual({ ok: false, seatId: "sol-1", error: "rate limited" });
    expect(asks.map((a) => [a.seatId, a.step, a.call])).toEqual([
      ["opus-1", "negotiate-propose", 1],
      ["opus-2", "negotiate-propose", 1],
      ["sol-1", "negotiate-propose", 1],
    ]);
  });

  it("turns a crashing seat into ok:false and counts calls per seat and step", async () => {
    const { ctx, asks } = createMockNegotiationContext({
      seats,
      script: (ask) => {
        if (ask.call === 1) throw new Error("crashed");
        return { ranking: ["Proposal A"] };
      },
    });
    const first = await ctx.askSeat("opus-1", "negotiate-rank", {}, { readOnly: true });
    const second = await ctx.askSeat("opus-1", "negotiate-rank", {}, { readOnly: true });
    expect(first).toEqual({ ok: false, seatId: "opus-1", error: "crashed" });
    expect(second).toEqual({ ok: true, seatId: "opus-1", data: { ranking: ["Proposal A"] } });
    expect(asks.map((a) => a.call)).toEqual([1, 2]);
  });

  it("rejects with NegotiationCancelledError after abort, and on unknown seats", async () => {
    const controller = new AbortController();
    const { ctx } = createMockNegotiationContext({ seats, script: () => ({ proposal: "x" }), signal: controller.signal });
    controller.abort();
    await expect(ctx.askSeat("opus-1", "negotiate-propose", {}, { readOnly: true })).rejects.toBeInstanceOf(
      NegotiationCancelledError,
    );
    const live = createMockNegotiationContext({ seats, script: () => ({ proposal: "x" }) });
    await expect(live.ctx.askSeat("nobody", "negotiate-propose", {}, { readOnly: true })).rejects.toThrow(
      "unknown seat",
    );
  });
});

describe("README example strategy", () => {
  // Same code as src/negotiation/README.md "Writing a strategy".
  const firstProposal: NegotiationStrategy = {
    id: "first-proposal-test",
    validate: (s) => (s.length === 0 ? "needs at least one seat" : undefined),
    async run(ctx) {
      const replies = await Promise.all(
        ctx.seats.map((seat) => ctx.askSeat(seat.id, "negotiate-propose", { goal: ctx.goal }, { readOnly: true })),
      );
      const proposals = replies.flatMap((r) => (r.ok ? [{ seatId: r.seatId, text: r.data.proposal }] : []));
      const { anonymized } = anonymizeProposals(proposals);
      anonymized.forEach((p) =>
        ctx.emit({ type: "negotiation.proposal", data: { round: 1, label: p.label, text: p.text } }),
      );
      const first = anonymized[0];
      return {
        strategy: "first-proposal-test",
        decision: first?.text ?? "",
        rationale: first ? `took ${first.label}` : "no proposals",
        proposals: proposals.map((p, i) => ({ label: anonymized[i]!.label, seatId: p.seatId, text: p.text })),
        dissent: replies.flatMap((r) => (r.ok ? [] : [{ seatId: r.seatId, reason: r.error }])),
        rounds: 1,
        consensus: { score: first ? 1 / anonymized.length : 0, reached: Boolean(first) },
      };
    },
  };

  it("runs against the mock and produces a valid, deterministic result", async () => {
    const script = (ask: { seatId: string }) =>
      ask.seatId === "sol-1" ? { fail: "timeout" } : { proposal: `plan from ${ask.seatId}` };
    const a = createMockNegotiationContext({ seats, script });
    const b = createMockNegotiationContext({ seats, script });
    const result = await firstProposal.run(a.ctx);

    expect(NegotiationResultSchema.parse(result)).toEqual(result);
    expect(await firstProposal.run(b.ctx)).toEqual(result);
    expect(result.decision).toBe("plan from opus-1");
    expect(result.dissent).toEqual([{ seatId: "sol-1", reason: "timeout" }]);
    expect(a.events.map((e) => e.data)).toEqual([
      { round: 1, label: "Proposal A", text: "plan from opus-1" },
      { round: 1, label: "Proposal B", text: "plan from opus-2" },
    ]);
    expect(firstProposal.validate([], {})).toBe("needs at least one seat");
  });

  it("registers once", () => {
    registerStrategy(firstProposal);
    expect(getStrategy("first-proposal-test")).toBe(firstProposal);
    expect(listStrategies()).toContain("first-proposal-test");
    expect(() => registerStrategy(firstProposal)).toThrow("already registered");
  });
});

describe("consensus helpers", () => {
  it("matches labels loosely and canonically", async () => {
    const { matchLabel } = await import("../../src/index.js");
    const labels = ["Proposal A", "Proposal B"];
    expect(["Proposal B", "proposal b", "B", " b "].map((raw) => matchLabel(raw, labels))).toEqual([
      "Proposal B",
      "Proposal B",
      "Proposal B",
      "Proposal B",
    ]);
    expect(matchLabel("Proposal C", labels)).toBeUndefined();
    expect(matchLabel("opus-1", labels)).toBeUndefined();
  });

  it("scores agreement by confidence toward the top label", async () => {
    const { agreementScore } = await import("../../src/index.js");
    const labels = ["Proposal A", "Proposal B"];
    expect(
      agreementScore(
        [
          { agree: true, preferred: "B", confidence: 0.9 },
          { agree: true, preferred: "Proposal B", confidence: 0.6 },
          { agree: false, preferred: "A", confidence: 0.5 },
        ],
        labels,
      ),
    ).toEqual({ score: 1.5 / 2, preferred: "Proposal B" });
    expect(agreementScore([], labels)).toEqual({ score: 0 });
    expect(agreementScore([{ agree: true, preferred: "Z", confidence: 1 }], labels)).toEqual({ score: 0 });
    // A tie goes to the earliest label.
    expect(
      agreementScore(
        [
          { agree: true, preferred: "B", confidence: 0.5 },
          { agree: true, preferred: "A", confidence: 0.5 },
        ],
        labels,
      ),
    ).toEqual({ score: 0.5, preferred: "Proposal A" });
  });

  it("cancellation carries a reason", () => {
    expect(new NegotiationCancelledError().reason).toBe("cancelled");
    expect(new NegotiationCancelledError("budget").message).toContain("budget");
  });
});
