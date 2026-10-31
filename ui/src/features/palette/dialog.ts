import { useEffect, type KeyboardEvent } from "react";

/** Put focus back on what opened a dialog, if it is still on screen. */
export function restoreFocus(opener: Element | null): void {
  if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
    opener.focus();
  }
}

/**
 * Escape closes the dialog. Listens in the capture phase and stops the event, so an
 * open seat drawer underneath does not close too.
 */
export function useEscapeKey(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
}

/** Keep Tab inside a dialog whose only focusable control is the one already focused. */
export function holdTab(event: KeyboardEvent): void {
  if (event.key === "Tab") event.preventDefault();
}
