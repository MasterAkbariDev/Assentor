import { useCallback, useEffect, useRef, useState } from "react";
import { useCanWrite } from "../../transport/context.js";

/** Pieces shared by the Prompts, Teams and Playbooks screens. */

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const LEAVE = "You have unsaved changes. Discard them?";

/**
 * Warns before unsaved edits are lost: on reload/close (`beforeunload`) and on a section link click.
 * Returns `confirmLeave()` for in-screen switches (picking another item).
 * shortcut: the browser Back button and the command palette navigate without a prompt; add a router blocker with the full router.
 */
export function useUnsavedGuard(dirty: boolean): () => boolean {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest("a[href^='#']") : null;
      if (link && !window.confirm(LEAVE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);
  return useCallback(() => !dirtyRef.current || window.confirm(LEAVE), []);
}

/** `value` after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

export const WRITE_REASON = "This connection is read-only. Start `assentor serve --allow-write` and reopen the link to edit.";

/** Visible reason a write control is disabled (also linked with `aria-describedby`). */
export function WriteNote({ id }: { id: string }) {
  const canWrite = useCanWrite();
  return canWrite ? null : (
    <p id={id} className="notice warn lib-note">
      {WRITE_REASON}
    </p>
  );
}

export function SourceBadge({ source }: { source: string }) {
  return <span className={`badge badge-${source}`}>{source}</span>;
}

/** A save/delete/validation outcome: errors are announced at once (`alert`), successes politely (`status`). */
export function Outcome({ kind, text, children }: { kind: "ok" | "error"; text: string; children?: React.ReactNode }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={kind === "error" ? "notice error" : "notice lib-ok"}>
      {text}
      {children}
    </div>
  );
}
