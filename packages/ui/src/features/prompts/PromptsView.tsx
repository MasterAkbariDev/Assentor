import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { RpcResult } from "#assentor/protocol/rpc.js";
import { useCanWrite, useRpc } from "../../transport/context.js";
import { errorText, Outcome, SourceBadge, useDebounced, useUnsavedGuard, WriteNote } from "./shared.js";

type Summary = RpcResult<"prompt.list">["prompts"][number];
type Detail = RpcResult<"prompt.get">;
type Validation = RpcResult<"prompt.validate">;
type Preview = RpcResult<"prompt.preview">;
type Scope = "user" | "project";

// Mirrors PROMPT_ROLES / PROMPT_OUTPUTS in the engine (not importable in the browser).
const ROLES = ["builder", "reviewer", "meta"] as const;
const OUTPUTS = ["text", "review-result", "negotiation-proposal", "ranking", "synthesis", "subtasks"] as const;
const KNOWN = ["id", "title", "role", "description", "icon", "permissions", "output", "version", "variables", "recommendedModels", "extends"];

interface Draft {
  id: string;
  title: string;
  role: string;
  description: string;
  icon: string;
  permissions: string;
  output: string;
  version: string;
  variables: string;
  recommendedModels: string;
  extends: string;
  body: string;
  /** Front-matter keys the form does not know; kept as they were. */
  extra: Record<string, unknown>;
}

const NEW_DRAFT: Draft = {
  id: "", title: "", role: "builder", description: "", icon: "", permissions: "read-only", output: "text",
  version: "1", variables: "", recommendedModels: "", extends: "", body: "", extra: {},
};

const csv = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : "");
const list = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

function draftOf(d: Detail): Draft {
  const f = d.frontMatter;
  const str = (k: string, fallback = "") => (typeof f[k] === "string" ? (f[k] as string) : fallback);
  return {
    id: d.id, title: d.title, role: d.role, description: str("description"), icon: str("icon"),
    permissions: str("permissions", "read-only"), output: str("output", "text"),
    version: f.version === undefined ? "1" : String(f.version),
    variables: csv(f.variables), recommendedModels: csv(f.recommendedModels), extends: str("extends"),
    body: d.body,
    extra: Object.fromEntries(Object.entries(f).filter(([k]) => !KNOWN.includes(k))),
  };
}

function frontMatterOf(d: Draft): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    ...d.extra, id: d.id.trim(), title: d.title, role: d.role, permissions: d.permissions, output: d.output,
    version: Number(d.version), variables: list(d.variables), recommendedModels: list(d.recommendedModels),
  };
  if (d.description) fm.description = d.description;
  if (d.icon) fm.icon = d.icon;
  if (d.extends.trim()) fm.extends = d.extends.trim();
  return fm;
}

