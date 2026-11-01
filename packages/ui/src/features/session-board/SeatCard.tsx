import { memo, type KeyboardEvent } from "react";
import { ModelPicker } from "./ModelPicker.js";
import { seatLineModel, STATUS_META, type SeatState } from "#assentor/ui-shared/status.js";

/**
 * One seat on the board. A click, Enter or Space opens the seat drawer for it.
 * The card is the only control on the board. The status icon is decorative;
 * its label sits next to it, so the status is always in text. `now` comes from
 * the board's single ticker. Memoized: a card re-renders only when its own seat (or `now`) changes.
 */
export const SeatCard = memo(function SeatCard({
  seat,
  now,
  onOpen,
}: {
  seat: SeatState;
  now: number;
  onOpen: (seatId: string) => void;
}) {
  const line = seatLineModel(seat, now);
  const thinking = seat.status === "thinking";
  const hasTokens = seat.tokensIn > 0 || seat.tokensOut > 0;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(seat.seatId);
    }
  };
  return (
    <article
      className={`seat-card tone-${STATUS_META[seat.status].tone}`}
      data-seat-id={seat.seatId}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      onClick={() => onOpen(seat.seatId)}
      onKeyDown={onKeyDown}
    >
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
        {line.role}
      </div>
      <ModelPicker seat={seat} />
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
});
