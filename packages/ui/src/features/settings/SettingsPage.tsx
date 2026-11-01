import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AUTONOMY_LEVELS } from "#assentor/protocol/events.js";
import { useEngine } from "../../store/context.js";
import { useToast } from "../../shell/Toasts.js";
import { useRpc } from "../../transport/context.js";
import { disabledReason, useCallableMethods } from "./access.js";
import { CliCheck, DoctorCheck } from "./Diagnostics.js";
import {
  ARTIFACT_FIELDS,
  AUTONOMY_LABELS,
  EXECUTOR_PROVIDERS,
  GIT_FIELDS,
  LIMIT_FIELDS,
  REVIEW_STRATEGIES,
  ROUTING_STRATEGIES,
  buildPatch,
  messageOf,
  toForm,
  validate,
  type KeySummary,
  type SettingsForm,
} from "./model.js";

interface View {
  baseline: SettingsForm;
  form: SettingsForm;
  keys: KeySummary[];
}

type A11y = { id: string; "aria-invalid"?: true; "aria-describedby"?: string };

/** A labelled control. `children` receives the ids and ARIA attributes the control needs. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: (a11y: A11y) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="field-error" role="alert">{error}</p> : null}
    </div>
  );
}

/**
 * Settings (T04-13): the plain settings `settings.get` returns, saved with `settings.save`
 * (only the changed fields are sent). Keys are listed, never edited or shown. Diagnostics and
 * CLI detection run the write methods `env.doctor` and `env.detectClis`. Without write access
 * every write control is disabled with its reason.
 */
