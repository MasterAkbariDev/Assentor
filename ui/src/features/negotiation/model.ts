import type { EngineEvent } from "@engine/protocol/events.js";

/**
 * Negotiation runs rebuilt from the event stream (T04-09p). Pure, so the view and
 * the tests use the same code. Every field comes from an event. The stream does
 * not carry the decision rationale, the consensus threshold, or invalid ballots,
 * so those are not here; the view says so.
 */

export interface ProposalView {
  round: number;
  label: string;
  text: string;
  /** Only when the event carries the author (current strategies do not send it). */
  seatId?: string;
}

export interface CritiqueView {
  round: number;
  seatId?: string;
  targetLabel: string;
  text: string;
  citations: string[];
}

export interface VoteView {
  round: number;
  seatId: string;
  ranking: string[];
}

export interface ConsensusView {
  round: number;
  score: number;
  reached: boolean;
  preferred?: string;
}

/** A failed seat ask in the negotiation's stage (`seat.error`). */
export interface DissentView {
  seatId?: string;
  message: string;
}

export interface NegotiationRun {
  /** Stable for the life of the run: the first event's stage and seq. */
  key: string;
  stageId?: string;
  strategy?: string;
  attempt?: number;
  /** Distinct rounds, ascending. */
  rounds: number[];
  proposals: ProposalView[];
  critiques: CritiqueView[];
  votes: VoteView[];
  consensus: ConsensusView[];
  dissent: DissentView[];
}

/** Borda points per proposal label for one round's ballots. */
export interface Tally {
  labels: string[];
  points: Record<string, number>;
  /** Points if every ballot ranked the same proposal first: the sum over ballots of (ballot length − 1). */
  maxPoints: number;
}

/** Proposal labels in first-seen order. */
export function labelsOf(proposals: readonly ProposalView[]): string[] {
  return [...new Set(proposals.map((p) => p.label))];
}

/**
 * Borda count as `strategies/vote.ts` runs it. Each ballot is scored by its own
 * length n: position i scores n − 1 − i. The rankings in `negotiation.vote` are the
 * moved rankings, so this matches the engine's tallies. Labels are the proposal
 * labels plus any label a ballot ranks, in first-seen order.
 */
export function bordaTally(votes: readonly VoteView[], proposalLabels: readonly string[]): Tally {
  const labels = [...new Set([...proposalLabels, ...votes.flatMap((vote) => vote.ranking)])];
  const points: Record<string, number> = Object.fromEntries(labels.map((label) => [label, 0]));
  let maxPoints = 0;
  for (const vote of votes) {
    const n = vote.ranking.length;
    maxPoints += Math.max(n - 1, 0);
    vote.ranking.forEach((label, i) => {
      points[label] = (points[label] ?? 0) + (n - 1 - i);
    });
  }
  return { labels, points, maxPoints };
}

/** A stage window: the events between one `stage.started` and the next for the same stage. */
interface Window {
  stageId?: string;
  /** From `stage.started`: "negotiate" for the negotiation stage, "execute" for best-of-n and divide work. */
  kind?: string;
  strategy?: string;
  attempt?: number;
  negotiation: EngineEvent[];
  errors: DissentView[];
}

/**
 * One run per stage window that has negotiation events, in stream order. Events
 * without a stage id share one window. A seat error is dissent only in a
 * `negotiate` stage: best-of-n and divide also emit negotiation events from
 * execute stages, where a failed seat is work, not dissent.
 */
export function buildNegotiationRuns(events: readonly EngineEvent[]): NegotiationRun[] {
  const windows: Window[] = [];
  const current = new Map<string | undefined, Window>();
  const windowFor = (stageId: string | undefined): Window => {
    let window = current.get(stageId);
    if (!window) {
      window = { stageId, negotiation: [], errors: [] };
      windows.push(window);
      current.set(stageId, window);
    }
    return window;
  };

  for (const event of events) {
    switch (event.type) {
      case "stage.started": {
        const window: Window = {
          stageId: event.stageId,
          negotiation: [],
          errors: [],
          ...(event.data.kind ? { kind: event.data.kind } : {}),
          ...(event.data.strategy ? { strategy: event.data.strategy } : {}),
          ...(typeof event.data.attempt === "number" ? { attempt: event.data.attempt } : {}),
        };
        windows.push(window);
        current.set(event.stageId, window);
        break;
      }
      case "seat.error": {
        const window = current.get(event.stageId);
        if (window?.kind === "negotiate") {
          window.errors.push({
            message: event.data.message,
            ...(event.seatId ? { seatId: event.seatId } : {}),
          });
        }
        break;
      }
      case "negotiation.proposal":
      case "negotiation.critique":
      case "negotiation.vote":
      case "negotiation.consensus":
        windowFor(event.stageId).negotiation.push(event);
        break;
      default:
        break;
    }
  }

  return windows.filter((w) => w.negotiation.length > 0).map(toRun);
}

function toRun(window: Window): NegotiationRun {
  const proposals: ProposalView[] = [];
  const critiques: CritiqueView[] = [];
  const votes: VoteView[] = [];
  const consensus: ConsensusView[] = [];
  for (const event of window.negotiation) {
    switch (event.type) {
      case "negotiation.proposal":
        proposals.push({
          round: event.data.round,
          label: event.data.label,
          text: event.data.text,
          ...(event.seatId ? { seatId: event.seatId } : {}),
        });
        break;
      case "negotiation.critique":
        critiques.push({
          round: event.data.round,
          targetLabel: event.data.targetLabel,
          text: event.data.text,
          citations: event.data.citations,
          ...(event.seatId ? { seatId: event.seatId } : {}),
        });
        break;
      case "negotiation.vote":
        if (event.seatId) {
          votes.push({ round: event.data.round, seatId: event.seatId, ranking: event.data.ranking });
        }
        break;
      case "negotiation.consensus":
        consensus.push({
          round: event.data.round,
          score: event.data.score,
          reached: event.data.reached,
          ...(event.data.preferred ? { preferred: event.data.preferred } : {}),
        });
        break;
      default:
        break;
    }
  }
  const rounds = [...new Set([...proposals, ...critiques, ...votes, ...consensus].map((x) => x.round))].sort((a, b) => a - b);
  const first = window.negotiation[0]!;
  return {
    key: `${window.stageId ?? ""}@${first.seq}`,
    ...(window.stageId ? { stageId: window.stageId } : {}),
    ...(window.strategy ? { strategy: window.strategy } : {}),
    ...(window.attempt !== undefined ? { attempt: window.attempt } : {}),
    rounds,
    proposals,
    critiques,
    votes,
    consensus,
    dissent: window.errors,
  };
}
