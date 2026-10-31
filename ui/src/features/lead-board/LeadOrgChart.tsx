import { useId } from "react";
import { STATUS_META, type SeatState } from "@engine/ui-shared/status.js";

/**
 * Org chart (T04-17): the lead at the top, one node per seat under it, each with
 * its live status icon and label. A nested list, so screen readers get the tree.
 */
export function LeadOrgChart({ seats }: { seats: Record<string, SeatState> }) {
  const headingId = useId();
  const list = Object.values(seats);
  return (
    <section className="lead-org" aria-labelledby={headingId}>
      <h3 id={headingId} className="lead-panel-title">
        Org chart
      </h3>
      <ul className="org-tree">
        <li className="org-node">
          <span className="org-label">Lead</span>
          {list.length === 0 ? (
            <p className="lead-stage-empty">No seats yet</p>
          ) : (
            <ul className="org-children" aria-label="Seats">
              {list.map((seat) => {
                const meta = STATUS_META[seat.status];
                return (
                  <li key={seat.seatId} className={`org-node tone-${meta.tone}`}>
                    <span className="org-label">
                      <span className="org-status" aria-hidden="true">
                        {meta.icon}
                      </span>{" "}
                      <span className="org-status-label">{meta.label}</span>{" "}
                      <span className="org-name">{seat.displayName}</span>{" "}
                      <span className="org-meta">
                        {seat.model} · {seat.role}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      </ul>
    </section>
  );
}
