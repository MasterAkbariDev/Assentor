import { useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../diff/ConfirmDialog.js";
import { errorText } from "./useSessionControl.js";

/**
 * A confirm dialog around one write call. Double clicks are ignored while the call runs; a failure
 * stays in the dialog as text (NotSupported reads "Not supported by this engine yet.").
 */
export function ConfirmAction(props: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  run: () => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const { title, confirmLabel, danger, run, onDone, onCancel, children } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sent = useRef(false);

  const confirm = async () => {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(errorText(e));
      sent.current = false;
      setBusy(false);
      return;
    }
    onDone();
  };

  return (
    <ConfirmDialog title={title} confirmLabel={confirmLabel} danger={danger} busy={busy} onConfirm={() => void confirm()} onCancel={onCancel}>
      {children}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
