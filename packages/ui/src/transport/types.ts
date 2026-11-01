import type { EngineEvent } from "#assentor/protocol/events.js";
import type { ResyncRequiredParams, RpcMethodName, RpcResult } from "#assentor/protocol/rpc.js";
import type { RpcCallArgs } from "#assentor/protocol/rpc-client.js";

/**
 * The one seam between the UI and the engine (T04-06). The WebSocket transport,
 * the Tauri transport (T05) and `mockTransport` implement it; screens reach it
 * through `useRpc()`. Every implementation must pass `contract.test-suite.ts`.
 */

/** `connecting` → `open`; a lost link goes `reconnecting` → `open`; `unauthorized` and `closed` are final. */
export type TransportStatus = "connecting" | "open" | "reconnecting" | "unauthorized" | "closed";

export interface SubscribeHandlers {
  onEvent(event: EngineEvent): void;
  /** The server stopped this subscription; `params.reason` says whether to resubscribe. */
  onResync?(params: ResyncRequiredParams): void;
}

export interface Transport {
  /** Call a contract method. Rejects when the link is not `open`, or with the engine's error. */
  call<M extends RpcMethodName>(method: M, ...args: RpcCallArgs<M>): Promise<RpcResult<M>>;
  /** Events with `seq > fromSeq`, in order. A dropped link ends the subscription; resubscribe from the last seq on `open`. */
  subscribe(sessionId: string, fromSeq: number, handlers: SubscribeHandlers): Promise<{ unsubscribe(): Promise<void> }>;
  /** Called at once with the current status, then on every change. Returns the remover. */
  onStatus(listener: (status: TransportStatus) => void): () => void;
  /**
   * True while the link is `open` and the engine granted this connection write access
   * (`serve --allow-write` and the auth frame's `write: true`). Reads work either way.
   * Set before the `open` status is announced, so `onStatus` listeners can read it.
   */
  readonly canWrite: boolean;
  /** End the link for good: status `closed`, pending calls reject. */
  close(): void;
}
