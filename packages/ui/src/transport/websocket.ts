import type { RpcClientTransport } from "#assentor/protocol/rpc-client.js";

/**
 * `RpcClientTransport` over the `assentor serve` WebSocket (T04-06p). The first
 * frame is the auth handshake (`{"auth": token, "write": true}` → `{"auth":"ok","write":<granted>}`; the UI always asks, the server decides); only then
 * does the transport resolve and start passing RPC frames.
 */

export class AuthRejectedError extends Error {
  constructor() {
    super("The engine rejected the token. Open the link printed by `assentor serve` again.");
    this.name = "AuthRejectedError";
  }
}

/** WebSocket close code `serve` uses for a missing or wrong token. */
export const CLOSE_UNAUTHORIZED = 4401;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** A link plus whether the engine granted this connection write access. */
export type WriteAwareLink = RpcClientTransport & { writeGranted: boolean };

export function connectWebSocket(
  url: string,
  token: string,
  createSocket: (url: string) => WebSocketLike = (u) => new WebSocket(u) as unknown as WebSocketLike,
): Promise<WriteAwareLink> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(url);
    let messageListener: (frame: string) => void = () => undefined;
    const closeListeners: Array<(reason?: string) => void> = [];
    let ready = false;
    let closed = false;

    const transport: WriteAwareLink = {
      writeGranted: false,
      send(frame) {
        if (!closed) {
          socket.send(frame);
        }
      },
      onMessage(listener) {
        messageListener = listener;
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
      close() {
        socket.close(1000, "client closed");
      },
    };

    socket.onopen = () => socket.send(JSON.stringify({ auth: token, write: true }));
    socket.onmessage = (event) => {
      const frame = typeof event.data === "string" ? event.data : "";
      if (!ready) {
        try {
          const reply = JSON.parse(frame) as { auth?: unknown; write?: unknown };
          if (reply.auth === "ok") {
            ready = true;
            transport.writeGranted = reply.write === true;
            resolve(transport);
          }
        } catch {
          // ignore anything before the handshake completes
        }
        return;
      }
      messageListener(frame);
    };
    socket.onclose = (event) => {
      closed = true;
      if (!ready) {
        reject(event.code === CLOSE_UNAUTHORIZED ? new AuthRejectedError() : new Error(`Connection closed (${event.code})`));
        return;
      }
      for (const listener of closeListeners.splice(0)) {
        listener(event.reason || `code ${event.code}`);
      }
    };
    socket.onerror = () => {
      // The close event follows with the code; nothing else to do here.
    };
  });
}

/** `ws://` URL of the engine on the page's own origin. */
export function engineUrl(loc: Location = window.location): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/rpc`;
}
