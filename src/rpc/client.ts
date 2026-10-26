import {
  RPC_NOTIFICATIONS,
  type EventNotificationParams,
  type ResyncRequiredParams,
  type RpcErrorObject,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
} from "../protocol/rpc.js";
import type { EngineEvent } from "../protocol/events.js";

/**
 * Typed JSON-RPC client for the engine (task T04-02p). Browser-safe: no Node
 * imports, so the web UI (T04-06p) uses it over a WebSocket transport.
 */

/** Moves text frames; implemented by the in-process, stdio and WebSocket transports. */
export interface RpcClientTransport {
  send(frame: string): void;
  onMessage(listener: (frame: string) => void): void;
  /** Called once when the connection ends, from either side. */
  onClose(listener: (reason?: string) => void): void;
  close(): void;
}

export class RpcRemoteError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(error: RpcErrorObject) {
    super(error.message);
    this.name = "RpcRemoteError";
    this.code = error.code;
    this.data = error.data;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface EventSubscriptionHandlers {
  onEvent: (event: EngineEvent) => void;
  /** The server stopped the subscription; see `params.reason` for whether to resubscribe. */
  onResync?: (params: ResyncRequiredParams) => void;
  /** The connection ended; reconnect and resubscribe from `lastSeq`. */
  onDisconnect?: (info: { lastSeq: number; reason?: string }) => void;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly closeListeners = new Set<(reason?: string) => void>();
  private closed = false;

  constructor(private readonly transport: RpcClientTransport) {
    transport.onMessage((frame) => this.receive(frame));
    transport.onClose((reason) => this.handleClosed(reason));
  }

  /** True once the transport has closed; calls then reject at once. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Listen for the connection ending. Returns a function that removes the listener. */
  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Call a contract method. Rejects with `RpcRemoteError` for an error response. */
  call<M extends RpcMethodName>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.closed) {
      return Promise.reject(new Error("RPC client is closed"));
    }
    const id = this.nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.transport.send(
          JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
        );
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Listen for a server notification. Returns a function that removes the listener. */
  onNotification(method: string, listener: (params: unknown) => void): () => void {
    let set = this.notificationListeners.get(method);
    if (!set) {
      set = new Set();
      this.notificationListeners.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  /**
   * Subscribe to a session's events with `seq > fromSeq`. Handlers only see
   * this subscription's notifications.
   */
  async subscribeEvents(
    sessionId: string,
    fromSeq: number,
    handlers: EventSubscriptionHandlers,
  ): Promise<{ subscriptionId: string; unsubscribe: () => Promise<void> }> {
    let subscriptionId: string | undefined;
    let lastSeq = fromSeq;
    let ended = false;
    // Notifications can arrive before the subscribe call resolves; keep them in order.
    const early: Array<{ kind: "event"; params: EventNotificationParams } | { kind: "resync"; params: ResyncRequiredParams }> = [];
    const deliverEvent = (params: EventNotificationParams) => {
      if (!ended && params.subscriptionId === subscriptionId) {
        lastSeq = params.event.seq;
        handlers.onEvent(params.event);
      }
    };
    const deliverResync = (params: ResyncRequiredParams) => {
      if (!ended && params.subscriptionId === subscriptionId) {
        cleanup();
        handlers.onResync?.(params);
      }
    };
    const offEvent = this.onNotification(RPC_NOTIFICATIONS.event, (raw) => {
      const params = raw as EventNotificationParams;
      if (subscriptionId === undefined) {
        early.push({ kind: "event", params });
      } else {
        deliverEvent(params);
      }
    });
    const offResync = this.onNotification(RPC_NOTIFICATIONS.resyncRequired, (raw) => {
      const params = raw as ResyncRequiredParams;
      if (subscriptionId === undefined) {
        early.push({ kind: "resync", params });
      } else {
        deliverResync(params);
      }
    });
    const offClose = this.onClose((reason) => {
      if (!ended) {
        cleanup();
        handlers.onDisconnect?.({ lastSeq, ...(reason ? { reason } : {}) });
      }
    });
    const cleanup = () => {
      ended = true;
      offEvent();
      offResync();
      offClose();
    };
    try {
      ({ subscriptionId } = await this.call("events.subscribe", { sessionId, fromSeq }));
    } catch (error) {
      cleanup();
      throw error;
    }
    for (const item of early.splice(0)) {
      if (item.kind === "event") {
        deliverEvent(item.params);
      } else {
        deliverResync(item.params);
      }
    }
    const id = subscriptionId;
    return {
      subscriptionId: id,
      unsubscribe: async () => {
        if (ended) {
          return;
        }
        cleanup();
        await this.call("events.unsubscribe", { subscriptionId: id });
      },
    };
  }

  /** Close the transport; pending calls reject and subscriptions get `onDisconnect`. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.transport.close();
    this.handleClosed("closed by client");
  }

  private handleClosed(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`RPC connection closed${reason ? `: ${reason}` : ""}`));
    }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) {
      listener(reason);
    }
    this.closeListeners.clear();
  }

  private receive(frame: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      return; // A server never sends invalid JSON; ignore rather than throw.
    }
    if (typeof message.method === "string" && !("id" in message)) {
      for (const listener of [...(this.notificationListeners.get(message.method) ?? [])]) {
        try {
          listener(message.params);
        } catch {
          // One failing handler must not stop the others or break the transport.
        }
      }
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new RpcRemoteError(message.error as RpcErrorObject));
    } else {
      pending.resolve(message.result);
    }
  }
}
