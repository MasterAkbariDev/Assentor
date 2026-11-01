import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { RpcRemoteError } from "#assentor/protocol/rpc-client.js";
import type { RpcResult } from "#assentor/protocol/rpc.js";
import { SEAT_MAX_COUNT, SEAT_PROVIDERS } from "#assentor/protocol/seats.js";
import { useCanWrite, useRpc } from "../../transport/context.js";
import { errorText, Outcome, useDebounced, useUnsavedGuard, WriteNote } from "../prompts/shared.js";

type TeamList = RpcResult<"team.list">;
type Seats = TeamList["teams"][number]["seats"];

interface Row {
  key: number;
  provider: string;
  transport: "" | "cli" | "api";
  model: string;
  role: string;
  count: number;
  permissions: "read-only" | "edit";
}
interface Draft {
  name: string;
  description: string;
  seats: Row[];
}

const clamp = (n: number) => Math.min(SEAT_MAX_COUNT, Math.max(1, Math.round(n) || 1));
let nextKey = 1;
const blankRow = (): Row => ({ key: nextKey++, provider: "mock", transport: "", model: "AUTO", role: "general", count: 1, permissions: "read-only" });

/**
 * `team.list` returns expanded seats, so equal neighbours are folded back into one row with a count.
 * shortcut: promptRef, seat name and budget are not in the list result, so saving an edited team drops them.
 */
function rowsOf(seats: Seats): Row[] {
  const rows: Row[] = [];
  for (const s of seats) {
    const last = rows.at(-1);
    if (last && last.provider === s.provider && last.transport === s.transport && last.model === s.model && last.role === s.role && last.permissions === s.permissions) {
      last.count = clamp(last.count + 1);
    } else {
      rows.push({ key: nextKey++, provider: s.provider, transport: s.transport, model: s.model, role: s.role, count: 1, permissions: s.permissions });
    }
  }
  return rows;
}

const teamOf = (d: Draft) => ({
  ...(d.description.trim() ? { description: d.description.trim() } : {}),
  seats: d.seats.map((r) => ({
    provider: r.provider, ...(r.transport ? { transport: r.transport } : {}), model: r.model, role: r.role, count: r.count, permissions: r.permissions,
  })),
});

/** `Opus#1…#3`: an approximation of the seat names a run will show. */
const namesOf = (r: Row) => {
  const base = r.model === "AUTO" ? r.provider : r.model;
  return r.count === 1 ? `${base}#1` : `${base}#1…#${r.count}`;
};