export function SettingsPage() {
  const rpc = useRpc();
  const connection = useEngine((s) => s.connection);
  const toast = useToast();
  const methods = useCallableMethods();
  const [view, setView] = useState<View>();
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  useEffect(() => {
    if (connection !== "connected") return;
    let live = true;
    rpc.call("settings.get").then(
      ({ settings, keys }) => {
        if (!live) return;
        const form = toForm(settings);
        setView({ baseline: form, form, keys });
        setLoadError(undefined);
      },
      (error: unknown) => {
        if (live) setLoadError(messageOf(error));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, connection]);

  if (!view) {
    return (
      <section aria-labelledby="settings-title">
        <h1 id="settings-title" className="session-heading">Settings</h1>
        {loadError ? <p role="alert" className="notice error">Could not load settings: {loadError}</p> : <p className="empty">Loading settings…</p>}
      </section>
    );
  }

  const { baseline, form, keys } = view;
  const errors = validate(form, baseline);
  const hasErrors = Object.keys(errors).length > 0;
  const dirty = Object.keys(buildPatch(form, baseline)).length > 0;
  const writeBlock = disabledReason(methods, "settings.save");
  const saveDisabled = writeBlock !== undefined || saving || !dirty || hasErrors;
  const saveHint = writeBlock ?? (hasErrors ? "Fix the fields marked in red to save." : dirty ? undefined : "No changes to save.");
  const providers: string[] = (EXECUTOR_PROVIDERS as readonly string[]).includes(form.executor.provider)
    ? [...EXECUTOR_PROVIDERS]
    : [form.executor.provider, ...EXECUTOR_PROVIDERS];

  const edit = (change: (f: SettingsForm) => SettingsForm) => setView((v) => v && { ...v, form: change(v.form) });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveDisabled) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const { settings } = await rpc.call("settings.save", { settings: buildPatch(form, baseline) });
      const next = toForm(settings);
      setView((v) => v && { ...v, baseline: next, form: next });
      toast("Settings saved");
    } catch (failure) {
      setSaveError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="settings-title" className="settings-page">
      <h1 id="settings-title" className="session-heading">Settings</h1>
      <p className="field-hint">
        Saved to your user config (<code>~/.assentor/config.yaml</code>). A project config can still override these.
      </p>

      <form onSubmit={save} noValidate className="settings-form" aria-label="Settings form">
        <fieldset className="settings-group">
          <legend>Executor</legend>
          <Field id="settings-provider" label="Provider">
            {(a11y) => (
              <select
                {...a11y}
                value={form.executor.provider}
                onChange={(e) => edit((f) => ({ ...f, executor: { ...f.executor, provider: e.target.value } }))}
              >
                {providers.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            )}
          </Field>
          <Field id="settings-model" label="Model" hint="AUTO uses the provider's default model." error={errors["executor.model"]}>
            {(a11y) => (
              <input
                {...a11y}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.executor.model}
                onChange={(e) => edit((f) => ({ ...f, executor: { ...f.executor, model: e.target.value } }))}
              />
            )}
          </Field>
        </fieldset>

        <fieldset className="settings-group">
          <legend>Run autonomy</legend>
          {AUTONOMY_LEVELS.map((level) => (
            <label key={level} className="choice">
              <input
                type="radio"
                name="autonomy"
                value={level}
                checked={form.run.autonomy === level}
                onChange={() => edit((f) => ({ ...f, run: { autonomy: level } }))}
              />{" "}
              {AUTONOMY_LABELS[level]}
            </label>
          ))}
        </fieldset>

        <fieldset className="settings-group">
          <legend>Routing</legend>
          <Field id="settings-strategy" label="Strategy">
            {(a11y) => (
              <select
                {...a11y}
                value={form.routing.strategy}
                onChange={(e) => edit((f) => ({ ...f, routing: { ...f.routing, strategy: e.target.value as SettingsForm["routing"]["strategy"] } }))}
              >
                {ROUTING_STRATEGIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            )}
          </Field>
          <Field id="settings-review-strategy" label="Review strategy">
            {(a11y) => (
              <select
                {...a11y}
                value={form.routing.reviewStrategy}
                onChange={(e) => edit((f) => ({ ...f, routing: { ...f.routing, reviewStrategy: e.target.value as SettingsForm["routing"]["reviewStrategy"] } }))}
              >
                {REVIEW_STRATEGIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            )}
          </Field>
        </fieldset>

        <fieldset className="settings-group">
          <legend>Limits</legend>
          {LIMIT_FIELDS.map(({ key, label }) => (
            <Field key={key} id={`settings-${key}`} label={label} error={errors[`limits.${key}`]}>
              {(a11y) => (
                <input
                  {...a11y}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={form.limits[key]}
                  onChange={(e) => edit((f) => ({ ...f, limits: { ...f.limits, [key]: e.target.value } }))}
                />
              )}
            </Field>
          ))}
        </fieldset>

        <fieldset className="settings-group">
          <legend>Git</legend>
          {GIT_FIELDS.map(({ key, label }) => (
            <label key={key} className="choice">
              <input
                type="checkbox"
                checked={form.git[key]}
                onChange={(e) => edit((f) => ({ ...f, git: { ...f.git, [key]: e.target.checked } }))}
              />{" "}
              {label}
            </label>
          ))}
        </fieldset>

        <fieldset className="settings-group">
          <legend>Artifacts</legend>
          {ARTIFACT_FIELDS.map(({ key, label }) => (
            <label key={key} className="choice">
              <input
                type="checkbox"
                checked={form.artifacts[key]}
                onChange={(e) => edit((f) => ({ ...f, artifacts: { ...f.artifacts, [key]: e.target.checked } }))}
              />{" "}
              {label}
            </label>
          ))}
        </fieldset>

        <div className="settings-actions">
          <button type="submit" disabled={saveDisabled} aria-describedby={saveHint ? "save-hint" : undefined}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {saveHint ? <p id="save-hint" className="field-hint">{saveHint}</p> : null}
          {saveError ? <p role="alert" className="notice error">{saveError}</p> : null}
        </div>
      </form>

      <section aria-labelledby="keys-title" className="settings-section">
        <h2 id="keys-title">API keys</h2>
        <p className="field-hint">
          Stored keys are listed by provider and name only; a secret is never shown or requested here. The web UI cannot add or
          delete keys yet: use <code>assentor keys add --help</code> and <code>assentor keys delete</code> in a terminal.
        </p>
        {keys.length === 0 ? (
          <p className="empty">No keys stored.</p>
        ) : (
          <ul className="check-list" aria-label="Stored keys">
            {keys.map((key) => (
              <li key={key.id} className="check">
                <strong>{key.name}</strong> <span>{key.provider}</span>{" "}
                <span className={key.healthy ? "check-ok" : "check-fail"}>{key.healthy ? "Healthy" : "Not healthy"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="doctor-title" className="settings-section">
        <h2 id="doctor-title">Doctor</h2>
        <p className="field-hint">Runs the same checks as <code>assentor doctor</code>.</p>
        <DoctorCheck disabledReason={disabledReason(methods, "env.doctor")} />
      </section>

      <section aria-labelledby="cli-title" className="settings-section">
        <h2 id="cli-title">CLIs</h2>
        <CliCheck disabledReason={disabledReason(methods, "env.detectClis")} />
      </section>
    </section>
  );
}
