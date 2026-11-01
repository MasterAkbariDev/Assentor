import { useEffect, useState } from "react";
import type { RpcResult } from "#assentor/protocol/rpc.js";
import { useRpc } from "../../transport/context.js";
import { errorText, SourceBadge } from "../prompts/shared.js";

type Summary = RpcResult<"playbook.list">["playbooks"][number];
type Detail = RpcResult<"playbook.get">;

/** Read-only: playbooks are listed and shown, never edited. All text is rendered as text. */
export function PlaybooksView() {
  const rpc = useRpc();
  const [playbooks, setPlaybooks] = useState<Summary[]>([]);
  const [loadErrors, setLoadErrors] = useState<Array<{ file: string; message: string }>>([]);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<Detail>();

  useEffect(() => {
    rpc.call("playbook.list").then(
      (r) => {
        setPlaybooks(r.playbooks);
        setLoadErrors(r.errors);
      },
      (e) => setError(errorText(e)),
    );
  }, [rpc]);

  const open = (id: string) =>
    rpc.call("playbook.get", { id }).then(
      (d) => {
        setDetail(d);
        setError(undefined);
      },
      (e) => setError(errorText(e)),
    );

  return (
    <section aria-label="Playbooks" className="lib">
      <h1 className="session-heading">Playbooks</h1>
      {error ? <p role="alert" className="notice error">{error}</p> : null}
      <div className="lib-grid">
        <div>
          <ul className="lib-list" aria-label="Playbook list">
            {playbooks.map((p) => (
              <li key={p.id}>
                <button type="button" className={detail?.id === p.id ? "lib-item selected" : "lib-item"} aria-current={detail?.id === p.id ? "true" : undefined} onClick={() => void open(p.id)}>
                  <span className="lib-item-title">{p.title}</span>
                  <span className="lib-item-meta">{p.id} <SourceBadge source={p.source} />{p.readOnly ? <span className="badge">read-only</span> : null}</span>
                </button>
              </li>
            ))}
          </ul>
          {playbooks.length === 0 && !error ? <p className="empty">No playbooks found.</p> : null}
          {loadErrors.length > 0 ? (
            <ul className="lib-errors" aria-label="Playbook files that failed to load">
              {loadErrors.map((e) => <li key={e.file} className="notice error">{e.file}: {e.message}</li>)}
            </ul>
          ) : null}
        </div>
        <div>
          {!detail ? <p className="empty">Pick a playbook to see its stages.</p> : (
            <article aria-label={`Playbook ${detail.title}`} className="lib-editor">
              <h2 className="lib-title">{detail.title} <SourceBadge source={detail.source} />{detail.overridden ? <span className="badge">overrides</span> : null}</h2>
              <p>{detail.description}</p>
              <h3 className="review-subheading">Stages</h3>
              <ol className="lib-stages" aria-label="Stages">
                {detail.stages.map((s, i) => (
                  <li key={s.id} className="lib-stage">
                    {i > 0 ? <span className="lib-arrow" aria-hidden="true">↓</span> : null}
                    <div className="lib-stage-card">
                      <strong>{s.id}</strong> <span className="badge">{s.kind}</span>
                      <div className="lib-item-meta">
                        {s.team ? `team ${s.team}` : "no team"}
                        {s.strategy ? ` · strategy ${s.strategy}` : ""}
                        {s.requireApproval ? " · needs approval" : ""}
                        {s.next ? ` · next ${s.next}` : ""}
                        {s.onNeedsWork ? ` · on needs-work ${s.onNeedsWork}` : ""}
                      </div>
                      {Object.keys(s.options).length > 0 ? <pre className="lib-preview">{JSON.stringify(s.options, null, 2)}</pre> : null}
                    </div>
                  </li>
                ))}
              </ol>
              <h3 className="review-subheading">Teams</h3>
              <ul className="lib-teams" aria-label="Teams used">
                {Object.entries(detail.teams).map(([name, t]) => (
                  <li key={name}>
                    <strong>{name}</strong> <span className="lib-item-meta">{t.description}</span>
                    <ul>
                      {t.seats.map((s, i) => (
                        <li key={i}>{s.count} × {s.provider} {s.model} · {s.role} · {s.permissions}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
