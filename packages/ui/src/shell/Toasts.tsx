import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

const ToastContext = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);

/** `const toast = useToast(); toast("Saved")`. Without a provider it does nothing. */
export const useToast = () => useContext(ToastContext);

const TOAST_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (text: string, kind: Toast["kind"] = "info") => {
      const id = nextId.current++;
      setToasts((all) => [...all, { id, text, kind }].slice(-4));
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      {toasts.length > 0 ? (
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <span>{t.text}</span>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

/** Tells the user when the link drops and when it is back (not on the first connect). */
export function useConnectionToasts(connection: string): void {
  const toast = useToast();
  const previous = useRef(connection);
  useEffect(() => {
    const before = previous.current;
    previous.current = connection;
    if (connection === "reconnecting" && before === "connected") toast("Connection lost. Reconnecting…", "error");
    if (connection === "connected" && before === "reconnecting") toast("Reconnected.");
  }, [connection, toast]);
}
