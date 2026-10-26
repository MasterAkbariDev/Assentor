import { useEffect, useState } from "react";
import { STATUS_META, seatLineModel } from "@engine/ui-shared/status.js";
import { useEngine } from "./store/context.js";
import type { ConnectionStatus } from "./store/engineStore.js";

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  unauthorized: "Link expired",
  no_token: "No access token",
};

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("assentor.theme") as Theme | null) ?? "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("assentor.theme", theme);
    } catch {
      // not persisted; fine
    }
  }, [theme]);
  return [theme, setTheme];
}

export function App() {
  const connection = useEngine((s) => s.connection);
  const engineVersion = useEngine((s) => s.engineVersion);
  const [theme, setTheme] = useTheme();

  return (
    <div className="shell">
      <header className="header">
        <span className="brand">Assentor</span>
        <span className={`conn conn-${connection}`} role="status">
          {CONNECTION_LABEL[connection]}
          {engineVersion && connection === "connected" ? ` · engine ${engineVersion}` : ""}
        </span>
        <label className="theme">
          Theme{" "}
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>
      <aside className="sidebar" aria-label="Sessions">
        <SessionList />
      </aside>
      <main className="main">
        <ConnectionNotice />
        <SessionPanel />
      </main>
    </div>
  );
}

function ConnectionNotice() {
  const connection = useEngine((s) => s.connection);
  if (connection === "no_token" || connection === "unauthorized") {
    return (
      <p className="notice warn">
        {connection === "no_token"
          ? "Open the link printed by `assentor serve` (it carries the access token)."
          : "This link is no longer valid. Restart `assentor serve` or open the link it printed."}
      </p>
    );
  }
  return null;
}

export function SessionList() {
  const sessions = useEngine((s) => s.sessions);
  const selectedId = useEngine((s) => s.selectedId);
  const select = useEngine((s) => s.select);
  if (sessions.length === 0) {
    return <p className="empty">No runs yet. Start one with <code>assentor run "…"</code>.</p>;
  }
  return (
    <ul className="session-list">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            className={session.id === selectedId ? "session selected" : "session"}
            aria-current={session.id === selectedId ? "true" : undefined}
            onClick={() => select(session.id)}
          >
            <span className="session-title">{session.title}</span>
            <span className="session-meta">
              {session.status ?? "—"}
              {session.hasLiveLog ? "" : " · no live log"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Placeholder seat view; the session board (T04-07p) replaces it. */
export function SessionPanel() {
  const session = useEngine((s) => s.session);
  const summary = useEngine((s) => s.sessions.find((x) => x.id === s.selectedId));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!session) {
    return <p className="empty">Select a run to watch it live.</p>;
  }
  if (summary && !summary.hasLiveLog) {
    return <p className="empty">This run was made before live logs existed; there is nothing to stream.</p>;
  }
  const seats = Object.values(session.seats);
  return (
    <section aria-label="Seats">
      <h1 className="session-heading">
        {summary?.title ?? session.id}
        {session.state ? <span className="session-state"> · {session.state}</span> : null}
      </h1>
      {session.error ? <p className="notice error">{session.error}</p> : null}
      {seats.length === 0 ? (
        <p className="empty">Waiting for events…</p>
      ) : (
        <ul className="seat-list">
          {seats.map((seat) => {
            const line = seatLineModel(seat, now);
            return (
              <li key={seat.seatId} className={`seat tone-${STATUS_META[seat.status].tone}`}>
                <span className="seat-status">
                  <span aria-hidden="true">{line.icon}</span> {line.label}
                </span>
                <span className="seat-name">{line.name}</span>
                <span className="seat-meta">
                  {line.model} · {line.role}
                </span>
                <span className="seat-detail">{line.detail}</span>
                <span className="seat-elapsed">{line.elapsed}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