export function TeamsView() {
  const rpc = useRpc();
  const canWrite = useCanWrite();
  const uid = useId();
  const [data, setData] = useState<TeamList>();
  const [listError, setListError] = useState<string>();
  const [roles, setRoles] = useState<string[]>([]);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [loaded, setLoaded] = useState<{ draft: Draft; base: Draft; isNew: boolean; source?: string }>();
  const [outcome, setOutcome] = useState<{ kind: "ok" | "error"; text: string; refs?: string[] }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = !!loaded && JSON.stringify(loaded.draft) !== JSON.stringify(loaded.base);
  const confirmLeave = useUnsavedGuard(dirty);

  const reload = useCallback(async () => {
    try {
      setData(await rpc.call("team.list"));
      setListError(undefined);
    } catch (e) {
      setListError(errorText(e));
    }
  }, [rpc]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    rpc.call("prompt.list").then((r) => setRoles(r.prompts.map((p) => p.id)), () => undefined);
  }, [rpc]);

  const providersUsed = useMemo(() => [...new Set(loaded?.draft.seats.map((r) => r.provider))].sort().join(","), [loaded?.draft.seats]);
  useEffect(() => {
    for (const provider of providersUsed.split(",").filter((p) => p && !(p in models))) {
      rpc.call("models.catalog", { provider: provider as (typeof SEAT_PROVIDERS)[number] }).then(
        (r) => setModels((m) => ({ ...m, [provider]: r.entries.map((e) => e.id) })),
        () => setModels((m) => ({ ...m, [provider]: [] })),
      );
    }
  }, [rpc, providersUsed, models]);

  const open = (name: string) => {
    if (!confirmLeave()) return;
    const team = data?.teams.find((t) => t.name === name);
    if (!team) return;
    const draft: Draft = { name, description: team.description ?? "", seats: rowsOf(team.seats) };
    setLoaded({ draft, base: draft, isNew: false, source: team.source });
    setOutcome(undefined);
    setConfirmDelete(false);
  };
  const startNew = () => {
    if (!confirmLeave()) return;
    const draft: Draft = { name: "", description: "", seats: [blankRow()] };
    setLoaded({ draft, base: draft, isNew: true });
    setOutcome(undefined);
    setConfirmDelete(false);
  };
  const edit = (patch: Partial<Draft>) => setLoaded((l) => (l ? { ...l, draft: { ...l.draft, ...patch } } : l));
  const editRow = (key: number, patch: Partial<Row>) => loaded && edit({ seats: loaded.draft.seats.map((r) => (r.key === key ? { ...r, ...patch } : r)) });

  const save = async () => {
    if (!loaded) return;
    try {
      const r = await rpc.call("team.save", { name: loaded.draft.name.trim(), team: teamOf(loaded.draft) });
      setOutcome({ kind: "ok", text: `Saved team ${r.name}.` });
      setLoaded({ ...loaded, base: loaded.draft, isNew: false });
      await reload();
    } catch (e) {
      setOutcome({ kind: "error", text: errorText(e) });
    }
  };
  const remove = async () => {
    if (!loaded) return;
    try {
      const r = await rpc.call("team.delete", { name: loaded.draft.name });
      setOutcome({ kind: "ok", text: `Deleted team ${r.name}.` });
      setLoaded(undefined);
      setConfirmDelete(false);
      await reload();
    } catch (e) {
      const refs = e instanceof RpcRemoteError ? (e.data as { references?: string[] } | undefined)?.references : undefined;
      setOutcome({ kind: "error", text: errorText(e), refs });
      setConfirmDelete(false);
    }
  };

  const noteId = `${uid}-note`;
  const why = canWrite ? undefined : noteId;
  const usedBy = (name: string) => [data?.modes.review === name ? "review mode" : "", data?.modes.negotiate === name ? "negotiate mode" : ""].filter(Boolean);
  return (
    <section aria-label="Teams" className="lib">
      <h1 className="session-heading">Teams</h1>
      <WriteNote id={noteId} />
      {listError ? <p role="alert" className="notice error">{listError}</p> : null}
      <div className="lib-grid">
        <div>
          <button type="button" onClick={startNew} disabled={!canWrite} aria-describedby={why}>New team</button>
          <ul className="lib-list" aria-label="Team list">
            {data?.teams.map((t) => (
              <li key={t.name}>
                <button type="button" className={loaded?.draft.name === t.name && !loaded.isNew ? "lib-item selected" : "lib-item"} onClick={() => open(t.name)}>
                  <span className="lib-item-title">{t.name}</span>
                  <span className="lib-item-meta">
                    {t.seats.length} seats · {t.source}
                    {usedBy(t.name).map((u) => <span key={u} className="badge">{u}</span>)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {data && data.teams.length === 0 ? <p className="empty">No teams yet.</p> : null}
        </div>
        <div>
          {outcome ? (
            <Outcome kind={outcome.kind} text={outcome.text}>
              {outcome.refs?.length ? (
                <ul aria-label="Still used by">{outcome.refs.map((r) => <li key={r}>{r}</li>)}</ul>
              ) : null}
            </Outcome>
          ) : null}
          {!loaded ? <p className="empty">Pick a team to read or edit it.</p> : (
            <TeamEditor
              uid={uid} draft={loaded.draft} isNew={loaded.isNew} source={loaded.source} dirty={dirty} roles={roles} models={models}
              edit={edit} editRow={editRow} noteId={noteId}
              onSave={() => void save()}
              confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} onDelete={() => void remove()}
            />
          )}
        </div>
      </div>
    </section>
  );
}

interface EditorProps {
  uid: string; draft: Draft; isNew: boolean; source?: string; dirty: boolean; roles: string[]; models: Record<string, string[]>;
  edit(p: Partial<Draft>): void; editRow(key: number, p: Partial<Row>): void; noteId: string;
  onSave(): void; confirmDelete: boolean; setConfirmDelete(v: boolean): void; onDelete(): void;
}

function TeamEditor({ uid, draft, isNew, source, dirty, roles, models, edit, editRow, noteId, onSave, confirmDelete, setConfirmDelete, onDelete }: EditorProps) {
  const rpc = useRpc();
  const canWrite = useCanWrite();
  const why = canWrite ? undefined : noteId;
  const settled = useDebounced(JSON.stringify(teamOf(draft)));
  const [problems, setProblems] = useState<{ ok: boolean; problems: string[] }>();
  useEffect(() => {
    let live = true;
    rpc.call("team.validate", { team: JSON.parse(settled) }).then(
      (v) => live && setProblems(v),
      (e) => live && setProblems({ ok: false, problems: [errorText(e)] }),
    );
    return () => void (live = false);
  }, [rpc, settled]);

  const roleOptions = (current: string) => (roles.includes(current) ? roles : [current, ...roles]);
  return (
    <form className="lib-editor" onSubmit={(e) => e.preventDefault()} aria-label={isNew ? "New team" : `Team ${draft.name}`}>
      <h2 className="lib-title">
        {draft.name || "New team"} {source ? <span className="badge">{source}</span> : null}
        {dirty ? <span className="badge badge-dirty">unsaved changes</span> : null}
      </h2>
      <div className="lib-field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} type="text" value={draft.name} readOnly={!isNew} onChange={(e) => edit({ name: e.target.value })} />
        <small>kebab-case, e.g. review-panel</small>
      </div>
      <div className="lib-field">
        <label htmlFor={`${uid}-desc`}>Description</label>
        <input id={`${uid}-desc`} type="text" value={draft.description} onChange={(e) => edit({ description: e.target.value })} />
      </div>
      <div className="lib-table-wrap">
        <table className="lib-table">
          <caption>Seats</caption>
          <thead>
            <tr>
              {["Provider", "Transport", "Model", "Role", "Count", "Permissions", "Names", ""].map((h) => (
                <th key={h || "actions"} scope="col">{h || <span className="sr-only">Actions</span>}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {draft.seats.map((r, i) => {
              const n = i + 1;
              return (
                <tr key={r.key}>
                  <td>
                    <select aria-label={`Provider, seat ${n}`} value={r.provider} onChange={(e) => editRow(r.key, { provider: e.target.value })}>
                      {SEAT_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`Transport, seat ${n}`} value={r.transport} onChange={(e) => editRow(r.key, { transport: e.target.value as Row["transport"] })}>
                      <option value="">default</option>
                      <option value="cli">cli</option>
                      <option value="api">api</option>
                    </select>
                  </td>
                  <td>
                    <input aria-label={`Model, seat ${n}`} list={`${uid}-models-${r.key}`} value={r.model} onChange={(e) => editRow(r.key, { model: e.target.value })} />
                    <datalist id={`${uid}-models-${r.key}`}>{["AUTO", ...(models[r.provider] ?? [])].map((m) => <option key={m} value={m} />)}</datalist>
                  </td>
                  <td>
                    <select aria-label={`Role, seat ${n}`} value={r.role} onChange={(e) => editRow(r.key, { role: e.target.value })}>
                      {roleOptions(r.role).map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td className="lib-count">
                    <button type="button" aria-label={`Fewer, seat ${n}`} disabled={r.count <= 1} onClick={() => editRow(r.key, { count: clamp(r.count - 1) })}>-</button>
                    <input type="number" min={1} max={SEAT_MAX_COUNT} aria-label={`Count, seat ${n}`} value={r.count} onChange={(e) => editRow(r.key, { count: clamp(Number(e.target.value)) })} />
                    <button type="button" aria-label={`More, seat ${n}`} disabled={r.count >= SEAT_MAX_COUNT} onClick={() => editRow(r.key, { count: clamp(r.count + 1) })}>+</button>
                  </td>
                  <td>
                    <select aria-label={`Permissions, seat ${n}`} value={r.permissions} onChange={(e) => editRow(r.key, { permissions: e.target.value as Row["permissions"] })}>
                      <option value="read-only">read-only</option>
                      <option value="edit">edit</option>
                    </select>
                  </td>
                  <td className="lib-names">{namesOf(r)}</td>
                  <td>
                    <button type="button" aria-label={`Remove seat ${n}`} disabled={draft.seats.length <= 1} onClick={() => edit({ seats: draft.seats.filter((x) => x.key !== r.key) })}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => edit({ seats: [...draft.seats, blankRow()] })}>Add seat</button>

      <div className="lib-validation" aria-live="polite">
        {problems?.ok ? <p className="lib-ok">Valid.</p> : null}
        {problems && !problems.ok ? (
          <ul aria-label="Validation problems" className="lib-problems">
            {problems.problems.map((p) => <li key={p} className="notice error">{p}</li>)}
          </ul>
        ) : null}
      </div>

      <div className="lib-actions">
        <button type="button" onClick={onSave} disabled={!canWrite} aria-describedby={why}>Save</button>
        {!isNew ? (
          confirmDelete ? (
            <>
              <button type="button" onClick={onDelete} disabled={!canWrite} aria-describedby={why}>Confirm delete {draft.name}</button>
              <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={!canWrite} aria-describedby={why}>Delete</button>
          )
        ) : null}
      </div>
    </form>
  );
}
