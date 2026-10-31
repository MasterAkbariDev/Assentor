import { useId, useState } from "react";
import type { LeadLogEntry } from "#assentor/ui-shared/lead.js";

/**
 * Lead log (T04-17): every lead action with its ✓ accepted or ✗ refused mark and
 * reason. A switch narrows the list to refused actions. Text only: the action and
 * reason are model output, so they are shown as plain text.
 */
export function LeadLog({ actions, total }: { actions: LeadLogEntry[]; total: number }) {
  const [refusedOnly, setRefusedOnly] = useState(false);
  const headingId = useId();
  const switchId = useId();
  const shown = refusedOnly ? actions.filter((entry) => !entry.accepted) : actions;
  return (
    <section className="lead-log" aria-labelledby={headingId}>
      <div className="lead-log-head">
        <h3 id={headingId} className="lead-panel-title">
          Lead log
        </h3>
        <label className="lead-switch" htmlFor={switchId}>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            checked={refusedOnly}
            onChange={(event) => setRefusedOnly(event.target.checked)}
          />
          <span>Refused only</span>
        </label>
      </div>
      {total > actions.length ? (
        <p className="lead-stage-empty">
          Showing last {actions.length} of {total} actions.
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="lead-stage-empty">{refusedOnly ? "No refused actions." : "No lead actions yet."}</p>
      ) : (
        <ol className="lead-entries">
          {shown.map((entry, index) => (
            <li key={index} className={entry.accepted ? "lead-entry" : "lead-entry is-refused"}>
              <span className="lead-entry-mark" aria-hidden="true">
                {entry.accepted ? "✓" : "✗"}
              </span>
              <span className="visually-hidden">{entry.accepted ? "Accepted: " : "Refused: "}</span>
              <span className="lead-entry-action">{entry.action}</span>
              {entry.reason ? <span className="lead-entry-reason"> {entry.reason}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
