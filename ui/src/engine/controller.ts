import { RpcClient, type RpcClientTransport } from "@engine/rpc/browser.js";
import { createFrameBatcher, type EngineStore } from "../store/engineStore.js";
import { AuthRejectedError } from "../transport/websocket.js";

/**
 * Keeps the UI connected to the engine (T04-06p): handshake, session list
 * refresh, one live subscription for the selected session, and reconnect with
 * backoff that resubscribes from the last applied `seq` (no gaps, no repeats).
 */

export interface ControllerOptions {
  store: EngineStore;
  /** Opens an authenticated transport (WebSocket in the app, in-process in tests). */
  connect: () => Promise<RpcClientTransport>;
  /** How often to refresh the session list. Default 3 s. */
  listIntervalMs?: number;
  /** Reconnect delays; the last one repeats. */
  backoffMs?: number[];
  schedule?: (flush: () => void) => void;
}

export class EngineController {
  private client?: RpcClient;
  private unsubscribe?: () => Promise<void>;
  private listTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = false;
  private readonly batcher;
  private readonly offSelect: () => void;

  constructor(private readonly options: ControllerOptions) {
    this.batcher = createFrameBatcher(options.store, options.schedule);
    let selected = options.store.getState().selectedId;
    this.offSelect = options.store.subscribe((state) => {
      if (state.selectedId !== selected) {
        selected = state.selectedId;
        void this.resubscribe();
      }
    });
  }

  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.offSelect();
    clearInterval(this.listTimer);
    clearTimeout(this.reconnectTimer);
    this.client?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const { store } = this.options;
    store.getState().setConnection(this.attempt === 0 ? "connecting" : "reconnecting");
    let transport: RpcClientTransport;
    try {
      transport = await this.options.connect();
    } catch (error) {
      if (error instanceof AuthRejectedError) {
        store.getState().setConnection("unauthorized");
        return; // a new token is needed; retrying would only add failures
      }
      this.scheduleReconnect();
      return;
    }
    const client = new RpcClient(transport);
    this.client = client;
    client.onClose(() => {
      if (this.client === client) {
        this.client = undefined;
        this.unsubscribe = undefined;
        clearInterval(this.listTimer);
        this.scheduleReconnect();
      }
    });
    try {
      const hello = await client.call("engine.hello", { client: "assentor-web" });
      this.attempt = 0;
      store.getState().setConnection("connected", hello.engineVersion);
      await this.refreshSessions();
      this.listTimer = setInterval(() => void this.refreshSessions(), this.options.listIntervalMs ?? 3000);
      await this.resubscribe();
    } catch {
      client.close();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const delays = this.options.backoffMs ?? [250, 1000, 2000, 5000];
    const delay = delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt += 1;
    this.options.store.getState().setConnection("reconnecting");
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async refreshSessions(): Promise<void> {
    try {
      const { sessions } = await this.client!.call("sessions.list");
      this.options.store.getState().setSessions(sessions);
    } catch {
      // A failed refresh is retried on the next tick or after reconnecting.
    }
  }

  /** (Re)subscribe the selected session from its last applied seq. */
  private async resubscribe(): Promise<void> {
    const client = this.client;
    const previous = this.unsubscribe;
    this.unsubscribe = undefined;
    await previous?.().catch(() => undefined);
    const { store } = this.options;
    const session = store.getState().session;
    if (!client || !session || client.isClosed) {
      return;
    }
    const sessionId = session.id;
    this.batcher.flush(); // apply anything pending before reading lastSeq
    const fromSeq = store.getState().session?.lastSeq ?? 0;
    try {
      const sub = await client.subscribeEvents(sessionId, fromSeq, {
        onEvent: (event) => this.batcher.push(sessionId, event),
        onResync: (params) => {
          this.batcher.flush();
          if (params.reason === "unreadable_log") {
            store.getState().failSession(sessionId, "This session's event log can't be read.");
            return;
          }
          const delay = params.reason === "io_error" ? 1000 : 0;
          setTimeout(() => void this.resubscribe(), delay);
        },
      });
      if (store.getState().session?.id !== sessionId) {
        await sub.unsubscribe(); // selection changed while subscribing
        return;
      }
      this.unsubscribe = sub.unsubscribe;
    } catch {
      // The connection dropped; onClose reconnects and resubscribes.
    }
  }
}
