import type { Seat } from "#assentor/protocol/seats.js";
import {
  agreementScore,
  anonymizeProposals,
  matchLabel,
  NegotiationCancelledError,
  type NegotiationContext,
  type NegotiationResult,
  type NegotiationStrategy,
  type NegotiationStep,
  type SeatReply,
} from "../strategy.js";

/**
 * Debate strategy (T02-05): propose → anonymized critique → revise → consensus
 * check, for up to `maxRounds` rounds.
 *
 * Options (all optional): `maxRounds` (integer 1–10, default 3), `consensus`
 * (0–1, default 0.7), `moderator` (seat id) and `devilsAdvocate` (seat id).
 *
 * Roles come from the seats (`role: "moderator"`, `"devils-advocate"`, `"judge"`)
 * and the options add to them. `validate` rejects more than one moderator seat
 * (role seat plus a different option seat) and a moderator that is also a
 * devil's advocate.
 * - The moderator never proposes, critiques or votes. It only decides when the
 *   seats do not converge. Its reply's `consensus` flag is ignored: the
 *   strategy measures consensus itself, and only `preferred` is used.
 * - A devil's advocate proposes, critiques and revises like anyone else but
 *   is never asked for agreement and its critiques carry no weight, so it never
 *   counts toward consensus. Its proposals and critiques are in the transcript
 *   and in `proposals`.
 * - Without a moderator the judge step runs on the seat with role `judge`, else
 *   the first seat that is neither a devil's advocate nor a failed proposer. A
 *   judge that picks its own proposal is overruled (recorded as dissent) and
 *   the fallback below applies.
 * - A seat whose round-1 proposal fails is out of the debate (recorded as dissent).
 *
 * Per round (seat order everywhere)
 * 1. Round 1: every debating seat proposes. Later rounds: each revises its own
 *    proposal, seeing the critiques its proposal received (no critic identity).
 *    A failed revision keeps the previous text and is recorded as dissent.
 * 2. Every debating seat critiques the *other* proposals (it is never shown its
 *    own). A critique that targets the critic's own label or an unknown label is
 *    dropped and recorded as dissent.
 * 3. Every debating seat except the devil's advocate answers `negotiate-agree`.
 *    `agreementScore` gives `base` and the leading label.
 * 4. Critique weighting: a critique with at least one non-blank citation weighs
 *    1, one without weighs 0.5. Each (critic, target) pair counts once, at its
 *    heaviest weight, and a devil's advocate's critiques do not count. With W
 *    the total weight of this round's counted critiques against the leading
 *    label and V the number of agreeing-capable seats, score = base × (1 − 0.5 × W / (W + V)). Criticism lowers the score
 *    by at most half, and uncited criticism lowers it less than cited.
 * 5. score ≥ `consensus` ends the debate with the leading proposal.
 *
 * No consensus after `maxRounds`: the moderator (or judge) picks among the
 * current proposals (the judge also sees the last round's critiques). If that reply is missing or names an unknown label, the
 * leader of the last agreement check decides (else the first proposal), and the
 * rationale says so. `consensus.reached` is false in that case.
 *
 * Dissent: every failed reply, every dropped critique, and every seat whose
 * final-round `preferred` differs from the decision (or that did not agree).
 *
 * Fewer than two proposals: no debate. One proposal wins with a deliberate
 * vacuous consensus (score 1); none means no decision (score 0).
 */
