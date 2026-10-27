import type { Seat } from "../../core/seats.js";
import {
  anonymizeProposals,
  matchLabel,
  NegotiationCancelledError,
  type NegotiationResult,
  type NegotiationStrategy,
  type SeatProposal,
} from "../strategy.js";

/**
 * Vote strategy (T02-04): every seat proposes, every seat ranks every proposal,
 * and a Borda count picks the winner.
 *
 * - A ballot counts only when it ranks each proposal exactly once with known
 *   labels. Any other ballot is ignored and recorded as dissent ("invalid ballot").
 * - Self-vote rule: a seat may not rank its own proposal first. When a valid
 *   ballot does, that proposal moves to last before scoring. `votes` and
 *   `tallies` show the moved ranking.
 * - Borda: with n proposals, the position at index i (0-based) scores n - 1 - i.
 * - Ties go to the earliest label in proposal order, and the rationale says it was a tie-break.
 * - consensus.score = winner points / (valid ballots × (n - 1)); reached when score > 0.5.
 * - Fewer than two proposals: no vote round. One proposal wins with a deliberate
 *   vacuous consensus (score 1); none means no decision (score 0). Each emits
 *   one consensus event at round 1.
 */
export const voteStrategy: NegotiationStrategy = {
  id: "vote",
  validate: (seats: readonly Seat[]) => (seats.length < 2 ? "needs at least two seats" : undefined),
  async run(ctx) {
    const proposeReplies = await Promise.all(
      ctx.seats.map((seat) => ctx.askSeat(seat.id, "negotiate-propose", { goal: ctx.goal }, { readOnly: true })),
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
    const { anonymized, seatByLabel } = anonymizeProposals(proposals);
    anonymized.forEach((p) => ctx.emit({ type: "negotiation.proposal", data: { round: 1, label: p.label, text: p.text } }));
    const listed = proposals.map((p, i) => ({ label: anonymized[i]!.label, seatId: p.seatId, text: p.text }));

    const n = anonymized.length;
    if (n < 2) {
      const only = anonymized[0];
      // One proposal is a deliberate vacuous consensus: there is nothing to vote on.
      const consensus = { score: only ? 1 : 0, reached: Boolean(only) };
      ctx.emit({
        type: "negotiation.consensus",
        data: { round: 1, ...consensus, ...(only ? { preferred: only.label } : {}) },
      });
      return {
        strategy: "vote",
        decision: only?.text ?? "",
        rationale: only ? "only one proposal" : "no proposals",
        proposals: listed,
        dissent,
        rounds: 1,
        consensus,
      };
    }

    if (ctx.signal.aborted) {
      throw new NegotiationCancelledError();
    }
    const labels = anonymized.map((p) => p.label);
    const rankReplies = await Promise.all(
      ctx.seats.map((seat) =>
        ctx.askSeat(seat.id, "negotiate-rank", { goal: ctx.goal, proposals: anonymized }, { readOnly: true }),
      ),
    );

    const points = new Map<string, number>(labels.map((label) => [label, 0]));
    const votes: Array<{ seatId: string; ranking: string[] }> = [];
    for (const reply of rankReplies) {
      if (!reply.ok) {
        dissent.push({ seatId: reply.seatId, reason: reply.error });
        continue;
      }
      const ballot = canonicalBallot(reply.data.ranking, labels);
      if (!ballot) {
        dissent.push({ seatId: reply.seatId, reason: "invalid ballot" });
        continue;
      }
      // Self-vote rule: a seat's own proposal may not win its own ballot.
      const own = labels.find((label) => seatByLabel[label] === reply.seatId);
      const ranking = own !== undefined && ballot[0] === own ? [...ballot.slice(1), own] : ballot;
      ranking.forEach((label, i) => points.set(label, (points.get(label) ?? 0) + (n - 1 - i)));
      votes.push({ seatId: reply.seatId, ranking });
      ctx.emit({ type: "negotiation.vote", seatId: reply.seatId, data: { round: 2, ranking } });
    }

    const tallies = Object.fromEntries(labels.map((label) => [label, points.get(label) ?? 0]));
    const maxPossible = votes.length * (n - 1);
    if (votes.length === 0) {
      ctx.emit({ type: "negotiation.consensus", data: { round: 2, score: 0, reached: false } });
      return {
        strategy: "vote",
        decision: "",
        rationale: "no valid ballots, so no winner",
        proposals: listed,
        votes,
        tallies,
        dissent,
        rounds: 2,
        consensus: { score: 0, reached: false },
      };
    }

    // Ties go to the earliest label in proposal order (`labels` is already in that order).
    const top = Math.max(...labels.map((label) => points.get(label) ?? 0));
    const topLabels = labels.filter((label) => points.get(label) === top);
    const winner = topLabels[0]!;
    const score = top / maxPossible;
    const reached = score > 0.5;
    const winnerText = listed.find((p) => p.label === winner)?.text ?? "";
    const rationale =
      `${winner} won with ${top} of ${maxPossible} points from ${votes.length} valid ballot(s)` +
      (topLabels.length > 1 ? `; tie-break: ${winner} is the earliest of the top labels` : "") +
      (reached ? "" : "; below the 0.5 consensus threshold");
    ctx.emit({ type: "negotiation.consensus", data: { round: 2, score, reached, preferred: winner } });
    return {
      strategy: "vote",
      decision: winnerText,
      rationale,
      proposals: listed,
      votes,
      tallies,
      dissent,
      rounds: 2,
      consensus: { score, reached },
    };
  },
};

/**
 * The ballot as canonical labels, or undefined when it is not a full ranking:
 * every entry must match a known label, and each label must appear exactly once.
 */
function canonicalBallot(raw: readonly string[], labels: readonly string[]): string[] | undefined {
  const ranking: string[] = [];
  for (const entry of raw) {
    const label = matchLabel(entry, labels);
    if (label === undefined || ranking.includes(label)) {
      return undefined;
    }
    ranking.push(label);
  }
  return ranking.length === labels.length ? ranking : undefined;
}
