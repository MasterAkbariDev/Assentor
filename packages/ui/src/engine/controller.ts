import { createFrameBatcher, type EngineStore } from "../store/engineStore.js";
import type { Transport, TransportStatus } from "../transport/types.js";

/**
 * Keeps the store in step with a `Transport` (T04-06): on every `open` it says
 * hello, refreshes the session list and resubscribes the selected session from
 * its last applied `seq` (no gaps, no repeats). The transport owns reconnecting.
 */

export interface ControllerOptions {
  store: EngineStore;
  transport: Transport;
  /** How often to refresh the session list. Default 3 s. */
  listIntervalMs?: number;
  /** Delays between `engine.hello` retries on an open link; the last one repeats. Default 1 s, 2 s, 5 s. */
  helloRetryMs?: number[];
  schedule?: (flush: () => void) => void;
}

export class EngineController {
  private unsubscribe?: () => Promise<void>;
  private listTimer?: ReturnType<typeof setInterval>;
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private helloAttempt = 0;
  /** Resubscribes run one at a time, so overlapping selects can't leak a subscription. */
  private subscribeChain: Promise<void> = Promise.resolve();
  /** Bumped on every status change, so work started on an old link can tell it is stale. */
  private link = 0;
  private open = false;
  private stopped = false;
  private readonly batcher;
  private readonly offSelect: () => void;
  private offStatus?: () => void;

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

  start(): void {
    this.offStatus = this.options.transport.onStatus((status) => this.onStatus(status));
  }

  stop(): void {
    this.stopped = true;
    this.offSelect();
    this.offStatus?.();
    clearInterval(this.listTimer);
    clearTimeout(this.resyncTimer);
    clearTimeout(this.helloTimer);
    this.options.transport.close();
  }

  private onStatus(status: TransportStatus): void {
    this.link += 1;
    clearTimeout(this.helloTimer);
    this.helloAttempt = 0;
    if (status === "open") {
      this.open = true;
      void this.onOpen(this.link);
      return;
    }
    this.open = false;
    this.unsubscribe = undefined;
    clearInterval(this.listTimer);
    clearTimeout(this.resyncTimer);
    if (status !== "closed") {
      this.options.store.getState().setConnection(status);
    }
  }

  private async onOpen(link: number): Promise<void> {
    const { store, transport } = this.options;
    try {
      const hello = await transport.call("engine.hello", { client: "assentor-web" });
      if (link !== this.link) return;
      store.getState().setConnection("connected", hello.engineVersion);
      await this.refreshSessions();
      if (link !== this.link) return; // dropped during the first refresh; the transport reconnects
      clearInterval(this.listTimer);
      this.listTimer = setInterval(() => void this.refreshSessions(), this.options.listIntervalMs ?? 3000);
      await this.resubscribe();
    } catch {
      // A dropped link reconnects and reports `open` again (which resets this). On a link that
      // stays open, the engine refused or failed hello: try again rather than stay on "Connecting…".
      if (link === this.link && !this.stopped) {
        const delays = this.options.helloRetryMs ?? [1000, 2000, 5000];
        const delay = delays[Math.min(this.helloAttempt, delays.length - 1)]!;
        this.helloAttempt += 1;
        this.helloTimer = setTimeout(() => void this.onOpen(link), delay);
      }
    }
  }

  private async refreshSessions(): Promise<void> {
    try {
      const { sessions } = await this.options.transport.call("sessions.list");
      this.options.store.getState().setSessions(sessions);
    } catch {
      // A failed refresh is retried on the next tick or after reconnecting.
    }
  }

  /** (Re)subscribe the selected session from its last applied seq. Calls are serialized. */
  private resubscribe(): Promise<void> {
    const next = this.subscribeChain.then(() => this.resubscribeNow());
    this.subscribeChain = next.catch(() => undefined);
    return next;
  }

  private async resubscribeNow(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const link = this.link;
    const previous = this.unsubscribe;
    this.unsubscribe = undefined;
    await previous?.().catch(() => undefined);
    const { store, transport } = this.options;
    const session = store.getState().session;
    if (!this.open || !session) {
      return;
    }
    const sessionId = session.id;
    this.batcher.flush(); // apply anything pending before reading lastSeq
    const fromSeq = store.getState().session?.lastSeq ?? 0;
    try {
      const sub = await transport.subscribe(sessionId, fromSeq, {
        onEvent: (event) => this.batcher.push(sessionId, event),
        onResync: (params) => {
          this.batcher.flush();
          if (params.reason === "unreadable_log") {
            store.getState().failSession(sessionId, "This session's event log can't be read.");
            return;
          }
          const delay = params.reason === "io_error" ? 1000 : 0;
          clearTimeout(this.resyncTimer);
          this.resyncTimer = setTimeout(() => void this.resubscribe(), delay);
        },
      });
      if (store.getState().session?.id !== sessionId || this.link !== link || this.stopped) {
        await sub.unsubscribe().catch(() => undefined); // selection or connection changed while subscribing
        return;
      }
      this.unsubscribe = sub.unsubscribe;
    } catch {
      // The link dropped; the transport reconnects and the controller resubscribes on `open`.
    }
  }
}
