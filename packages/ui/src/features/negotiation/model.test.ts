import { describe, expect, it } from "vitest";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { negotiationFixture } from "../../test/fixtures.js";
import { bordaTally, buildNegotiationRuns, labelsOf } from "./model.js";

function ev(seq: number, draft: Record<string, unknown>): EngineEvent {
  return { sessionId: "s", seq, at: "2026-10-25T11:00:00.000Z", ...draft } as EngineEvent;
}

describe("buildNegotiationRuns", () => {
  it("splits the fixture into one run per stage, in stream order, with rounds from the events", () => {
    const runs = buildNegotiationRuns(negotiationFixture.events);
    expect(runs.map((r) => [r.stageId, r.strategy, r.attempt])).toEqual([
      ["debate-1", "debate", 1],
      ["vote-1", "vote", 1],
    ]);
    expect(runs[0]!.rounds).toEqual([1, 2]);
    expect(runs[1]!.rounds).toEqual([1, 2]);
  });

  it("reads the fixture's consensus score exactly from the event", () => {
    const [debate, vote] = buildNegotiationRuns(negotiationFixture.events);
    expect(debate!.consensus.at(-1)).toEqual({ round: 2, score: 0.8, reached: true, preferred: "Proposal A" });
    expect(vote!.consensus.at(-1)?.score).toBe(5 / 6);
  });

  it("counts a seat.error as dissent only inside a stage that has negotiation events", () => {
    const runs = buildNegotiationRuns([
      ev(1, { type: "stage.started", stageId: "execute-1", data: { kind: "execute" } }),
      ev(2, { type: "seat.error", stageId: "execute-1", seatId: "executor", data: { message: "tool crashed" } }),
      ev(3, { type: "stage.started", stageId: "debate-1", data: { kind: "negotiate", strategy: "debate", attempt: 1 } }),
      ev(4, { type: "seat.error", stageId: "debate-1", seatId: "seat-c", data: { message: "invalid reply" } }),
      ev(5, { type: "negotiation.proposal", stageId: "debate-1", data: { round: 1, label: "Proposal A", text: "x" } }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dissent).toEqual([{ seatId: "seat-c", message: "invalid reply" }]);
  });

  it("starts a new run when the same stage runs again (a new attempt)", () => {
    const runs = buildNegotiationRuns([
      ev(1, { type: "stage.started", stageId: "d", data: { kind: "negotiate", strategy: "debate", attempt: 1 } }),
      ev(2, { type: "negotiation.consensus", stageId: "d", data: { round: 1, score: 0, reached: false } }),
      ev(3, { type: "stage.started", stageId: "d", data: { kind: "negotiate", strategy: "debate", attempt: 2 } }),
      ev(4, { type: "negotiation.consensus", stageId: "d", data: { round: 1, score: 1, reached: true } }),
    ]);
    expect(runs.map((r) => r.attempt)).toEqual([1, 2]);
    expect(new Set(runs.map((r) => r.key)).size).toBe(2);
  });

  it("keeps an author only when the proposal event carries one", () => {
    const [run] = buildNegotiationRuns([
      ev(1, { type: "negotiation.proposal", stageId: "p", seatId: "seat-a", data: { round: 1, label: "Proposal A", text: "x" } }),
      ev(2, { type: "negotiation.proposal", stageId: "p", data: { round: 1, label: "Proposal B", text: "y" } }),
    ]);
    expect(run!.proposals.map((p) => p.seatId)).toEqual(["seat-a", undefined]);
    expect(labelsOf(run!.proposals)).toEqual(["Proposal A", "Proposal B"]);
  });

  it("does not count seat errors as dissent in an execute stage, even one with negotiation events", () => {
    // best-of-n and divide emit negotiation events from execute stages; a failed seat there is work, not dissent.
    const runs = buildNegotiationRuns([
      ev(1, { type: "stage.started", stageId: "bon-1", data: { kind: "execute", strategy: "best-of-n", attempt: 1 } }),
      ev(2, { type: "negotiation.proposal", stageId: "bon-1", data: { round: 1, label: "Proposal A", text: "x" } }),
      ev(3, { type: "seat.error", stageId: "bon-1", seatId: "seat-b", data: { message: "tool crashed" } }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dissent).toEqual([]);
  });

  it("keeps the stage kind on the run's window, so a review tiebreak window has no dissent either", () => {
    const runs = buildNegotiationRuns([
      ev(1, { type: "stage.started", stageId: "review-1", data: { kind: "review", attempt: 1 } }),
      ev(2, { type: "seat.error", stageId: "review-1", seatId: "reviewer-1", data: { message: "timed out" } }),
      ev(3, { type: "negotiation.consensus", stageId: "review-1", data: { round: 1, score: 0.6, reached: true } }),
    ]);
    expect(runs[0]!.dissent).toEqual([]);
  });
});

describe("threshold and decision", () => {
  it("reads the threshold and the last decided event, and leaves both out for older logs", () => {
    const [run] = buildNegotiationRuns([
      ev(1, { type: "negotiation.consensus", stageId: "d", data: { round: 1, score: 0.4, reached: false, threshold: 0.7 } }),
      ev(2, { type: "negotiation.decided", stageId: "d", data: { rationale: "first", winner: "Proposal A" } }),
      ev(3, { type: "negotiation.decided", stageId: "d", data: { rationale: "second" } }),
    ]);
    expect(run!.consensus[0]!.threshold).toBe(0.7);
    expect(run!.decided).toEqual({ rationale: "second" });
    const [old] = buildNegotiationRuns(negotiationFixture.events);
    expect(old!.decided).toBeUndefined();
    expect(old!.consensus[0]!.threshold).toBeUndefined();
  });
});

describe("bordaTally", () => {
  it("matches the engine's Borda rule on the fixture's ballots", () => {
    const [, vote] = buildNegotiationRuns(negotiationFixture.events);
    const tally = bordaTally(vote!.votes, labelsOf(vote!.proposals));
    expect(tally.points).toEqual({ "Proposal A": 3, "Proposal B": 5, "Proposal C": 1 });
    expect(tally.maxPoints).toBe(6);
  });

  it("scores each ballot by its own length and includes any ranked label", () => {
    const tally = bordaTally(
      [
        { round: 2, seatId: "a", ranking: ["Proposal B", "Proposal A"] },
        { round: 2, seatId: "b", ranking: ["Proposal A", "Proposal C", "Proposal B"] },
      ],
      ["Proposal A", "Proposal B"],
    );
    expect(tally.labels).toEqual(["Proposal A", "Proposal B", "Proposal C"]);
    // a: B 1, A 0. b: A 2, C 1, B 0.
    expect(tally.points).toEqual({ "Proposal A": 2, "Proposal B": 1, "Proposal C": 1 });
    expect(tally.maxPoints).toBe(1 + 2);
  });

  it("gives no points and no maximum when there are no ballots", () => {
    expect(bordaTally([], ["Proposal A", "Proposal B"])).toEqual({
      labels: ["Proposal A", "Proposal B"],
      points: { "Proposal A": 0, "Proposal B": 0 },
      maxPoints: 0,
    });
  });
});
