import { useId, useRef, useState, type KeyboardEvent } from "react";
import { INJECT_MAX_BYTES } from "#assentor/protocol/rpc.js";
import { isComposing } from "../../keymap.js";
import { errorText, useSessionControl } from "./useSessionControl.js";
import { WriteButton } from "./WriteButton.js";

/** UTF-8 size of `text`, the unit of the 8 KiB cap. */
export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Message to a seat (`seat.inject`), queued for its next turn. Enter sends, Shift+Enter is a newline.
 * The counter is in UTF-8 bytes against the 8 KiB cap; an over-long or blank message cannot be sent.
 * Cleared on success; a refusal (Rejected) stays as text and the draft is kept.
 */
export function SeatInject({ seatId, finished }: { seatId: string; finished?: string }) {
  const control = useSessionControl();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const sent = useRef(false);
  const bytes = byteLength(text);
  const reason = control.reasonFor("seat.inject") ?? finished;
  const invalid = text.trim() === "" ? "Type a message first." : bytes > INJECT_MAX_BYTES ? `The message is over the ${INJECT_MAX_BYTES / 1024} KiB limit.` : undefined;

  const send = async () => {
    if (sent.current || reason || invalid) return;
    sent.current = true;
    setBusy(true);
    setResult(undefined);
    const sentText = text;
    try {
      await control.inject(seatId, sentText);
      // Only what was sent: anything typed since stays.
      setText((now) => (now === sentText ? "" : now));
      setResult({ ok: true, text: "Message queued for the seat's next turn." });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      sent.current = false;
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || isComposing(event.nativeEvent)) return;
    event.preventDefault();
    void send();
  };
  const describedBy = [reason ? `${id}-reason` : "", `${id}-count`].filter(Boolean).join(" ");
  return (
    <div className="seat-inject">
      <label htmlFor={`${id}-text`}>Message to seat</label>
      <textarea
        id={`${id}-text`}
        value={text}
        rows={3}
        readOnly={reason !== undefined || busy}
        aria-disabled={reason !== undefined ? true : undefined}
        aria-invalid={bytes > INJECT_MAX_BYTES ? true : undefined}
        aria-describedby={describedBy}
        placeholder="Enter sends, Shift+Enter adds a line"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span id={`${id}-count`} className={bytes > INJECT_MAX_BYTES ? "inject-count is-over" : "inject-count"}>
        {bytes} / {INJECT_MAX_BYTES} bytes
      </span>
      <WriteButton type="button" reason={reason ?? invalid} reasonId={reason ? `${id}-reason` : `${id}-invalid`} busy={busy} onClick={() => void send()}>
        Send message
      </WriteButton>
      {reason ? (
        <p id={`${id}-reason`} className="write-reason">
          {reason}
        </p>
      ) : invalid ? (
        <p id={`${id}-invalid`} className="write-reason">
          {invalid}
        </p>
      ) : null}
      {result ? (
        <p className={result.ok ? "notice" : "notice error"} role={result.ok ? "status" : "alert"}>
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
