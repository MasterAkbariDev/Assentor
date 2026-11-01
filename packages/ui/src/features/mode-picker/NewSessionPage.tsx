import { useState, type FormEvent } from "react";
import { useRpc } from "../../transport/context.js";
import { useEngine } from "../../store/context.js";
import { MODE_CATALOG, UNAVAILABLE_REASON } from "./modeCatalog.js";
import { useWriteAccess } from "./useWriteAccess.js";

/** Autopilot is not offered here: the serve host caps sessions at supervised. */
type BrowserAutonomy = "manual" | "supervised";

const AUTONOMY_OPTIONS: ReadonlyArray<{ value: BrowserAutonomy; label: string; text: string }> = [
  {
    value: "manual",
    label: "Manual",
    text: "Asks before every stage and before each executor's first run, and before applying changes to your checkout.",
  },
  {
    value: "supervised",
    label: "Supervised",
    text: "Runs on its own and asks before applying changes to your checkout.",
  },
];

const FIRST_AVAILABLE = MODE_CATALOG.find((mode) => mode.available)?.id ?? "";

/** New session (T04-16): pick a mode, write the goal, choose autonomy, then create and start it. */
export function NewSessionPage() {
  const rpc = useRpc();
  const select = useEngine((s) => s.select);
  const access = useWriteAccess();
  const [modeId, setModeId] = useState(FIRST_AVAILABLE);
  const [goal, setGoal] = useState("");
  const [autonomy, setAutonomy] = useState<BrowserAutonomy>("supervised");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const writable = access.state === "allowed";
  const controlsOff = !writable || busy;
  const mode = MODE_CATALOG.find((m) => m.id === modeId);
  const canSubmit = writable && !busy && mode?.available === true && goal.trim().length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    let sessionId: string | undefined;
    try {
      const created = await rpc.call("session.create", { mode: modeId, goal: goal.trim(), autonomy });
      sessionId = created.sessionId;
      await rpc.call("session.start", { sessionId });
      select(sessionId);
      window.location.hash = "#/sessions";
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(sessionId ? `Session ${sessionId} was created but did not start: ${message}` : message);
      setBusy(false);
    }
  }

  return (
    <section aria-label="New session" className="new-session">
      <h1 className="session-heading">New session</h1>
      <p>
        <a href="#/sessions">Back to sessions</a>
      </p>
      {access.state === "checking" ? <p className="empty">Checking this connection…</p> : null}
      {access.state === "denied" ? (
        <p className="notice warn" role="status">
          {access.reason}
        </p>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}

      <form className="new-session-form" onSubmit={submit}>
        <fieldset className="mode-fieldset" disabled={controlsOff}>
          <legend>Mode</legend>
          <div className="mode-grid">
            {MODE_CATALOG.map((card) => {
              const off = !card.available;
              const reasonId = `mode-${card.id}-reason`;
              return (
                <label
                  key={card.id}
                  className={`mode-card${card.id === modeId ? " selected" : ""}${off ? " unavailable" : ""}`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={card.id}
                    checked={card.id === modeId}
                    disabled={off}
                    aria-describedby={off ? reasonId : undefined}
                    onChange={() => setModeId(card.id)}
                  />
                  <span className="mode-card-title">{card.title}</span>
                  <span className="mode-card-description">{card.description}</span>
                  <span className="mode-card-badges">
                    <span className="badge">{card.kind === "static" ? "Static" : "Dynamic"}</span>
                    <span className="badge">{card.editsCode ? "Edits code" : "No code edits"}</span>
                    <span className="badge">Default: {card.defaultAutonomy}</span>
                  </span>
                  {off ? (
                    <span id={reasonId} className="mode-card-reason">
                      {UNAVAILABLE_REASON}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="goal-field">
          <span>Goal</span>
          <textarea
            name="goal"
            rows={4}
            maxLength={20_000}
            value={goal}
            disabled={controlsOff}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>

        <fieldset className="autonomy-fieldset" disabled={controlsOff}>
          <legend>Autonomy</legend>
          {AUTONOMY_OPTIONS.map((option) => (
            <label key={option.value} className="autonomy-option">
              <input
                type="radio"
                name="autonomy"
                value={option.value}
                checked={autonomy === option.value}
                onChange={() => setAutonomy(option.value)}
              />
              <span className="autonomy-label">{option.label}</span>
              <span className="autonomy-text">{option.text}</span>
            </label>
          ))}
          <p className="autonomy-note">Autopilot is not offered from the browser.</p>
        </fieldset>

        <div className="new-session-actions">
          <button type="submit" disabled={!canSubmit}>
            {busy ? "Starting…" : "Create and start"}
          </button>
        </div>
      </form>
    </section>
  );
}
