import { seatLineModel, STATUS_META, type SeatState } from "@engine/ui-shared/status.js";

/**
 * One seat on the board. Read-only: no handler and no button. The status icon
 * is decorative; its label sits next to it, so the status is always in text.
 * `now` comes from the board's single ticker.
 */
export function SeatCard({ seat, now }: { seat: SeatState; now: number }) {
  const line = seatLineModel(seat, now);
  const thinking = seat.status === "thinking";
  const hasTokens = seat.tokensIn > 0 || seat.tokensOut > 0;
  return (
    <article className={`seat-card tone-${STATUS_META[seat.status].tone}`} data-seat-id={seat.seatId}>
      <div className="seat-card-head">
        <span className="seat-card-status">
          <span className={thinking ? "seat-card-icon is-thinking" : "seat-card-icon"} aria-hidden="true">
            {line.icon}
          </span>
          <span className="seat-card-label">{line.label}</span>
        </span>
        <span className="seat-card-elapsed">{line.elapsed}</span>
      </div>
      <div className="seat-card-name">{line.name}</div>
      <div className="seat-card-meta">
        {line.model} · {line.role}
      </div>
      <div className="seat-card-line" title={line.detail || undefined}>
        {line.detail}
      </div>
      {hasTokens ? (
        <div className="seat-card-tokens">
          {seat.tokensIn} in · {seat.tokensOut} out
        </div>
      ) : null}
    </article>
  );
}
