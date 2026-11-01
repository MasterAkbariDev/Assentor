import { useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { OUTPUT_TAIL_CHARS } from "#assentor/ui-shared/status.js";
import { ansiColor, parseAnsi } from "./ansi.js";

/** Distance from the bottom, in px, that still counts as "at the bottom". */
const BOTTOM_SLACK_PX = 8;

/**
 * The seat's output tail, ANSI colours as styled spans (text only, never HTML). It follows the end while the reader is
 * at the bottom; once they scroll up, it stays put until "Jump to latest".
 */
export function SeatOutput({ text }: { text: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  const spans = useMemo(() => parseAnsi(text.slice(-OUTPUT_TAIL_CHARS)), [text]);

  useLayoutEffect(() => {
    const pre = preRef.current;
    if (following && pre) {
      pre.scrollTop = pre.scrollHeight;
    }
  }, [text, following]);

  const onScroll = (event: UIEvent<HTMLPreElement>) => {
    const el = event.currentTarget;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX);
  };

  if (text === "") {
    return <p className="empty">No output yet.</p>;
  }
  return (
    <div className="seat-output">
      <pre ref={preRef} className="seat-output-text" tabIndex={0} onScroll={onScroll}>
        {spans.map((span, i) => (
          // Colours go through the CSSOM (React's style prop), which the page's style-src 'self' allows.
          <span
            key={i}
            style={{
              ...(span.fg !== undefined ? { color: ansiColor(span.fg) } : {}),
              ...(span.bg !== undefined ? { backgroundColor: ansiColor(span.bg) } : {}),
              ...(span.bold ? { fontWeight: 700 } : {}),
            }}
          >
            {span.text}
          </span>
        ))}
      </pre>
      {following ? null : (
        <button type="button" className="seat-output-jump" onClick={() => setFollowing(true)}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