export function PromptsView() {
  const rpc = useRpc();
  const canWrite = useCanWrite();
  const [prompts, setPrompts] = useState<Summary[]>([]);
  const [loadErrors, setLoadErrors] = useState<Array<{ file: string; message: string }>>([]);
  const [listError, setListError] = useState<string>();
  const [loaded, setLoaded] = useState<{ detail?: Detail; draft: Draft; base: Draft }>();
  const [outcome, setOutcome] = useState<{ kind: "ok" | "error"; text: string }>();
  const [scope, setScope] = useState<Scope>("user");
  const [forkId, setForkId] = useState("");
  const dirty = !!loaded && JSON.stringify(loaded.draft) !== JSON.stringify(loaded.base);
  const confirmLeave = useUnsavedGuard(dirty);
  const uid = useId();

  const reload = useCallback(async () => {
    try {
      const r = await rpc.call("prompt.list");
      setPrompts(r.prompts);
      setLoadErrors(r.errors);
      setListError(undefined);
    } catch (e) {
      setListError(errorText(e));
    }
  }, [rpc]);
  useEffect(() => void reload(), [reload]);

  const open = async (id: string) => {
    if (!confirmLeave()) return;
    setOutcome(undefined);
    try {
      const detail = await rpc.call("prompt.get", { id });
      const draft = draftOf(detail);
      setLoaded({ detail, draft, base: draft });
      setForkId("");
    } catch (e) {
      setOutcome({ kind: "error", text: errorText(e) });
    }
  };
  const startNew = () => {
    if (!confirmLeave()) return;
    setOutcome(undefined);
    setLoaded({ draft: NEW_DRAFT, base: NEW_DRAFT });
  };
  const set = (patch: Partial<Draft>) => setLoaded((l) => (l ? { ...l, draft: { ...l.draft, ...patch } } : l));

  const save = async () => {
    if (!loaded) return;
    try {
      const r = await rpc.call("prompt.save", { scope, frontMatter: frontMatterOf(loaded.draft), body: loaded.draft.body });
      setOutcome({ kind: "ok", text: `Saved ${r.id} to the ${r.scope} prompts.` });
      const detail = await rpc.call("prompt.get", { id: r.id });
      const draft = draftOf(detail);
      setLoaded({ detail, draft, base: draft });
      await reload();
    } catch (e) {
      setOutcome({ kind: "error", text: errorText(e) });
    }
  };
  const fork = async () => {
    if (!loaded?.detail) return;
    try {
      const r = await rpc.call("prompt.fork", { id: loaded.detail.id, scope, ...(forkId.trim() ? { newId: forkId.trim() } : {}) });
      setOutcome({ kind: "ok", text: `Forked to ${r.id} in the ${r.scope} prompts.` });
      await reload();
      const detail = await rpc.call("prompt.get", { id: r.id });
      const draft = draftOf(detail);
      setLoaded({ detail, draft, base: draft });
    } catch (e) {
      setOutcome({ kind: "error", text: errorText(e) });
    }
  };

  const noteId = `${uid}-note`;
  const d = loaded?.draft;
  return (
    <section aria-label="Prompts" className="lib">
      <h1 className="session-heading">Prompts</h1>
      <WriteNote id={noteId} />
      {listError ? <p role="alert" className="notice error">{listError}</p> : null}
      <div className="lib-grid">
        <div>
          <button type="button" onClick={startNew} disabled={!canWrite} aria-describedby={canWrite ? undefined : noteId}>
            New prompt
          </button>
          <ul className="lib-list" aria-label="Prompt list">
            {prompts.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={loaded?.detail?.id === p.id ? "lib-item selected" : "lib-item"}
                  aria-current={loaded?.detail?.id === p.id ? "true" : undefined}
                  onClick={() => void open(p.id)}
                >
                  <span className="lib-item-title">{p.title}</span>
                  <span className="lib-item-meta">
                    {p.id} · {p.role} <SourceBadge source={p.source} />
                    {p.overridden ? <span className="badge">overrides</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {prompts.length === 0 && !listError ? <p className="empty">No prompts found.</p> : null}
          {loadErrors.length > 0 ? (
            <ul className="lib-errors" aria-label="Prompt files that failed to load">
              {loadErrors.map((e) => (
                <li key={e.file} className="notice error">{e.file}: {e.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          {outcome ? <Outcome {...outcome} /> : null}
          {!loaded || !d ? (
            <p className="empty">Pick a prompt to read or edit it.</p>
          ) : (
            <Editor
              key={loaded.detail?.id ?? "new"}
              uid={uid}
              isNew={!loaded.detail}
              detail={loaded.detail}
              draft={d}
              dirty={dirty}
              set={set}
              scope={scope}
              setScope={setScope}
              forkId={forkId}
              setForkId={setForkId}
              onSave={() => void save()}
              onFork={() => void fork()}
              onRevert={() => set({ ...loaded.base })}
              noteId={noteId}
            />
          )}
        </div>
      </div>
    </section>
  );
}

interface EditorProps {
  uid: string; isNew: boolean; detail?: Detail; draft: Draft; dirty: boolean; set(p: Partial<Draft>): void;
  scope: Scope; setScope(s: Scope): void; forkId: string; setForkId(s: string): void;
  onSave(): void; onFork(): void; onRevert(): void; noteId: string;
}

function Editor({ uid, isNew, detail, draft, dirty, set, scope, setScope, forkId, setForkId, onSave, onFork, onRevert, noteId }: EditorProps) {
  const rpc = useRpc();
  const canWrite = useCanWrite();
  const fm = useMemo(() => frontMatterOf(draft), [draft]);
  const settled = useDebounced(JSON.stringify({ fm, body: draft.body }));
  const [validation, setValidation] = useState<Validation>();
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview>();
  const [previewError, setPreviewError] = useState<string>();

  useEffect(() => {
    let live = true;
    const { fm: frontMatter, body } = JSON.parse(settled) as { fm: Record<string, unknown>; body: string };
    rpc.call("prompt.validate", { frontMatter, body }).then(
      (v) => live && setValidation(v),
      (e) => live && setValidation({ ok: false, problems: [errorText(e)], variables: [], undeclared: [] }),
    );
    return () => void (live = false);
  }, [rpc, settled]);

  const runPreview = async () => {
    setPreviewError(undefined);
    try {
      const vars = Object.fromEntries(Object.entries(samples).filter(([, v]) => v !== ""));
      setPreview(await rpc.call("prompt.preview", { id: draft.id, variables: vars, body: draft.body }));
    } catch (e) {
      setPreview(undefined);
      setPreviewError(errorText(e));
    }
  };

  const field = (key: keyof Draft, label: string, extra?: { readOnly?: boolean; type?: string; hint?: string }) => (
    <div className="lib-field">
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <input
        id={`${uid}-${key}`}
        type={extra?.type ?? "text"}
        value={draft[key] as string}
        readOnly={extra?.readOnly}
        aria-describedby={extra?.hint ? `${uid}-${key}-hint` : undefined}
        onChange={(e) => set({ [key]: e.target.value })}
      />
      {extra?.hint ? <small id={`${uid}-${key}-hint`}>{extra.hint}</small> : null}
    </div>
  );
  const select = (key: keyof Draft, label: string, options: readonly string[]) => (
    <div className="lib-field">
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      <select id={`${uid}-${key}`} value={draft[key] as string} onChange={(e) => set({ [key]: e.target.value })}>
        {(options.includes(draft[key] as string) ? options : [...options, draft[key] as string]).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
  const why = canWrite ? undefined : noteId;

  return (
    <form className="lib-editor" onSubmit={(e) => e.preventDefault()} aria-label={isNew ? "New prompt" : `Prompt ${draft.id}`}>
      <h2 className="lib-title">
        {draft.title || draft.id || "New prompt"} {detail ? <SourceBadge source={detail.source} /> : null}
        {dirty ? <span className="badge badge-dirty">unsaved changes</span> : null}
      </h2>
      <fieldset className="lib-fields">
        <legend>Front-matter</legend>
        {field("id", "Id", { readOnly: !isNew, hint: "kebab-case; the file is <id>.md" })}
        {field("title", "Title")}
        {select("role", "Role", ROLES)}
        {field("description", "Description")}
        {field("icon", "Icon")}
        {select("permissions", "Permissions", ["read-only", "edit"])}
        {select("output", "Output", OUTPUTS)}
        {field("version", "Version", { type: "number" })}
        {field("variables", "Variables", { hint: "comma separated" })}
        {field("recommendedModels", "Recommended models", { hint: "comma separated" })}
        {field("extends", "Extends (prompt id)")}
      </fieldset>
      <div className="lib-field">
        <label htmlFor={`${uid}-body`}>Body</label>
        <textarea id={`${uid}-body`} className="lib-body" rows={16} spellCheck={false} value={draft.body} onChange={(e) => set({ body: e.target.value })} />
      </div>

      <div className="lib-validation" aria-live="polite">
        {validation ? (
          validation.ok ? (
            <p className="lib-ok">Valid.</p>
          ) : (
            <ul aria-label="Validation problems" className="lib-problems">
              {validation.problems.map((p) => (
                <li key={p} className="notice error">{p}</li>
              ))}
            </ul>
          )
        ) : null}
        {validation && validation.undeclared.length > 0 ? (
          <p className="notice warn">Used in the body but not declared in variables: {validation.undeclared.join(", ")}</p>
        ) : null}
      </div>

      <fieldset className="lib-fields">
        <legend>Preview with sample values</legend>
        {(validation?.variables ?? []).map((v) => (
          <div className="lib-field" key={v}>
            <label htmlFor={`${uid}-var-${v}`}>{v}</label>
            <input id={`${uid}-var-${v}`} type="text" value={samples[v] ?? ""} onChange={(e) => setSamples({ ...samples, [v]: e.target.value })} />
          </div>
        ))}
        <button type="button" onClick={() => void runPreview()} disabled={isNew} aria-describedby={isNew ? `${uid}-prev-why` : undefined}>
          Preview
        </button>
        {isNew ? <small id={`${uid}-prev-why`}> Save the prompt first; the engine renders saved prompts.</small> : null}
        {previewError ? <p role="alert" className="notice error">{previewError}</p> : null}
        {preview ? (
          <div aria-live="polite">
            {preview.ok ? <pre className="lib-preview" aria-label="Rendered prompt">{preview.text}</pre> : <p className="notice error">{preview.message ?? "Could not render."}</p>}
            {preview.missing.length > 0 ? <p className="notice warn">Missing values: {preview.missing.join(", ")}</p> : null}
          </div>
        ) : null}
      </fieldset>

      <div className="lib-actions">
        <div className="lib-field">
          <label htmlFor={`${uid}-scope`}>Save to</label>
          <select id={`${uid}-scope`} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="user">user prompts</option>
            <option value="project">project prompts</option>
          </select>
        </div>
        <button type="button" onClick={onSave} disabled={!canWrite} aria-describedby={why}>Save</button>
        <button type="button" onClick={onRevert} disabled={!dirty}>Revert edits</button>
        {detail ? (
          <>
            <div className="lib-field">
              <label htmlFor={`${uid}-fork`}>Fork as id (optional)</label>
              <input id={`${uid}-fork`} type="text" value={forkId} placeholder={detail.id} onChange={(e) => setForkId(e.target.value)} />
            </div>
            <button type="button" onClick={onFork} disabled={!canWrite} aria-describedby={why}>Fork</button>
            {detail.source !== "builtin" ? (
              <>
                <button type="button" disabled aria-describedby={`${uid}-reset-why`}>Reset to built-in</button>
                <small id={`${uid}-reset-why`}>The engine cannot delete prompt files yet; remove the {detail.source} file to get the built-in back.</small>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </form>
  );
}
