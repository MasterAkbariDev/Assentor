import { useId, useState } from "react";
import { ConfirmAction } from "./ConfirmAction.js";
import { PauseToggle } from "./PauseToggle.js";
import { useSessionControl } from "./useSessionControl.js";
import { WriteButton } from "./WriteButton.js";

/** Session header actions: Pause/Resume session, and Cancel session (after a confirm dialog). */
export function SessionActions() {
  const control = useSessionControl();
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const reason = control.reasonFor("session.cancel");
  return (
    <div className="session-actions">
      <PauseToggle target="session" />
      <WriteButton reason={reason} reasonId={reasonId} onClick={() => setOpen(true)}>
        Cancel session
      </WriteButton>
      {reason ? (
        <span id={reasonId} className="write-reason">
          {reason}
        </span>
      ) : null}
      {open ? (
        <ConfirmAction title="Cancel this session?" confirmLabel="Cancel session" run={control.cancelSession} onDone={() => setOpen(false)} onCancel={() => setOpen(false)}>
          <p>Running seats are stopped and the run ends as cancelled. This cannot be undone.</p>
        </ConfirmAction>
      ) : null}
    </div>
  );
}
