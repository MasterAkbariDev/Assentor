import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { restoreFocus, useEscapeKey } from "../palette/dialog.js";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]";

/**
 * Modal confirmation: Tab cycles inside, Escape cancels, focus starts on Cancel and returns to the
 * opener when the dialog unmounts.
 */
export function ConfirmDialog(props: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const { title, confirmLabel, busy, onConfirm, onCancel, children } = props;
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [opener] = useState<Element | null>(() => document.activeElement);

  useEffect(() => {
    cancelRef.current?.focus();
    return () => restoreFocus(opener);
  }, [opener]);
  useEscapeKey(onCancel);

  const trapTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return event.preventDefault();
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !rootRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !rootRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="palette-backdrop">
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="help diff-dialog" onKeyDown={trapTab}>
        <div className="help-head">
          <h2 id={titleId} className="help-title">
            {title}
          </h2>
        </div>
        <div className="diff-dialog-body">{children}</div>
        <div className="diff-dialog-actions">
          <button ref={cancelRef} type="button" className="help-close" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="help-close diff-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
