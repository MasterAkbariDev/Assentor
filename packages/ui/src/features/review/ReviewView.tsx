import { useEffect, useId, useMemo, useState } from "react";
import { Severity } from "#assentor/protocol/review-result.js";
import { STATUS_META, type StatusTone } from "#assentor/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { groupSeats, selectMemberVerdicts, selectReviewFindings, selectReviewVerdict, selectSeats } from "../../store/selectors.js";
import {
  agreementText,
  decisionOf,
  filterFindings,
  findingsOf,
  groupByFile,
  hasAgreement,
  isSingleReviewer,
  type FindingView,
  type ReviewDecision,
  type SeverityFilter,
} from "./reviewModel.js";

/**
 * Read-only review view for the selected run (T04-10p): the final decision,
 * the reviewer seats, and the findings grouped by file. Everything comes from
 * the event stream. Finding and model text is rendered as text, never HTML.
 */

const SEVERITIES: readonly Severity[] = Object.values(Severity);
const NOTE_NO_AGREEMENT = "Agreement is not in the event stream, so the disagreements filter is unavailable.";

const DECISION_LABEL: Record<string, string> = {
  PASS: "Pass",
  NEEDS_WORK: "Needs work",
  BLOCKED: "Blocked",
  FAILED: "Failed",
};

const DECISION_TONE: Record<string, StatusTone> = {
  PASS: "ok",
  NEEDS_WORK: "warn",
  BLOCKED: "error",
  FAILED: "error",
};

const SEVERITY_TONE: Record<Severity, StatusTone> = {
  blocker: "error",
  major: "error",
  minor: "warn",
  info: "muted",
};

/** Unknown severities are shown as given, with the neutral tone. */
function toneOf(severity: string): StatusTone {
  return (SEVERITY_TONE as Record<string, StatusTone | undefined>)[severity] ?? "muted";
}

