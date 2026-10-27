import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { SeatState } from "@engine/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { isLiveSeat } from "../../store/selectors.js";
import { useNow } from "../session-board/useNow.js";
import { SeatActivity } from "./SeatActivity.js";
import { SeatInfo } from "./SeatInfo.js";
import { SeatOutput } from "./SeatOutput.js";

/** Refresh period of the drawer's elapsed time (Info tab). */
const TICK_MS = 1000;

const TABS = [
  { id: "activity", label: "Activity" },
  { id: "output", label: "Output" },
  { id: "info", label: "Info" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Read-only drawer for one seat. Mounted in the session panel; open while
 * `openSeatId` is set in the store. Cards open it, Escape and the close button
 * close it and return focus to the card.
 */
export function SeatDrawer() {
  const seat = useEngine((s) => (s.openSeatId ? s.session?.seats[s.openSeatId] : undefined));
  if (!seat) {
    return null;
  }
  return <SeatDrawerPanel key={seat.seatId} seat={seat} />;
}

function SeatDrawerPanel({ seat }: { seat: SeatState }) {
  const closeSeat = useEngine((s) => s.openSeat);
  const [tab, setTab] = useState<TabId>("activity");
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const now = useNow(TICK_MS, isLiveSeat(seat));

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSeat(undefined);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSeat]);

  // Unmounting means the drawer closed (button, Escape, or the run changed).
  // Put focus back on the card that opened it, if it is still on the board.
  const seatId = seat.seatId;
  useEffect(() => () => focusCard(seatId), [seatId]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = TABS.length;
    const index = TABS.findIndex((t) => t.id === tab);
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
    const target = TABS[next];
    if (!target) {
      return;
    }
    event.preventDefault();
    setTab(target.id);
    tabRefs.current[next]?.focus();
  };

  const panelId = `${titleId}-panel`;
  const tabId = (id: TabId) => `${titleId}-tab-${id}`;

  return (
    <div className="seat-drawer" role="dialog" aria-labelledby={titleId}>
      <div className="seat-drawer-head">
        <h2 id={titleId} className="seat-drawer-title">
          {seat.displayName}
        </h2>
        <button ref={closeRef} type="button" className="seat-drawer-close" onClick={() => closeSeat(undefined)}>
          Close
        </button>
      </div>
      <div role="tablist" aria-label="Seat details" className="seat-drawer-tabs" onKeyDown={onTabKeyDown}>
        {TABS.map((t, i) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              id={tabId(t.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className="seat-drawer-tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)} tabIndex={0} className="seat-drawer-body">
        {tab === "activity" ? <SeatActivity seatId={seat.seatId} /> : null}
        {tab === "output" ? <SeatOutput text={seat.outputTail} /> : null}
        {tab === "info" ? <SeatInfo seat={seat} now={now} /> : null}
      </div>
    </div>
  );
}

/** Focus the board card for `seatId`, if it is on screen. */
function focusCard(seatId: string): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-seat-id]"));
  cards.find((card) => card.dataset.seatId === seatId)?.focus();
}
