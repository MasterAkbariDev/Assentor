import { useCallback, useEffect, useState } from "react";
import type { RpcResult } from "#assentor/protocol/rpc.js";
import { useEngine } from "../../store/context.js";
import { selectSeats } from "../../store/selectors.js";
import { useRpc } from "../../transport/context.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { parseUnifiedDiff } from "./diffModel.js";

type Diff = RpcResult<"worktree.diff">;
type Strategy = "merge" | "squash" | "patch";
const STRATEGIES: Strategy[] = ["squash", "merge", "patch"];
/** Files named in a confirm dialog; the rest are counted. */
const LISTED_FILES = 50;
const WRITE_REASON = "This connection is read-only. Run `assentor serve --allow-write` and turn on write access in the UI to apply or discard.";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Collapsed section of the session panel: per-seat worktrees, their diff, apply and discard. */
export function DiffView() {
  const [open, setOpen] = useState(false);
  return (
    <section className="diff-view" aria-label="Diff and worktrees">
      <h2 className="diff-heading">
        <button type="button" className="diff-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          Diff &amp; worktrees
        </button>
      </h2>
      {open ? <DiffBody /> : null}
    </section>
  );
}

function DiffBody() {
  const rpc = useRpc();
  const connection = useEngine((s) => s.connection);
  const sessionId = useEngine((s) => s.session?.id);
  const state = useEngine((s) => s.session?.state);
  const seats = useEngine(selectSeats);
  const [canWrite, setCanWrite] = useState(false);
  const [live, setLive] = useState<string | undefined>();
  const [seatId, setSeatId] = useState<string | undefined>();
  const [diff, setDiff] = useState<Diff | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<string | undefined>();
  const [dialog, setDialog] = useState<"apply" | "discard" | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  // Write access is whatever the connection's hello says it may call.
  useEffect(() => {
    let alive = true;
    rpc
      .call("engine.hello", { client: "assentor-web" })
      .then((h) => alive && setCanWrite(h.capabilities.includes("worktree.apply") && h.capabilities.includes("worktree.discard")))
      .catch(() => alive && setCanWrite(false));
    return () => void (alive = false);
  }, [rpc, connection]);

  // The engine refuses changes while the session is live; show it up front.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    rpc
      .call("session.get", { sessionId })
      .then((r) => alive && setLive(r.session.live))
      .catch(() => alive && setLive(undefined));
    return () => void (alive = false);
  }, [rpc, sessionId, state, connection]);

  const load = useCallback(
    async (id: string) => {
      if (!sessionId) return;
      setSeatId(id);
      setFile(undefined);
      setNotice(undefined);
      setError(undefined);
      setLoading(true);
      try {
        setDiff(await rpc.call("worktree.diff", { sessionId, seatId: id }));
      } catch (e) {
        setDiff(undefined);
        setError(errText(e));
      } finally {
        setLoading(false);
      }
    },
    [rpc, sessionId],
  );

  const blocked = !canWrite ? WRITE_REASON : live ? `The session is ${live}; apply and discard wait until it finishes.` : undefined;
  const entries = Object.values(seats ?? {});

  return (
    <div className="diff-body">
      <h3 className="diff-sub">Worktrees</h3>
      {entries.length === 0 ? <p className="empty">No seats yet.</p> : null}
      <ul className="diff-seats">
        {entries.map((s) => (
          <li key={s.seatId}>
            <span className="diff-seat-name">{s.displayName}</span>
            <span className="diff-meta">{s.status}</span>
            <button type="button" aria-pressed={seatId === s.seatId} onClick={() => void load(s.seatId)}>
              View diff
            </button>
          </li>
        ))}
      </ul>
      {loading ? <p className="empty">Loading diff…</p> : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {diff && seatId ? (
        <>
          <p className="diff-meta">
            {diff.files.length} file{diff.files.length === 1 ? "" : "s"} · base {diff.baseSha.slice(0, 8)} · head {diff.head.slice(0, 8)}
            {diff.dirty ? " · uncommitted changes" : ""}
          </p>
          <div className="diff-actions">
            <button type="button" disabled={Boolean(blocked)} onClick={() => setDialog("apply")}>
              Apply…
            </button>
            <button type="button" disabled={Boolean(blocked)} onClick={() => setDialog("discard")}>
              Discard…
            </button>
          </div>
          {blocked ? <p className="diff-meta" role="note">{blocked}</p> : null}
          <DiffViewer diff={diff} file={file} onFile={setFile} />
        </>
      ) : null}
      {dialog && diff && seatId && sessionId ? (
        <ActionDialog
          kind={dialog}
          diff={diff}
          onClose={() => setDialog(undefined)}
          run={async ({ strategy, force }) => {
            if (dialog === "discard") {
              await rpc.call("worktree.discard", { sessionId, seatId, confirm: true, ...(force ? { force } : {}) });
              setDiff(undefined);
              setSeatId(undefined);
              setNotice("Worktree discarded.");
              return;
            }
            const r = await rpc.call("worktree.apply", { sessionId, seatId, confirm: true, strategy });
            if ("conflicts" in r) {
              setNotice(`Apply (${r.strategy}) stopped on conflicts: ${r.conflicts.join(", ")}. ${r.message}`);
            } else {
              await load(seatId);
              setNotice(`Applied (${r.strategy})${r.commit ? ` as ${r.commit.slice(0, 8)}` : ""}${r.changed ? "" : ": nothing to change"}.${r.warning ? ` ${r.warning}` : ""}`);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ActionDialog(props: {
  kind: "apply" | "discard";
  diff: Diff;
  onClose: () => void;
  run: (params: { strategy: Strategy; force: boolean }) => Promise<void>;
}) {
  const { kind, diff, onClose, run } = props;
  const [strategy, setStrategy] = useState<Strategy>("squash");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const shown = diff.files.slice(0, LISTED_FILES);
  const apply = kind === "apply";
  return (
    <ConfirmDialog
      title={apply ? "Apply this worktree to main?" : "Discard this worktree?"}
      confirmLabel={apply ? "Apply" : "Discard"}
      busy={busy}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        setError(undefined);
        try {
          await run({ strategy, force });
          onClose();
        } catch (e) {
          setError(errText(e));
          setBusy(false);
        }
      }}
    >
      <p>
        {apply ? "These changes will be applied to the main branch of the repository." : "The worktree and its branch will be deleted. This cannot be undone."}
      </p>
      <p className="diff-meta">{diff.files.length} file{diff.files.length === 1 ? "" : "s"}:</p>
      <ul className="diff-dialog-files">
        {shown.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
        {diff.files.length > shown.length ? <li>…and {diff.files.length - shown.length} more</li> : null}
      </ul>
      {apply ? (
        <label className="diff-field">
          Strategy{" "}
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)}>
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="diff-field">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Also discard uncommitted changes
          {diff.dirty ? " (this worktree has some)" : ""}
        </label>
      )}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </ConfirmDialog>
  );
}

function DiffViewer({ diff, file, onFile }: { diff: Diff; file: string | undefined; onFile: (f: string | undefined) => void }) {
  const parsed = parseUnifiedDiff(diff.diff);
  const byPath = new Map(parsed.map((f) => [f.path, f]));
  const visible = diff.files.filter((f) => !file || f === file);
  return (
    <div className="diff-viewer">
      {diff.truncated ? (
        <p className="notice warn" role="status">
          This diff was cut at 512 KiB. The file list is complete; later files have no text here.
        </p>
      ) : null}
      <ul className="diff-files" aria-label="Changed files">
        <li>
          <button type="button" aria-pressed={!file} onClick={() => onFile(undefined)}>
            All files
          </button>
        </li>
        {diff.files.map((f) => (
          <li key={f}>
            <button type="button" aria-pressed={file === f} onClick={() => onFile(f)}>
              {f}
            </button>
          </li>
        ))}
      </ul>
      {visible.map((path) => {
        const f = byPath.get(path);
        return (
          <div className="diff-file" key={path}>
            <h4 className="diff-file-name">{path}</h4>
            {!f ? <p className="diff-meta">No diff text{diff.truncated ? " (cut off)" : ""}.</p> : null}
            {f?.hunks.length === 0 ? <pre className="diff-lines">{f.meta.join("\n")}</pre> : null}
            {f?.hunks.map((h, i) => (
              <details className="diff-hunk" open key={i}>
                <summary>{h.header}</summary>
                <pre className="diff-lines">
                  {h.lines.map((l, j) => (
                    <span key={j} className={`diff-line diff-l-${l.kind}`}>
                      {l.text}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              </details>
            ))}
          </div>
        );
      })}
    </div>
  );
}
