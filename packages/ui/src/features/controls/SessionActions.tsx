import { useState } from "react";
import { ConfirmAction } from "./ConfirmAction.js";
import { useSessionControl } from "./useSessionControl.js";

/** Session header actions: Cancel session (after a confirm dialog). */
export function SessionActions() {
  const control = useSessionControl();
  const [open, setOpen] = useState(false);
  const reason = control.reasonFor("session.cancel");
  return (
    <div className="session-actions">
      <button type="button" className="write-btn" disabled={reason !== undefined} aria-describedby={reason ? "cancel-reason" : undefined} onClick={() => setOpen(true)}>
        Cancel session
      </button>
      {reason ? (
        <span id="cancel-reason" className="write-reason">
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
