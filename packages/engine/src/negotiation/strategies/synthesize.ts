import type { Seat } from "#assentor/protocol/seats.js";
import {
  anonymizeProposals,
  matchLabel,
  NegotiationCancelledError,
  type NegotiationResult,
  type NegotiationStrategy,
  type SeatProposal,
} from "../strategy.js";

/** Consensus needs a score strictly above this. */
const CONSENSUS_THRESHOLD = 0.5;

/**
 * Synthesize strategy (T02-07): every seat except one aggregator proposes, then
 * the aggregator writes one merged answer that cites the proposals it used.
 *
 * - Options: `aggregator` is a seat id in the team. Every other seat proposes;
 *   there must be at least one of them.
 * - Sources are matched with `matchLabel`. An unknown label is dissent, not an
 *   error. A proposal cited twice counts once.
 * - Proposals the answer never cites are listed in the rationale as "not used".
 * - consensus.score = cited proposals / total proposals; reached when score > 0.5.
 *   There is no `preferred`: the answer is merged, not picked.
 * - No proposals: round 2 is skipped and the decision is empty.
 */
export const synthesizeStrategy: NegotiationStrategy = {
  id: "synthesize",
  validate(seats: readonly Seat[], options: Readonly<Record<string, unknown>>) {
    const aggregator = options.aggregator;
    if (typeof aggregator !== "string" || !seats.some((seat) => seat.id === aggregator)) {
      return "synthesize requires an aggregator seat in the team";
    }
    if (seats.length < 2) {
      return "synthesize needs at least one proposing seat besides the aggregator";
    }
    return undefined;
  },
  async run(ctx) {
    const problem = synthesizeStrategy.validate(ctx.seats, ctx.options);
    if (problem) {
      throw new Error(problem);
    }
    const aggregator = String(ctx.options.aggregator);
    const proposers = ctx.seats.filter((seat) => seat.id !== aggregator);

    const proposeReplies = await Promise.all(
      proposers.map((seat) => ctx.askSeat(seat.id, "negotiate-propose", { goal: ctx.goal }, { readOnly: true })),
    );
    const dissent: NegotiationResult["dissent"] = [];
    const proposals: SeatProposal[] = [];
    for (const reply of proposeReplies) {
      if (reply.ok) {
        proposals.push({ seatId: reply.seatId, text: reply.data.proposal });
      } else {
        dissent.push({ seatId: reply.seatId, reason: reply.error });
      }
    }
    const { anonymized } = anonymizeProposals(proposals);
    anonymized.forEach((p, i) =>
      ctx.emit({ type: "negotiation.proposal", seatId: proposals[i]!.seatId, data: { round: 1, label: p.label, text: p.text } }),
    );
    const listed = proposals.map((p, i) => ({ label: anonymized[i]!.label, seatId: p.seatId, text: p.text }));

    if (anonymized.length === 0) {
      ctx.emit({ type: "negotiation.consensus", data: { round: 1, score: 0, reached: false, threshold: CONSENSUS_THRESHOLD } });
      const rationale = "no proposals to synthesize";
      ctx.emit({ type: "negotiation.decided", data: { rationale } });
      return {
        strategy: "synthesize",
        decision: "",
        rationale,
        proposals: listed,
        dissent,
        rounds: 1,
        consensus: { score: 0, reached: false },
      };
    }

    if (ctx.signal.aborted) {
      throw new NegotiationCancelledError();
    }
    const reply = await ctx.askSeat(
      aggregator,
      "negotiate-synthesize",
      { goal: ctx.goal, proposals: anonymized },
      { readOnly: true },
    );
    if (!reply.ok) {
      dissent.push({ seatId: aggregator, reason: reply.error });
      ctx.emit({ type: "negotiation.consensus", data: { round: 2, score: 0, reached: false, threshold: CONSENSUS_THRESHOLD } });
      const rationale = "the aggregator gave no answer";
      ctx.emit({ type: "negotiation.decided", data: { rationale } });
      return {
        strategy: "synthesize",
        decision: "",
        rationale,
        proposals: listed,
        dissent,
        rounds: 2,
        consensus: { score: 0, reached: false },
      };
    }

    const labels = anonymized.map((p) => p.label);
    const cited = new Set<string>();
    for (const source of reply.data.sources) {
      const label = matchLabel(source.label, labels);
      if (label === undefined) {
        dissent.push({ seatId: aggregator, reason: `aggregator cited unknown proposal ${source.label}` });
      } else {
        cited.add(label);
      }
    }
    const uncited = labels.filter((label) => !cited.has(label));
    const score = cited.size / labels.length;
    const reached = score > CONSENSUS_THRESHOLD;
    const rationale =
      `synthesized from ${cited.size} of ${labels.length} proposals` +
      (uncited.length > 0 ? `; not used: ${uncited.join(", ")}` : "");
    ctx.emit({ type: "negotiation.consensus", data: { round: 2, score, reached, threshold: CONSENSUS_THRESHOLD } });
    ctx.emit({ type: "negotiation.decided", data: { rationale } });
    return {
      strategy: "synthesize",
      decision: reply.data.answer,
      rationale,
      proposals: listed,
      dissent,
      rounds: 2,
      consensus: { score, reached },
    };
  },
};
