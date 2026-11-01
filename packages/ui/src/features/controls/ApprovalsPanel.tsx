import { useId, useRef, useState } from "react";
import { ConfirmAction } from "./ConfirmAction.js";
import { errorText, useSessionControl, type Approval } from "./useSessionControl.js";
import { WriteButton } from "./WriteButton.js";

/**
 * The approval for the integrate step (Lead mode's "approve integration"). The protocol has no
 * field for this (`user.question` carries only id, text and kind), so it is the word "integrate" or
 * "integration" in the id or the text. shortcut: switch to a stage/kind field when the engine sends one.
 */
export const isIntegration = (a: Approval): boolean => /\bintegrat(e|ion)\b/i.test(`${a.id} ${a.text}`);

/**
 * Open approval questions of the selected run, each with Approve and Deny (`session.approve`).
 * `scope` splits them between the Lead board (integration) and the session board (the rest).
 * The wrapper is a polite live region that is always mounted, so new and answered approvals are announced.
 */
export function ApprovalsPanel({ scope }: { scope: "all" | "integration" | "other" }) {
  const control = useSessionControl();
  const shown = control.approvals.filter((a) => scope === "all" || isIntegration(a) === (scope === "integration"));
  const reason = control.reasonFor("session.approve");
  const id = useId();
  const [busy, setBusy] = useState<string>();
  const sent = useRef(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<Approval>();

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
    <div aria-live="polite">
      {shown.length === 0 ? null : (
        <section className="approvals" aria-label="Pending approvals">
          <h2 className="approvals-title">{scope === "integration" ? "Integration approval" : "Pending approvals"}</h2>
          {reason ? (
            <p id={`${id}-reason`} className="write-reason">
              {reason}
            </p>
          ) : null}
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
          <ul className="approvals-list">
            {shown.map((a) => {
              const gate = a.canDeny ? undefined : "A stage gate can only be approved; cancel the session to refuse it.";
              const integration = isIntegration(a);
              return (
                <li key={a.id} className="approval">
                  <span className="approval-text">{a.text}</span>
                  <WriteButton
                    reason={reason}
                    reasonId={`${id}-reason`}
                    busy={busy !== undefined}
                    aria-label={`${integration ? "Approve integration" : "Approve"}: ${a.text}`}
                    onClick={() => (integration ? setConfirming(a) : void answer(a, "approve"))}
                  >
                    {integration ? "Approve integration" : "Approve"}
                  </WriteButton>
                  <WriteButton
                    reason={reason ?? gate}
                    reasonId={reason ? `${id}-reason` : `${id}-${a.id}-gate`}
                    busy={busy !== undefined}
                    aria-label={`Deny: ${a.text}`}
                    onClick={() => void answer(a, "deny")}
                  >
                    Deny
                  </WriteButton>
                  {gate && !reason ? (
                    <span id={`${id}-${a.id}-gate`} className="write-reason">
                      {gate}
                    </span>
                  ) : null}
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
      )}
    </div>
  );
}
