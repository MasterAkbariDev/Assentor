import { useLayoutEffect, useRef, useState, type UIEvent } from "react";

/** Distance from the bottom, in px, that still counts as "at the bottom". */
const BOTTOM_SLACK_PX = 8;

/**
 * The seat's output tail as plain text. It follows the end while the reader is
 * at the bottom; once they scroll up, it stays put until "Jump to latest".
 */
export function SeatOutput({ text }: { text: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);

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
        {text}
      </pre>
      {following ? null : (
        <button type="button" className="seat-output-jump" onClick={() => setFollowing(true)}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
