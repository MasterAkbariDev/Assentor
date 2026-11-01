import { useRef, useState } from "react";
import { ConfirmAction } from "./ConfirmAction.js";
import { errorText, useSessionControl, type Approval } from "./useSessionControl.js";

/** The approval for the integrate step (Lead mode's "approve integration"). */
export const isIntegration = (a: Approval): boolean => /integrat/i.test(`${a.id} ${a.text}`);

/**
 * Open approval questions of the selected run, each with Approve and Deny (`session.approve`).
 * `scope` splits them between the Lead board (integration) and the session board (the rest).
 */
export function ApprovalsPanel({ scope }: { scope: "all" | "integration" | "other" }) {
  const control = useSessionControl();
  const shown = control.approvals.filter((a) => scope === "all" || isIntegration(a) === (scope === "integration"));
  const reason = control.reasonFor("session.approve");
  const [busy, setBusy] = useState<string>();
  const sent = useRef(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<Approval>();
  if (shown.length === 0) return null;

  const answer = async (a: Approval, decision: "approve" | "deny") => {
    if (sent.current) return;
    sent.current = true;
    setBusy(a.id);
    setError(undefined);
    try {
      await control.answerApproval(a.id, decision);
    } catch (e) {
      setError(errorText(e));
    } finally {
      sent.current = false;
      setBusy(undefined);
    }
  };

  return (
    <section className="approvals" aria-label="Pending approvals">
      <h2 className="approvals-title">{scope === "integration" ? "Integration approval" : "Pending approvals"}</h2>
      {reason ? <p className="write-reason">{reason}</p> : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="approvals-list">
        {shown.map((a) => {
          const denyReason = reason ?? (a.canDeny ? undefined : "A stage gate can only be approved; cancel the session to refuse it.");
          const integration = isIntegration(a);
          return (
            <li key={a.id} className="approval">
              <span className="approval-text">{a.text}</span>
              <button
                type="button"
                className="write-btn"
                disabled={reason !== undefined || busy !== undefined}
                aria-label={`${integration ? "Approve integration" : "Approve"}: ${a.text}`}
                onClick={() => (integration ? setConfirming(a) : void answer(a, "approve"))}
              >
                {integration ? "Approve integration" : "Approve"}
              </button>
              <button type="button" className="write-btn" disabled={denyReason !== undefined || busy !== undefined} title={denyReason} aria-label={`Deny: ${a.text}`} onClick={() => void answer(a, "deny")}>
                Deny
              </button>
            </li>
          );
        })}
      </ul>
      {confirming ? (
        <ConfirmAction
          title="Approve integration?"
          confirmLabel="Approve integration"
          danger={false}
          run={() => control.answerApproval(confirming.id, "approve")}
          onDone={() => setConfirming(undefined)}
          onCancel={() => setConfirming(undefined)}
        >
          <p>{confirming.text}</p>
        </ConfirmAction>
      ) : null}
    </section>
  );
}