export const debateStrategy: NegotiationStrategy = {
  id: "debate",
  validate(seats, options) {
    const parsed = readOptions(options);
    if (typeof parsed === "string") return parsed;
    const ids = new Set(seats.map((seat) => seat.id));
    if (parsed.moderator !== undefined && !ids.has(parsed.moderator)) {
      return `moderator "${parsed.moderator}" is not a seat in the team`;
    }
    if (parsed.devilsAdvocate !== undefined && !ids.has(parsed.devilsAdvocate)) {
      return `devilsAdvocate "${parsed.devilsAdvocate}" is not a seat in the team`;
    }
    const roles = resolveRoles(seats, parsed);
    if (typeof roles === "string") return roles;
    return debaters(seats, roles.moderator).length < 2 ? "debate needs at least two debating seats (not counting the moderator)" : undefined;
  },
  async run(ctx) {
    const parsed = readOptions(ctx.options);
    if (typeof parsed === "string") {
      throw new Error(parsed);
    }
    const { maxRounds, consensus: threshold } = parsed;
    const roles = resolveRoles(ctx.seats, parsed);
    if (typeof roles === "string") {
      throw new Error(roles);
    }
    const { moderator, advocates } = roles;
    const seatsInDebate = debaters(ctx.seats, moderator);
    const dissent: NegotiationResult["dissent"] = [];
    const failure = (reply: Extract<SeatReply<NegotiationStep>, { ok: false }>, step: string, round: number) =>
      dissent.push({ seatId: reply.seatId, reason: `${step} failed in round ${round}: ${reply.error}` });

    // Round 1 proposals fix the labels (seat order) for the whole debate.
    cancelIfAborted(ctx);
    const first = await Promise.all(
      seatsInDebate.map((seat) => ctx.askSeat(seat.id, "negotiate-propose", { goal: ctx.goal }, { readOnly: true })),
    );
    const entries: Array<{ seatId: string; label: string; text: string }> = [];
    const seatProposals: Array<{ seatId: string; text: string }> = [];
    for (const reply of first) {
      if (reply.ok) seatProposals.push({ seatId: reply.seatId, text: reply.data.proposal });
      else failure(reply, "negotiate-propose", 1);
    }
    const { anonymized } = anonymizeProposals(seatProposals);
    seatProposals.forEach((p, i) => entries.push({ seatId: p.seatId, label: anonymized[i]!.label, text: p.text }));
    const labels = entries.map((e) => e.label);
    const listed = () => entries.map((e) => ({ label: e.label, seatId: e.seatId, text: e.text }));
    const shown = () => entries.map((e) => ({ label: e.label, text: e.text }));

    if (entries.length < 2) {
      const only = entries[0];
      const result = { score: only ? 1 : 0, reached: Boolean(only) };
      emitProposals(ctx, 1, entries);
      ctx.emit({ type: "negotiation.consensus", data: { round: 1, ...result, threshold, ...(only ? { preferred: only.label } : {}) } });
      const rationale = only ? "only one proposal" : "no proposals";
      ctx.emit({ type: "negotiation.decided", data: { rationale, ...(only ? { winner: only.label } : {}) } });
      return {
        strategy: "debate",
        decision: only?.text ?? "",
        rationale,
        proposals: listed(),
        dissent,
        rounds: 1,
        consensus: result,
      };
    }

    const voters = entries.filter((e) => !advocates.has(e.seatId)).map((e) => e.seatId);
    type Critique = { critic: string; target: string; text: string; citations: string[]; weight: number };
    let previousCritiques: Critique[] = [];
    let lastAgree: Array<{ seatId: string; agree: boolean; preferred: string }> = [];
    let last: { score: number; preferred?: string } = { score: 0 };
    let rounds = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      cancelIfAborted(ctx);
      rounds = round;

      if (round > 1) {
        const revised = await Promise.all(
          entries.map((entry) =>
            ctx.askSeat(
              entry.seatId,
              "negotiate-revise",
              {
                goal: ctx.goal,
                round,
                label: entry.label,
                proposal: entry.text,
                proposals: shown().filter((p) => p.label !== entry.label),
                critiques: previousCritiques
                  .filter((c) => c.target === entry.label)
                  .map((c) => ({ text: c.text, citations: c.citations })),
              },
              { readOnly: true },
            ),
          ),
        );
        revised.forEach((reply, i) => {
          if (reply.ok) entries[i]!.text = reply.data.proposal;
          else failure(reply, "negotiate-revise", round);
        });
      }
      emitProposals(ctx, round, entries);

      cancelIfAborted(ctx);
      const critiqueReplies = await Promise.all(
        entries.map((entry) =>
          ctx.askSeat(
            entry.seatId,
            "negotiate-critique",
            { goal: ctx.goal, round, proposals: shown().filter((p) => p.label !== entry.label) },
            { readOnly: true },
          ),
        ),
      );
      const critiques: Critique[] = [];
      critiqueReplies.forEach((reply, i) => {
        const own = entries[i]!.label;
        if (!reply.ok) {
          failure(reply, "negotiate-critique", round);
          return;
        }
        for (const item of reply.data.critiques) {
          const target = matchLabel(item.target, labels);
          if (target === undefined || target === own) {
            dissent.push({
              seatId: reply.seatId,
              reason: `critique dropped in round ${round}: ${target === own ? "targets the critic's own proposal" : `unknown target "${item.target}"`}`,
            });
            continue;
          }
          const citations = item.citations.filter((c) => c.trim().length > 0);
          critiques.push({
            critic: reply.seatId,
            target,
            text: item.text,
            citations,
            weight: citations.length > 0 ? 1 : 0.5,
          });
          ctx.emit({
            type: "negotiation.critique",
            seatId: reply.seatId,
            data: { round, targetLabel: target, text: item.text, citations },
          });
        }
      });
      previousCritiques = critiques;

      cancelIfAborted(ctx);
      const agreeReplies = await Promise.all(
        voters.map((seatId) =>
          ctx.askSeat(
            seatId,
            "negotiate-agree",
            {
              goal: ctx.goal,
              round,
              proposals: shown(),
              critiques: critiques.map((c) => ({ target: c.target, text: c.text, citations: c.citations })),
            },
            { readOnly: true },
          ),
        ),
      );
      lastAgree = [];
      for (const reply of agreeReplies) {
        if (reply.ok) lastAgree.push({ seatId: reply.seatId, agree: reply.data.agree, preferred: reply.data.preferred });
        else failure(reply, "negotiate-agree", round);
      }
      const base = agreementScore(
        agreeReplies.flatMap((r) => (r.ok ? [r.data] : [])),
        labels,
      );
      // One critic cannot pile up weight: each (critic, target) pair counts once, at its heaviest.
      const pairs = new Map<string, number>();
      for (const c of critiques) {
        if (c.target !== base.preferred || advocates.has(c.critic)) continue;
        pairs.set(c.critic, Math.max(pairs.get(c.critic) ?? 0, c.weight));
      }
      const against = [...pairs.values()].reduce((sum, w) => sum + w, 0);
      const score = base.score * (1 - (0.5 * against) / (against + voters.length));
      last = { score, preferred: base.preferred };
      const reached = base.preferred !== undefined && score >= threshold;
      ctx.emit({
        type: "negotiation.consensus",
        data: { round, score, reached, threshold, ...(base.preferred ? { preferred: base.preferred } : {}) },
      });

      if (reached) {
        return finish(base.preferred!, `${base.preferred} reached consensus in round ${round} (score ${score.toFixed(2)} ≥ ${threshold})`, true);
      }
    }

    // No consensus: moderator, else the judge.
    cancelIfAborted(ctx);
    const view = { goal: ctx.goal, proposals: shown() };
    let winner: string | undefined;
    let by: string;
    if (moderator !== undefined) {
      by = "moderator";
      const reply = await ctx.askSeat(moderator, "moderator", { ...view, rounds, critiques: previousCritiques.map(publicCritique) }, { readOnly: true });
      if (reply.ok) winner = reply.data.preferred === undefined ? undefined : matchLabel(reply.data.preferred, labels);
      else failure(reply, "moderator", rounds);
    } else {
      by = "judge";
      const failedProposers = new Set(first.filter((r) => !r.ok).map((r) => r.seatId));
      const judge = (ctx.seats.find((seat) => seat.role === "judge") ?? ctx.seats.find((seat) => !advocates.has(seat.id) && !failedProposers.has(seat.id)))?.id;
      if (judge === undefined) {
        dissent.push({ seatId: ctx.seats[0]!.id, reason: "no seat is available to judge" });
      } else {
        const reply = await ctx.askSeat(judge, "judge", { ...view, critiques: previousCritiques.map(publicCritique) }, { readOnly: true });
        if (reply.ok) winner = matchLabel(reply.data.winner, labels);
        else failure(reply, "judge", rounds);
        // Self-pick rule (as in vote): a judge may not rule for its own proposal.
        if (winner !== undefined && entries.find((e) => e.label === winner)?.seatId === judge) {
          dissent.push({ seatId: judge, label: winner, reason: `judge chose its own proposal ${winner}; ruling discarded` });
          winner = undefined;
        }
      }
    }
    const noConsensus = `no consensus after ${rounds} round(s) (best score ${last.score.toFixed(2)} < ${threshold})`;
    if (winner !== undefined) {
      return finish(winner, `${noConsensus}; the ${by} chose ${winner}`, false);
    }
    const fallback = last.preferred ?? labels[0]!;
    return finish(fallback, `${noConsensus}; the ${by} gave no usable ruling, so ${fallback} (${last.preferred ? "leader of the last check" : "first proposal"}) stands`, false);

    function finish(label: string, rationale: string, reached: boolean): NegotiationResult {
      ctx.emit({ type: "negotiation.decided", data: { rationale, winner: label } });
      for (const reply of lastAgree) {
        const preferred = matchLabel(reply.preferred, labels);
        if (reply.agree && preferred === label) continue;
        dissent.push({
          seatId: reply.seatId,
          ...(preferred ? { label: preferred } : {}),
          reason: reply.agree
            ? `prefers ${preferred ?? `unknown label "${reply.preferred}"`} over ${label}`
            : `does not agree with ${label}${preferred ? `; prefers ${preferred}` : ""}`,
        });
      }
      return {
        strategy: "debate",
        decision: entries.find((e) => e.label === label)?.text ?? "",
        rationale,
        proposals: listed(),
        dissent,
        rounds,
        consensus: { score: last.score, reached },
      };
    }
  },
};

