import { RpcClient, type RpcClientTransport } from "#assentor/engine/rpc/browser.js";
import type { RpcMethodName, RpcParams, RpcResult } from "#assentor/protocol/rpc.js";
import type { SubscribeHandlers, Transport, TransportStatus } from "./types.js";
import { AuthRejectedError } from "./websocket.js";

export interface WebSocketTransportOptions {
  /** Opens an authenticated link (`connectWebSocket` in the app, in-process in tests). */
  connect: () => Promise<RpcClientTransport>;
  /** Reconnect delays; the last one repeats. */
  backoffMs?: number[];
}

/** `Transport` over an `RpcClientTransport`: connects at once and reconnects with backoff until closed or unauthorized. */
export class WebSocketTransport implements Transport {
  private client?: RpcClient;
  private status: TransportStatus = "connecting";
  private readonly listeners = new Set<(status: TransportStatus) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;

  constructor(private readonly options: WebSocketTransportOptions) {
    void this.connect();
  }

  call<M extends RpcMethodName>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
    return this.client ? this.client.call(method, params) : Promise.reject(new Error("Not connected"));
  }

  async subscribe(sessionId: string, fromSeq: number, handlers: SubscribeHandlers) {
    if (!this.client) {
      throw new Error("Not connected");
    }
    const { unsubscribe } = await this.client.subscribeEvents(sessionId, fromSeq, handlers);
    return { unsubscribe };
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    clearTimeout(this.timer);
    const client = this.client;
    this.client = undefined;
    this.setStatus("closed");
    client?.close();
  }

  private setStatus(status: TransportStatus): void {
    if (this.status === "closed" || status === this.status) {
      return; // closed is final
    }
    this.status = status;
    for (const listener of [...this.listeners]) {
      listener(status);
    }
  }

  private async connect(): Promise<void> {
    let link: RpcClientTransport;
    try {
      link = await this.options.connect();
    } catch (error) {
      if (error instanceof AuthRejectedError) {
        this.setStatus("unauthorized"); // a new token is needed; retrying would only add failures
      } else {
        this.scheduleReconnect();
      }
      return;
    }
    if (this.status === "closed") {
      link.close();
      return;
    }
    const client = new RpcClient(link);
    this.client = client;
    client.onClose(() => {
      if (this.client === client) {
        this.client = undefined;
        this.scheduleReconnect();
      }
    });
    this.attempt = 0;
    this.setStatus("open");
  }

  private scheduleReconnect(): void {
    if (this.status === "closed") {
      return;
    }
    const delays = this.options.backoffMs ?? [250, 1000, 2000, 5000];
    const delay = delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt += 1;
    this.setStatus("reconnecting");
    this.timer = setTimeout(() => void this.connect(), delay);
  }
}
