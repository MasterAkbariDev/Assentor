import { useEffect } from "react";
import { RpcErrorCode, type RpcMethodName } from "#assentor/protocol/rpc.js";
import { useEngine, useEngineStore } from "../../store/context.js";
import type { EngineStore } from "../../store/engineStore.js";
import { useCanWrite, useRpc } from "../../transport/context.js";
import type { Transport } from "../../transport/types.js";

export interface Approval {
  id: string;
  /** The question's text; a static stage gate has none, so the id is shown. */
  text: string;
  /** Only a dynamic question can be denied; a static stage gate can only be approved. */
  canDeny: boolean;
}

/** Why a write control is off on a connection that was not granted writes. */
export const READ_ONLY_REASON = "This connection is read-only. Start `assentor serve --allow-write` and reopen the link to change a run.";

/** Plain text for a failed write; NotSupported gets its own message. */
export function errorText(error: unknown): string {
  if ((error as { code?: unknown } | null)?.code === RpcErrorCode.NotSupported) return "Not supported by this engine yet.";
  return error instanceof Error ? error.message : String(error);
}

// One `session.get` per store and key (session, event tick, connection), however many controls ask.
const requested = new WeakMap<EngineStore, string>();
let forced = 0;

/** Fetch `session.get` into the store's `control` slice. Skipped when this key was already requested, unless `force`. */
function loadControl(store: EngineStore, rpc: Transport, force: boolean): void {
  const { session, connection } = store.getState();
  if (!session || connection !== "connected") {
    requested.delete(store);
    return;
  }
  const sessionId = session.id;
  const key = `${sessionId}:${session.controlTick}${force ? `:${++forced}` : ""}`;
  if (!force && requested.get(store) === key) return;
  requested.set(store, key);
  const settle = (live: "created" | "running" | "cancelling" | null | undefined, ids: string[]) => {
    if (requested.get(store) === key) store.setState({ control: { sessionId, live, ids } });
  };
  rpc.call("session.get", { sessionId }).then(
    (r) => settle(r.session.live ?? null, r.pendingApprovals),
    () => settle(undefined, []),
  );
}

/**
 * What the write controls need for the selected run: whether this connection may write
 * (`useCanWrite`), whether the run is live on this engine, its pending approvals, and the calls.
 * `session.get` runs once per approval/state event, shared by every control on screen.
 */
export function useSessionControl() {
  const rpc = useRpc();
  const store = useEngineStore();
  const canWrite = useCanWrite();
  const sessionId = useEngine((s) => s.session?.id);
  const tick = useEngine((s) => s.session?.controlTick ?? 0);
  const prompts = useEngine((s) => s.session?.prompts);
  const connection = useEngine((s) => s.connection);
  const paused = useEngine((s) => s.session?.paused ?? false);
  const leadPaused = useEngine((s) => s.session?.lead.paused ?? false);
  const shared = useEngine((s) => s.control);
  useEffect(() => loadControl(store, rpc, false), [store, rpc, sessionId, tick, connection]);

  const info = shared && shared.sessionId === sessionId ? shared : { live: undefined, ids: [] as string[] };
  const approvals: Approval[] = info.ids.map((id) => ({ id, text: prompts?.[id] ?? id, canDeny: prompts?.[id] !== undefined }));

  /** Why `method` can't be used now, or undefined. Everything but cancel needs a running session. */
  const reasonFor = (method: RpcMethodName): string | undefined => {
    if (!canWrite) return READ_ONLY_REASON;
    if (!sessionId) return "No session selected.";
    if (info.live === undefined) return "Checking whether the session is still running…";
    if (info.live === null) return "The session is not running on this engine.";
    if (info.live === "cancelling") return "The session is being cancelled.";
    if (info.live === "created" && method !== "session.cancel") return "The session has not started yet.";
    return undefined;
  };

  const call = async <T,>(fn: (id: string) => Promise<T>): Promise<T> => {
    if (!sessionId) throw new Error("No session selected.");
    try {
      return await fn(sessionId);
    } finally {
      loadControl(store, rpc, true);
    }
  };
  return {
    sessionId,
    /** The whole session is paused (`session.pause`). Separate from `leadPaused`. */
    paused,
    /** Only the Lead controller is paused (`lead.pause`). */
    leadPaused,
    approvals,
    reasonFor,
    cancelSession: () => call((id) => rpc.call("session.cancel", { sessionId: id })),
    answerApproval: (approvalId: string, decision: "approve" | "deny") => call((id) => rpc.call("session.approve", { sessionId: id, id: approvalId, decision })),
    stopSeat: (seatId: string) => call((id) => rpc.call("seat.stop", { sessionId: id, seatId, confirm: true })),
    setModel: (seatId: string, model: string) => call((id) => rpc.call("seat.setModel", { sessionId: id, seatId, model })),
    pause: () => call((id) => rpc.call("session.pause", { sessionId: id })),
    resume: () => call((id) => rpc.call("session.resume", { sessionId: id })),
    inject: (seatId: string, text: string) => call((id) => rpc.call("seat.inject", { sessionId: id, seatId, text })),
    restartSeat: (seatId: string) => call((id) => rpc.call("seat.restart", { sessionId: id, seatId, confirm: true })),
    leadOverride: (taskId: string, seatId: string) => call((id) => rpc.call("lead.override", { sessionId: id, taskId, seatId })),
    leadPin: (taskId: string, model: string | null) => call((id) => rpc.call("lead.pin", { sessionId: id, taskId, model })),
    leadPause: () => call((id) => rpc.call("lead.pause", { sessionId: id })),
    leadResume: () => call((id) => rpc.call("lead.resume", { sessionId: id })),
  };
}

export type SessionControl = ReturnType<typeof useSessionControl>;