function publicCritique(c: { target: string; text: string; citations: string[] }) {
  return { target: c.target, text: c.text, citations: c.citations };
}

/** The moderator and the devil's advocates, from seat roles plus the options; an error message if they clash. */
function resolveRoles(seats: readonly Seat[], options: DebateOptions): { moderator?: string; advocates: Set<string> } | string {
  const moderators = new Set(seats.filter((seat) => seat.role === "moderator").map((seat) => seat.id));
  if (options.moderator !== undefined) moderators.add(options.moderator);
  if (moderators.size > 1) return "debate allows only one moderator seat";
  const moderator = [...moderators][0];
  const advocates = new Set(seats.filter((seat) => seat.role === "devils-advocate").map((seat) => seat.id));
  if (options.devilsAdvocate !== undefined) advocates.add(options.devilsAdvocate);
  if (moderator !== undefined && advocates.has(moderator)) return "moderator and devilsAdvocate must be different seats";
  // Without a voter the agreement score is 0/0 and consensus can never be measured.
  if (!seats.some((seat) => seat.id !== moderator && !advocates.has(seat.id))) return "debate needs at least one seat that is neither the moderator nor a devil's advocate";
  return { ...(moderator !== undefined ? { moderator } : {}), advocates };
}

function debaters(seats: readonly Seat[], moderator: string | undefined): Seat[] {
  return seats.filter((seat) => seat.id !== moderator);
}

