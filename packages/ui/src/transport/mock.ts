import type { EngineEvent } from "#assentor/protocol/events.js";
import type { RpcMethodName, RpcParams, RpcResult, SessionSummary } from "#assentor/protocol/rpc.js";
import type { RpcCallArgs } from "#assentor/protocol/rpc-client.js";
import type { SubscribeHandlers, Transport, TransportStatus } from "./types.js";

export interface MockTransportOptions {
  /** Each session's recorded events, by session id. */
  sessions?: Record<string, EngineEvent[]>;
  engineVersion?: string;
  /** Whether this connection was granted writes (default true). Reads work either way. */
  canWrite?: boolean;
  /** Answers for other methods; an unlisted method rejects. */
  handlers?: { [M in RpcMethodName]?: (params: RpcParams<M> | undefined) => RpcResult<M> | Promise<RpcResult<M>> };
}

export interface MockTransport extends Transport {
  /** Every `call`, in order. */
  readonly calls: Array<{ method: string; params: unknown }>;
  /** Push a live event to the session's subscribers (and record it for later subscribers). */
  emit(event: EngineEvent): void;
  /** Simulate a lost link: subscriptions end, then status goes `reconnecting` → `open`. */
  drop(): void;
}

/** In-memory `Transport` for tests and the dev fixtures page. `open` from the start. */
export function mockTransport(options: MockTransportOptions = {}): MockTransport {
  const sessions = new Map(Object.entries(options.sessions ?? {}).map(([id, events]) => [id, [...events]]));
  const subs = new Set<{ sessionId: string; handlers: SubscribeHandlers; lastSeq: number }>();
  const listeners = new Set<(status: TransportStatus) => void>();
  const calls: MockTransport["calls"] = [];
  let status: TransportStatus = "open";
  const setStatus = (next: TransportStatus) => {
    if (status === "closed" || next === status) return;
    status = next;
    for (const listener of [...listeners]) listener(next);
  };
  const summary = (id: string, events: EngineEvent[]): SessionSummary => ({
    id,
    title: id,
    hasLiveLog: true,
    lastSeq: events.at(-1)?.seq ?? 0,
  });
  const deliver = (sub: { lastSeq: number; handlers: SubscribeHandlers }, event: EngineEvent) => {
    if (event.seq > sub.lastSeq) {
      sub.lastSeq = event.seq;
      sub.handlers.onEvent(event);
    }
  };

  return {
    get canWrite() {
      return status === "open" && options.canWrite !== false;
    },
    calls,
    async call(method, ...args: RpcCallArgs<RpcMethodName>) {
      const params = args[0];
      calls.push({ method, params });
      if (status !== "open") throw new Error("Not connected");
      const handler = options.handlers?.[method] as ((p: unknown) => unknown) | undefined;
      if (handler) return (await handler(params)) as never;
      if (method === "engine.hello") return { engineVersion: options.engineVersion ?? "mock", protocolVersion: 1, capabilities: [] } as never;
      if (method === "sessions.list") return { sessions: [...sessions].map(([id, events]) => summary(id, events)) } as never;
      throw new Error(`mockTransport: no handler for ${method}`);
    },
    async subscribe(sessionId, fromSeq, handlers) {
      if (status !== "open") throw new Error("Not connected");
      const sub = { sessionId, handlers, lastSeq: fromSeq };
      subs.add(sub);
      for (const event of sessions.get(sessionId) ?? []) deliver(sub, event);
      return { unsubscribe: async () => void subs.delete(sub) };
    },
    onStatus(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    close() {
      subs.clear();
      setStatus("closed");
    },
    emit(event) {
      sessions.set(event.sessionId, [...(sessions.get(event.sessionId) ?? []), event]);
      for (const sub of subs) if (sub.sessionId === event.sessionId) deliver(sub, event);
    },
    drop() {
      subs.clear();
      setStatus("reconnecting");
      setTimeout(() => setStatus("open"), 0);
    },
  };
}
