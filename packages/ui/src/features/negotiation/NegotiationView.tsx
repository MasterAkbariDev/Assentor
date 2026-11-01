import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SeatState } from "#assentor/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { selectNegotiationEvents, selectSeats } from "../../store/selectors.js";
import {
  bordaTally,
  buildNegotiationRuns,
  labelsOf,
  type ConsensusView,
  type CritiqueView,
  type NegotiationRun,
  type ProposalView,
  type Tally,
  type VoteView,
} from "./model.js";

/**
 * Read-only negotiation view for the selected run (T04-09p): one tab per round,
 * proposals side by side with their critiques, the vote tally (vote strategy),
 * the consensus meter, and the decision card with dissent. Shown only when the
 * run has `negotiation.*` events. Text from seats is rendered as text, never HTML.
 */
export function NegotiationView() {
  const events = useEngine(selectNegotiationEvents);
  const seats = useEngine(selectSeats);
  const runs = useMemo(() => buildNegotiationRuns(events), [events]);
  const [runKey, setRunKey] = useState<string>();
  const [round, setRound] = useState<number>();
  const [reveal, setReveal] = useState(false);
  const base = useId();

  if (runs.length === 0) {
    return null;
  }
  const run = runs.find((r) => r.key === runKey) ?? runs[runs.length - 1]!;
  const selectedRound = round !== undefined && run.rounds.includes(round) ? round : run.rounds[run.rounds.length - 1];
  const name = (seatId: string | undefined) => seatName(seats, seatId);

  return (
    <section className="negotiation" aria-labelledby={`${base}-heading`}>
      <header className="negotiation-head">
        <h2 id={`${base}-heading`} className="negotiation-title">
          Negotiation
          {run.strategy ? <span className="negotiation-strategy"> · {run.strategy}</span> : null}
        </h2>
        {runs.length > 1 ? (
          <label className="negotiation-run">
            Run{" "}
            <select value={run.key} onChange={(e) => setRunKey(e.target.value)}>
              {runs.map((r, i) => (
                <option key={r.key} value={r.key}>
                  {`${i + 1}. ${r.strategy ?? "negotiation"}${r.stageId ? ` (${r.stageId})` : ""}${r.attempt !== undefined ? ` · attempt ${r.attempt}` : ""}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          role="switch"
          aria-checked={reveal}
          className="switch"
          onClick={() => setReveal(!reveal)}
        >
          <span className="switch-track" aria-hidden="true" />
          Reveal authors
        </button>
      </header>

      {selectedRound === undefined ? (
        <p className="empty">No rounds yet.</p>
      ) : (
        <>
          <RoundTabs base={base} rounds={run.rounds} selected={selectedRound} onSelect={setRound} />
          <RoundPanel base={base} run={run} round={selectedRound} reveal={reveal} name={name} />
        </>
      )}

      <DecisionCard run={run} name={name} />
    </section>
  );
}

function seatName(seats: Record<string, SeatState> | undefined, seatId: string | undefined): string {
  if (!seatId) return "Unknown seat";
  return seats?.[seatId]?.displayName ?? seatId;
}

interface RoundTabsProps {
  base: string;
  rounds: number[];
  selected: number;
  onSelect: (round: number) => void;
}

/** Round tabs: arrows, Home and End move between them, as in the seat drawer. */
function RoundTabs({ base, rounds, selected, onSelect }: RoundTabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = rounds.length;
    const index = rounds.indexOf(selected);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % count;
        break;
      case "ArrowLeft":
        next = (index - 1 + count) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    const target = rounds[next];
    if (target === undefined) return;
    event.preventDefault();
    onSelect(target);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label="Rounds" className="round-tabs" onKeyDown={onKeyDown}>
      {rounds.map((r, i) => {
        const isSelected = r === selected;
        return (
          <button
            key={r}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${base}-tab-${r}`}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={`${base}-panel`}
            tabIndex={isSelected ? 0 : -1}
            className="round-tab"
            onClick={() => onSelect(r)}
          >
            Round {r}
          </button>
        );
      })}
    </div>
  );
}

interface RoundPanelProps {
  base: string;
  run: NegotiationRun;
  round: number;
  reveal: boolean;
  name: (seatId: string | undefined) => string;
}

function RoundPanel({ base, run, round, reveal, name }: RoundPanelProps) {
  const proposals = run.proposals.filter((p) => p.round === round);
  const votes = run.votes.filter((v) => v.round === round);
  const consensus = lastConsensus(run.consensus.filter((c) => c.round === round));
  const labels = labelsOf(run.proposals);
  const tally = votes.length > 0 ? bordaTally(votes, labels) : undefined;

  return (
    <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${round}`} className="round-panel">
      {proposals.length > 0 ? (
        <ol className="proposal-row" aria-label={`Proposals, round ${round}`} tabIndex={0}>
          {proposals.map((proposal) => (
            <li key={`${proposal.label}-${proposal.round}`} className="proposal-item">
              <ProposalCard proposal={proposal} critiques={run.critiques.filter((c) => c.round === round && c.targetLabel === proposal.label)} reveal={reveal} name={name} />
            </li>
          ))}
        </ol>
      ) : null}

      {tally ? <VoteTally votes={votes} tally={tally} name={name} /> : null}

      {consensus ? <ConsensusMeter consensus={consensus} debate={run.strategy === "debate"} /> : null}

      {proposals.length === 0 && !tally && !consensus ? <p className="empty">No events in this round.</p> : null}
    </div>
  );
}

function lastConsensus(list: readonly ConsensusView[]): ConsensusView | undefined {
  return list[list.length - 1];
}

interface ProposalCardProps {
  proposal: ProposalView;
  critiques: CritiqueView[];
  reveal: boolean;
  name: (seatId: string | undefined) => string;
}

function ProposalCard({ proposal, critiques, reveal, name }: ProposalCardProps) {
  return (
    <section className="proposal-card" aria-label={proposal.label}>
      <h3 className="proposal-label">{proposal.label}</h3>
      {reveal ? (
        <p className="proposal-author">
          {proposal.seatId ? `Author: ${name(proposal.seatId)}` : "Author not recorded"}
        </p>
      ) : null}
      <p className="proposal-text">{proposal.text}</p>
      {critiques.length > 0 ? (
        <ol className="critique-thread" aria-label={`Critiques of ${proposal.label}`}>
          {critiques.map((critique, i) => (
            <li key={i} className="critique">
              <p className="critique-meta">
                <strong>{name(critique.seatId)}</strong> critiques
              </p>
              <p className="critique-text">{critique.text}</p>
              {critique.citations.length > 0 ? (
                <ul className="chips" aria-label="Evidence">
                  {critique.citations.map((citation, j) => (
                    <li key={j} className="chip">
                      {citation}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

interface VoteTallyProps {
  votes: VoteView[];
  tally: Tally;
  name: (seatId: string | undefined) => string;
}

/** Per-seat rankings (1 = first) and the Borda totals. Ties go to the earlier proposal. */
function VoteTally({ votes, tally, name }: VoteTallyProps) {
  return (
    <section className="vote-tally" aria-label="Vote tally">
      <table className="vote-table">
        <caption>
          Rankings and Borda points ({tally.maxPoints} possible across {votes.length} ballot
          {votes.length === 1 ? "" : "s"}). Ties go to the earlier proposal.
        </caption>
        <thead>
          <tr>
            <th scope="col">Seat</th>
            {tally.labels.map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {votes.map((vote) => (
            <tr key={vote.seatId}>
              <th scope="row">{name(vote.seatId)}</th>
              {tally.labels.map((label) => (
                <td key={label}>{rankCell(vote.ranking, label)}</td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Borda points</th>
            {tally.labels.map((label) => (
              <td key={label}>{tally.points[label] ?? 0}</td>
            ))}
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/** 1-based position of `label` in a ballot; "–" when the ballot does not rank it. */
function rankCell(ranking: readonly string[], label: string): string {
  const position = ranking.indexOf(label);
  return position < 0 ? "–" : String(position + 1);
}

/** Debate reaches consensus at score ≥ threshold; vote and synthesize need score > threshold. The marker shows the threshold when the log has one. */
function ConsensusMeter({ consensus, debate }: { consensus: ConsensusView; debate: boolean }) {
  const percent = Math.round(consensus.score * 100);
  const threshold = consensus.threshold === undefined ? undefined : Math.round(consensus.threshold * 100);
  return (
    <section className="consensus" aria-label="Consensus">
      <p className="consensus-line">
        <span className="consensus-bar">
          <meter min={0} max={1} value={consensus.score} aria-label="Consensus score" aria-valuetext={`${percent}%`} />
          {threshold !== undefined ? (
            <span className="consensus-marker" style={{ left: `${threshold}%` }} role="img" aria-label={`Threshold ${threshold}%`} />
          ) : null}
        </span>
        <span className="consensus-value">{percent}%</span>
        <span className={consensus.reached ? "consensus-state is-reached" : "consensus-state"}>
          {consensus.reached ? "Consensus reached" : "No consensus"}
        </span>
        {threshold !== undefined ? (
          <span className="consensus-threshold">
            {" "}
            · threshold {debate ? "≥" : ">"} {threshold}%
          </span>
        ) : null}
      </p>
    </section>
  );
}

interface DecisionCardProps {
  run: NegotiationRun;
  name: (seatId: string | undefined) => string;
}

function DecisionCard({ run, name }: DecisionCardProps) {
  const last = run.consensus[run.consensus.length - 1];
  const { decided } = run;
  const preferred = decided ? decided.winner : last?.preferred;
  const preferredProposal = preferred ? [...run.proposals].reverse().find((p) => p.label === preferred) : undefined;
  const status = !last ? "In progress" : last.reached ? "Consensus reached" : "No consensus";
  // Without consensus, logs from before `negotiation.decided` lack the final decision (a judge, a moderator).
  const title = !decided && last && !last.reached ? "Leading proposal (final decision not in the event stream)" : "Decision";
  const gaps = [
    ...(decided ? [] : ["the rationale"]),
    ...(last?.threshold === undefined ? ["the consensus threshold"] : []),
    "dissent from invalid ballots",
  ];
  const gapsText = gaps.length > 1 ? `${gaps.slice(0, -1).join(", ")}, and ${gaps.at(-1)}` : gaps[0];

  return (
    <section className="decision-card" aria-label={title}>
      <h3 className="decision-title">{title}</h3>
      <p className="decision-status">
        {status}
        {preferred ? ` · preferred ${preferred}` : ""}
      </p>
      {decided ? (
        <p className="decision-winner">
          Winner: {decided.winner ?? "none"}
        </p>
      ) : null}
      {decided ? <p className="decision-rationale">{decided.rationale}</p> : null}
      {preferredProposal ? (
        <blockquote className="decision-text">
          <p>{preferredProposal.text}</p>
        </blockquote>
      ) : null}
      <h3 className="decision-dissent-title">Dissent</h3>
      {run.dissent.length > 0 ? (
        <ul className="dissent-list">
          {run.dissent.map((d, i) => (
            <li key={i} className="dissent">
              <span className="dissent-flag" aria-hidden="true">
                ⚑
              </span>{" "}
              <strong>{name(d.seatId)}</strong>: {d.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No failed seat asks in the event stream.</p>
      )}
      <p className="negotiation-gaps">
        Not in the event stream: {gapsText}. Those are in the session&apos;s negotiation file.
      </p>
    </section>
  );
}
