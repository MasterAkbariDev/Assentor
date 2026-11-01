import { useCallback, useEffect, useRef, useState } from "react";
import { RpcErrorCode, type RpcMethodName } from "#assentor/protocol/rpc.js";
import { useEngine } from "../../store/context.js";
import { useRpc } from "../../transport/context.js";
import { disabledReason, useCallableMethods } from "../settings/access.js";

type Live = "created" | "running" | "cancelling";

export interface Approval {
  id: string;
  /** The question's text; a static stage gate has none, so the id is shown. */
  text: string;
  /** Only a dynamic question can be denied; a static stage gate can only be approved. */
  canDeny: boolean;
}

/** Plain text for a failed write; NotSupported gets its own message. */
export function errorText(error: unknown): string {
  if ((error as { code?: unknown } | null)?.code === RpcErrorCode.NotSupported) return "Not supported by this engine yet.";
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the write controls need for the selected run: whether this connection may call a method,
 * whether the run is live on this engine, its pending approvals, and the calls themselves.
 * `session.get` is refetched when approval or state events arrive.
 */
export function useSessionControl() {
  const rpc = useRpc();
  const sessionId = useEngine((s) => s.session?.id);
  const tick = useEngine((s) => s.session?.controlTick ?? 0);
  const prompts = useEngine((s) => s.session?.prompts);
  const connection = useEngine((s) => s.connection);
  const methods = useCallableMethods();
  // live: undefined = not known yet, null = not live on this engine.
  const [info, setInfo] = useState<{ live: Live | null | undefined; ids: string[] }>({ live: undefined, ids: [] });
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    if (!sessionId || connection !== "connected") return setInfo({ live: undefined, ids: [] });
    try {
      const r = await rpc.call("session.get", { sessionId });
      if (mine === seq.current) setInfo({ live: r.session.live ?? null, ids: r.pendingApprovals });
    } catch {
      if (mine === seq.current) setInfo({ live: undefined, ids: [] });
    }
  }, [rpc, sessionId, connection]);
  useEffect(() => {
    void refresh();
    return () => void ++seq.current;
  }, [refresh, tick]);

  const approvals: Approval[] = info.ids.map((id) => ({ id, text: prompts?.[id] ?? id, canDeny: prompts?.[id] !== undefined }));

  /** Why `method` can't be used now, or undefined. Everything but cancel needs a running session. */
  const reasonFor = (method: RpcMethodName): string | undefined => {
    const base = disabledReason(methods, method);
    if (base) return base;
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
      void refresh();
    }
  };
  return {
    sessionId,
    approvals,
    reasonFor,
    cancelSession: () => call((id) => rpc.call("session.cancel", { sessionId: id })),
    answerApproval: (approvalId: string, decision: "approve" | "deny") => call((id) => rpc.call("session.approve", { sessionId: id, id: approvalId, decision })),
    stopSeat: (seatId: string) => call((id) => rpc.call("seat.stop", { sessionId: id, seatId })),
    setModel: (seatId: string, model: string) => call((id) => rpc.call("seat.setModel", { sessionId: id, seatId, model })),
  };
}

export type SessionControl = ReturnType<typeof useSessionControl>;
