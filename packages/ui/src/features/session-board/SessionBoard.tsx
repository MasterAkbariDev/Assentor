import { useMemo } from "react";
import { useEngine } from "../../store/context.js";
import { groupSeats, isLiveSeat, selectLeadBoard, selectSeats } from "../../store/selectors.js";
import { ApprovalsPanel } from "../controls/ApprovalsPanel.js";
import { SeatCard } from "./SeatCard.js";
import { useNow } from "./useNow.js";

/** Refresh period of the board's one elapsed-time ticker. */
const TICK_MS = 1000;

/**
 * Board of the selected run's seats: grouped (executor, reviewers, other), one
 * card per seat, a responsive grid. Each card opens the seat drawer. Owns the
 * only elapsed-time ticker, and it runs only while at least one seat is still live.
 */
export function SessionBoard() {
  const seats = useEngine(selectSeats);
  const openSeat = useEngine((s) => s.openSeat);
  const groups = useMemo(() => groupSeats(seats ?? {}), [seats]);
  const isLead = useEngine((s) => selectLeadBoard(s) !== undefined);
  const live = Object.values(seats ?? {}).some(isLiveSeat);
  const now = useNow(TICK_MS, live);

  return (
    <div className="seat-board">
      <ApprovalsPanel scope={isLead ? "other" : "all"} />
      {groups.map((group) => (
        <section key={group.key} className="seat-group" aria-label={group.title}>
          <h2 className="seat-group-title">
            <span>{group.title}</span>
            <span className="seat-group-count">{group.seats.length}</span>
          </h2>
          <div className="seat-grid">
            {group.seats.map((seat) => (
              <SeatCard key={seat.seatId} seat={seat} now={now} onOpen={openSeat} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
