import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { NegotiationView } from "./features/negotiation/NegotiationView.js";
import { LeadBoard } from "./features/lead-board/LeadBoard.js";
import { SeatDrawer } from "./features/seat-drawer/SeatDrawer.js";
import { CommandPalette } from "./features/palette/CommandPalette.js";
import { KeyboardHelp } from "./features/palette/KeyboardHelp.js";
import { useShortcuts } from "./features/palette/useShortcuts.js";
import { PlaybooksView } from "./features/playbooks/PlaybooksView.js";
import { PromptsView } from "./features/prompts/PromptsView.js";
import { TeamsView } from "./features/teams/TeamsView.js";
import { ReviewView } from "./features/review/ReviewView.js";
import { SessionBoard } from "./features/session-board/SessionBoard.js";
import { useEngine } from "./store/context.js";
import type { ConnectionStatus } from "./store/engineStore.js";
import { selectHasNegotiation, selectHasReview } from "./store/selectors.js";
import { useRoute, SECTIONS } from "./shell/route.js";
import { EmptySection, SectionNav } from "./shell/Sidebar.js";
import { useConnectionToasts } from "./shell/Toasts.js";

// Dev only: `import.meta.env.DEV` is false in the production build, so this chunk is never emitted.
const FixturesPage = import.meta.env.DEV ? lazy(() => import("./features/dev/FixturesPage.js")) : undefined;

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
  const route = useRoute();
  useConnectionToasts(connection);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  useShortcuts({ enabled: !paletteOpen && !helpOpen, onPalette: openPalette, onHelp: openHelp });

  return (
    <div className="shell">
      <header className="header">
        <span className="brand">Assentor</span>
        <span className={`conn conn-${connection}`} role="status">
          {CONNECTION_LABEL[connection]}
          {engineVersion && connection === "connected" ? ` · engine ${engineVersion}` : ""}
        </span>
        <button type="button" className="header-keys" onClick={openHelp}>
          Shortcuts
        </button>
        <label className="theme">
          Theme{" "}
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>
      <aside className="sidebar">
        <SectionNav route={route} />
        {route === "sessions" ? <SessionList /> : null}
      </aside>
      <main className="main">
        <ConnectionNotice />
        {route === "sessions" ? <SessionPanel /> : null}
        {route === "dev/fixtures" && FixturesPage ? (
          <Suspense fallback={<p className="empty">Loading…</p>}>
            <FixturesPage />
          </Suspense>
        ) : null}
        {route === "prompts" ? <PromptsView /> : null}
        {route === "teams" ? <TeamsView /> : null}
        {route === "playbooks" ? <PlaybooksView /> : null}
        {SECTIONS.filter((s) => s.id === "settings" && s.id === route).map((s) => (
          <EmptySection key={s.id} id={s.id} label={s.label} />
        ))}
      </main>
      {paletteOpen ? <CommandPalette onClose={closePalette} /> : null}
      {helpOpen ? <KeyboardHelp onClose={closeHelp} /> : null}
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

/** The selected run: heading, error notice, empty states, and the session board. */
export function SessionPanel() {
  const session = useEngine((s) => s.session);
  const summary = useEngine((s) => s.sessions.find((x) => x.id === s.selectedId));
  const hasReview = useEngine(selectHasReview);
  const hasNegotiation = useEngine(selectHasNegotiation);

  if (!session) {
    return <p className="empty">Select a run to watch it live.</p>;
  }
  if (summary && !summary.hasLiveLog) {
    return <p className="empty">This run was made before live logs existed; there is nothing to stream.</p>;
  }
  const seatCount = Object.keys(session.seats).length;
  return (
    <section aria-label="Seats">
      <h1 className="session-heading">
        {summary?.title ?? session.id}
        {session.state ? <span className="session-state"> · {session.state}</span> : null}
      </h1>
      {session.error ? <p className="notice error">{session.error}</p> : null}
      <LeadBoard />
      {seatCount === 0 ? (
        <p className="empty">Waiting for events…</p>
      ) : (
        <>
          <SessionBoard />
          <SeatDrawer />
          {hasReview ? <ReviewView /> : null}
        </>
      )}
      {hasNegotiation ? <NegotiationView key={session.id} /> : null}
    </section>
  );
}
