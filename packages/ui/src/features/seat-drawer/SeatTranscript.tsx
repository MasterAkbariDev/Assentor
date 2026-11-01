import { useMemo, useState } from "react";
import { useEngine } from "../../store/context.js";
import { diffHref, transcriptItems } from "./transcript.js";

/** Rows shown at first, and added by each "Show earlier". */
const WINDOW = 50;

/** The seat's tool calls and results, newest at the bottom; only the last rows are rendered. */
export function SeatTranscript({ seatId }: { seatId: string }) {
  const events = useEngine((s) => s.session?.seatEvents[seatId]);
  const items = useMemo(() => transcriptItems(events ?? []), [events]);
  const [shown, setShown] = useState(WINDOW);
  if (items.length === 0) {
    return <p className="empty">No messages or tool calls yet.</p>;
  }
  const hidden = Math.max(0, items.length - shown);
  return (
    <div className="seat-transcript">
      {hidden > 0 ? (
        <button type="button" className="seat-more" onClick={() => setShown(shown + WINDOW)}>
          Show earlier ({hidden})
        </button>
      ) : null}
      <ol className="seat-activity" aria-label="Transcript">
        {items.slice(-shown).map((item) => (
          <li key={item.key} className="seat-activity-row">
            <time dateTime={item.at} className="seat-activity-time">
              {item.time}
            </time>
            {item.kind === "tool" ? (
              <span className="seat-activity-text" title={item.fullArgs}>
                <strong className="seat-tool-name">{item.name}</strong>
                {item.args ? <> {item.file === item.args ? <a href={diffHref(seatId, item.file)}>{item.args}</a> : item.args}</> : null}
                {item.file && item.file !== item.args ? (
                  <>
                    {" "}
                    <a href={diffHref(seatId, item.file)}>{item.file}</a>
                  </>
                ) : null}
              </span>
            ) : (
              <span className={item.error ? "seat-activity-text seat-msg-error" : "seat-activity-text"}>{item.text}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
