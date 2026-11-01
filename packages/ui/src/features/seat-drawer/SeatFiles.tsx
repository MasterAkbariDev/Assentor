import { useEffect, useMemo, useState } from "react";
import type { SeatState } from "#assentor/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { useRpc } from "../../transport/context.js";
import { diffHref, touchedFiles, transcriptItems } from "./transcript.js";

type Loaded = { files: string[]; dirty: boolean; truncated: boolean } | { error: string };

/** Files the seat changed in its worktree (`worktree.diff`), or those its tool calls named when it has none. */
export function SeatFiles({ seat }: { seat: SeatState }) {
  const rpc = useRpc();
  const sessionId = useEngine((s) => s.session?.id);
  const events = useEngine((s) => s.session?.seatEvents[seat.seatId]);
  const fromEvents = useMemo(() => touchedFiles(transcriptItems(events ?? [])), [events]);
  const [loaded, setLoaded] = useState<Loaded | undefined>();

  // Refetch when the seat changes state: its worktree moves on with it.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    rpc
      .call("worktree.diff", { sessionId, seatId: seat.seatId })
      .then((r) => alive && setLoaded({ files: r.files, dirty: r.dirty, truncated: r.truncated }))
      .catch((e: unknown) => alive && setLoaded({ error: e instanceof Error ? e.message : String(e) }));
    return () => void (alive = false);
  }, [rpc, sessionId, seat.seatId, seat.status]);

  if (!loaded) {
    return <p className="empty">Loading files…</p>;
  }
  const files = "error" in loaded ? fromEvents : loaded.files;
  return (
    <div className="seat-files">
      {"error" in loaded ? (
        <p className="diff-meta" role="note">
          {/no worktree/i.test(loaded.error) ? "This seat has no worktree." : `Could not read the worktree: ${loaded.error}.`}{" "}
          {files.length > 0 ? "Showing files named in its tool calls." : ""}
        </p>
      ) : (
        <p className="diff-meta">
          {files.length} file{files.length === 1 ? "" : "s"} changed{loaded.dirty ? " · uncommitted changes" : ""}
          {loaded.truncated ? " · diff truncated, list is complete" : ""}
        </p>
      )}
      {files.length === 0 ? (
        <p className="empty">No files.</p>
      ) : (
        <ul className="seat-file-list" aria-label="Files">
          {files.map((f) => (
            <li key={f}>
              <a href={diffHref(seat.seatId, f)}>{f}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