export function ReviewView() {
  const verdict = useEngine(selectReviewVerdict);
  const findingEvents = useEngine(selectReviewFindings);
  const seats = useEngine(selectSeats);
  const memberVerdicts = useEngine(selectMemberVerdicts);
  const reviewers = useMemo(
    () => groupSeats(seats ?? {}).find((group) => group.key === "reviewers")?.seats ?? [],
    [seats],
  );
  const decision = decisionOf(verdict);
  const { source, findings, unreadable } = useMemo(() => findingsOf(findingEvents, verdict), [findingEvents, verdict]);
  const agreementKnown = hasAgreement(findings);
  const singleReviewer = isSingleReviewer(reviewers.map((seat) => seat.seatId));

  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [onlyDisagreements, setOnlyDisagreements] = useState(false);
  const [reviewer, setReviewer] = useState("");
  const uid = useId();
  const noteId = `${uid}-agreement-note`;
  // Agreement data gone (a new run, or no finding has a count): the switch cannot apply, so clear it.
  useEffect(() => {
    if (!agreementKnown && onlyDisagreements) {
      setOnlyDisagreements(false);
    }
  }, [agreementKnown, onlyDisagreements]);
  // Finding events name reviewers by seat id. Two seats with the same name keep their ids apart.
  const reviewerName = (id: string) => {
    const name = seats?.[id]?.displayName;
    const clash = name !== undefined && reviewers.some((seat) => seat.seatId !== id && seat.displayName === name);
    return name === undefined ? id : clash ? `${name} (${id})` : name;
  };
  // Reviewers a finding names; the filter is offered only when some finding does.
  const flaggers = [...new Set(findings.flatMap((f) => f.agentIds))];
  const visible = filterFindings(findings, {
    severity,
    onlyDisagreements: onlyDisagreements && agreementKnown,
    ...(reviewer && flaggers.includes(reviewer) ? { reviewer } : {}),
  });

  return (
    <section className="review" aria-labelledby={`${uid}-heading`}>
      <h2 className="review-heading" id={`${uid}-heading`}>
        Review
      </h2>

      {/* role=status so the decision is announced when it arrives or changes. */}
      <div className="review-decision" role="status">
        {decision ? <DecisionBanner decision={decision} singleReviewer={singleReviewer} /> : <p className="review-pending">No decision yet.</p>}
      </div>

      <h3 className="review-subheading">Reviewers</h3>
      {reviewers.length === 0 ? (
        <p className="empty">No reviewer seats yet.</p>
      ) : (
        <ul className="review-reviewers">
          {reviewers.map((seat) => {
            const meta = STATUS_META[seat.status];
            const own = memberVerdicts[seat.seatId];
            return (
              <li key={seat.seatId} className={`review-reviewer tone-${meta.tone}`} data-seat-id={seat.seatId}>
                <span className="review-reviewer-status">
                  <span className="review-reviewer-icon" aria-hidden="true">
                    {meta.icon}
                  </span>{" "}
                  {meta.label}
                </span>
                <span className="review-reviewer-name">{seat.displayName}</span>
                <span className="review-reviewer-meta">
                  {seat.model} · {seat.role || "—"}
                </span>
                {own ? (
                  <span className="review-reviewer-verdict">
                    Verdict {DECISION_LABEL[own.data.status] ?? own.data.status}
                    {own.data.confidence !== undefined ? ` · confidence ${own.data.confidence}` : ""}
                  </span>
                ) : null}
                {seat.detail ? <span className="review-reviewer-detail">{seat.detail}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="review-note">
        Each row shows the seat's run status{Object.keys(memberVerdicts).length > 0 ? " and its own verdict" : ". Single-reviewer runs and older logs show only the decision"}.
      </p>

      <h3 className="review-subheading">Findings</h3>
      <div className="review-filters">
        <label htmlFor={`${uid}-severity`}>Severity</label>
        <select
          id={`${uid}-severity`}
          value={severity}
          onChange={(event) => setSeverity(event.target.value as SeverityFilter)}
        >
          <option value="all">All</option>
          {SEVERITIES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
          <option value="other">other</option>
        </select>
        {flaggers.length > 0 ? (
          <>
            <label htmlFor={`${uid}-reviewer`}>Reviewer</label>
            <select id={`${uid}-reviewer`} value={reviewer} onChange={(event) => setReviewer(event.target.value)}>
              <option value="">All</option>
              {flaggers.map((id) => (
                <option key={id} value={id}>
                  {reviewerName(id)}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <button
          type="button"
          role="switch"
          aria-checked={onlyDisagreements && agreementKnown}
          aria-disabled={agreementKnown ? undefined : "true"}
          aria-describedby={agreementKnown ? undefined : noteId}
          className="review-switch"
          onClick={() => {
            if (agreementKnown) {
              setOnlyDisagreements((on) => !on);
            }
          }}
        >
          <span className="review-switch-track" aria-hidden="true" />
          Only disagreements
        </button>
      </div>

      {!agreementKnown ? (
        <p className="review-note" id={noteId}>
          {NOTE_NO_AGREEMENT}
          {source === "issues" && findings.length > 0 ? " These findings come from the decision's issue list." : null}
        </p>
      ) : null}
      {unreadable > 0 ? (
        <p className="review-note">
          {unreadable} {unreadable === 1 ? "issue" : "issues"} could not be read.
        </p>
      ) : null}

      {findings.length === 0 ? (
        <p className="empty">No findings in this run.</p>
      ) : visible.length === 0 ? (
        <p className="empty">No findings match these filters.</p>
      ) : (
        groupByFile(visible).map((group) => (
          <section key={group.file} className="review-file">
            <h4 className="review-file-name">
              {group.file ? <a href={`#/sessions?diff=${encodeURIComponent(group.file)}`}>{group.file}</a> : "No file named"}
            </h4>
            <ul className="review-findings">
              {group.findings.map((finding, index) => (
                <FindingItem key={`${finding.key}:${index}`} finding={finding} reviewerName={reviewerName} />
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}

function DecisionBanner({ decision, singleReviewer }: { decision: ReviewDecision; singleReviewer: boolean }) {
  const tone = DECISION_TONE[decision.status] ?? "muted";
  return (
    <div className={`review-verdict tone-${tone}`}>
      <p className="review-verdict-status">
        Decision: {DECISION_LABEL[decision.status] ?? decision.status}
        {decision.confidence !== undefined ? (
          <span className="review-verdict-confidence"> · confidence {decision.confidence}</span>
        ) : null}
      </p>
      <p className="review-policy">
        Policy:{" "}
        {decision.policy ?? (singleReviewer ? "not applicable (single reviewer)" : "not recorded in the event stream")}
      </p>
      {decision.summary ? <p className="review-summary">{decision.summary}</p> : null}
    </div>
  );
}

function FindingItem({ finding, reviewerName }: { finding: FindingView; reviewerName: (id: string) => string }) {
  const others = finding.affectedFiles.slice(1);
  return (
    <li className={`review-finding tone-${toneOf(finding.severity)}`}>
      <div className="review-finding-head">
        <span className="review-severity">{finding.severity}</span>
        {finding.category !== "other" ? <span className="review-category">{finding.category}</span> : null}
        <span className="review-agreement" title="Reviewers who flagged this finding">
          {agreementText(finding)}
        </span>
      </div>
      <p className="review-finding-text">{finding.description}</p>
      {others.length > 0 ? <p className="review-finding-files">Also in: {others.join(", ")}</p> : null}
      {finding.agentIds.length > 0 ? <p className="review-finding-reviewers">Flagged by: {finding.agentIds.map(reviewerName).join(", ")}</p> : null}
      {finding.evidence.length > 0 ? (
        <ul className="review-evidence">
          {finding.evidence.map((item, index) => (
            <li key={index}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {finding.requiredChange ? (
        <p className="review-required">
          <span className="review-required-label">Required change:</span> {finding.requiredChange}
        </p>
      ) : null}
    </li>
  );
}
