import { useId, useRef, useState } from "react";
import { errorText, useSessionControl } from "./useSessionControl.js";
import { WriteButton } from "./WriteButton.js";

/**
 * Pause/Resume for the whole session (`session.pause`) or for the Lead controller (`lead.pause`).
 * The two are separate states with separate badges ("Session paused", "Lead paused"). No confirm:
 * both are reversible and turns in flight finish. The badge is a status region that is always mounted.
 */
export function PauseToggle({ target }: { target: "session" | "lead" }) {
  const control = useSessionControl();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sent = useRef(false);
  const paused = target === "session" ? control.paused : control.leadPaused;
  const noun = target === "session" ? "session" : "lead";
  const reason = control.reasonFor(`${target}.${paused ? "resume" : "pause"}`);
  const toggle = async () => {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await (target === "session" ? (paused ? control.resume() : control.pause()) : paused ? control.leadResume() : control.leadPause());
    } catch (e) {
      setError(errorText(e));
    } finally {
      sent.current = false;
      setBusy(false);
    }
  };
  return (
    <span className="pause-toggle">
      <span role="status" className={paused ? "badge paused" : undefined}>
        {paused ? `${target === "session" ? "Session" : "Lead"} paused` : ""}
      </span>
      <WriteButton reason={reason} reasonId={`${id}-reason`} busy={busy} onClick={() => void toggle()}>
        {paused ? `Resume ${noun}` : `Pause ${noun}`}
      </WriteButton>
      {reason ? (
        <span id={`${id}-reason`} className="write-reason">
          {reason}
        </span>
      ) : null}
      {error ? (
        <span className="notice error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
