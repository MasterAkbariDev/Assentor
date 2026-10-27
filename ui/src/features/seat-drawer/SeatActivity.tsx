import { useMemo } from "react";
import { useEngine } from "../../store/context.js";
import { activityRows } from "./activity.js";

/** This seat's recent events as one line each, oldest first. */
export function SeatActivity({ seatId }: { seatId: string }) {
  const events = useEngine((s) => s.session?.seatEvents[seatId]);
  const rows = useMemo(() => activityRows(events ?? []), [events]);
  if (rows.length === 0) {
    return <p className="empty">No activity yet.</p>;
  }
  return (
    <ol className="seat-activity" aria-label="Activity">
      {rows.map((row) => (
        <li key={row.key} className="seat-activity-row">
          <time dateTime={row.at} className="seat-activity-time">
            {row.time}
          </time>
          <span className="seat-activity-text">{row.text}</span>
        </li>
      ))}
    </ol>
  );
}