function cancelIfAborted(ctx: NegotiationContext): void {
  if (ctx.signal.aborted) {
    throw new NegotiationCancelledError();
  }
}

function emitProposals(ctx: NegotiationContext, round: number, proposals: Array<{ seatId: string; label: string; text: string }>): void {
  for (const p of proposals) {
    ctx.emit({ type: "negotiation.proposal", seatId: p.seatId, data: { round, label: p.label, text: p.text } });
  }
}

interface DebateOptions {
  maxRounds: number;
  consensus: number;
  moderator?: string;
  devilsAdvocate?: string;
}

/** Defaults applied; an error message for an invalid option. */
function readOptions(options: Readonly<Record<string, unknown>>): DebateOptions | string {
  const { maxRounds = 3, consensus = 0.7, moderator, devilsAdvocate } = options;
  if (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
    return "maxRounds must be an integer from 1 to 10";
  }
  if (typeof consensus !== "number" || !(consensus >= 0 && consensus <= 1)) {
    return "consensus must be a number from 0 to 1";
  }
  for (const [name, value] of [["moderator", moderator], ["devilsAdvocate", devilsAdvocate]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      return `${name} must be a seat id`;
    }
  }
  return {
    maxRounds,
    consensus,
    ...(moderator !== undefined ? { moderator: moderator as string } : {}),
    ...(devilsAdvocate !== undefined ? { devilsAdvocate: devilsAdvocate as string } : {}),
  };
}
