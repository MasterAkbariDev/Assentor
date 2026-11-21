import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RpcClientTransport } from "#assentor/protocol/rpc-client.js";
import type { RpcConnection, RpcServer } from "./server.js";

/**
 * Transports for the engine RPC (task T04-02p). Each moves JSON-RPC text
 * frames between a client and an `RpcConnection`; none of them interpret
 * the messages. Both grant write access; the WebSocket transport for
 * `assentor serve` (src/serve/) does not.
 */

/**
 * In-process transport for the CLI/TUI: a client and a server connection in
 * one process. Frames are still JSON text, so the contract is the same as
 * over a socket. Delivery is asynchronous (next microtask), as on a socket.
 */
export function createInProcessTransport(server: RpcServer): {
  client: RpcClientTransport;
  connection: RpcConnection;
} {
  let toClient: ((frame: string) => void) | undefined;
  const closeListeners: Array<(reason?: string) => void> = [];
  let closed = false;
  // Same process, same trust: write methods are allowed.
  const connection = server.connect(
    (frame) => {
      if (!closed) {
        queueMicrotask(() => toClient?.(frame));
      }
    },
    { allowWrite: true },
  );
  const notifyClosed = (reason: string) => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of closeListeners.splice(0)) {
      listener(reason);
    }
  };
  // The server side can close too (a failed send, a shutdown): tell the client.
  connection.onClose(() => notifyClosed("closed by server"));
  const client: RpcClientTransport = {
    send(frame) {
      if (!closed) {
        queueMicrotask(() => void connection.receive(frame));
      }
    },
    onMessage(listener) {
      toClient = listener;
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close() {
      if (closed) {
        return;
      }
      notifyClosed("closed");
      connection.close();
    },
  };
  return { client, connection };
}

/**
 * Serve one connection over NDJSON on a pair of streams (the Tauri sidecar
 * uses stdin/stdout): one JSON message per line in each direction. Nothing
 * else may be written to `output` — logs go to stderr. Writes respect
 * backpressure (`drain`). Resolves when `input` ends; the connection closes.
 */
export function serveStdio(
  server: RpcServer,
  streams: { input: Readable; output: Writable },
  options: { resetLine?: string } = {},
): Promise<void> {
  const { input, output } = streams;
  const connect = () => server.connect(
    (frame) =>
      new Promise<void>((resolve, reject) => {
        const ok = output.write(`${frame}\n`, (error) => (error ? reject(error) : undefined));
        if (ok) {
          resolve();
        } else {
          output.once("drain", resolve);
        }
      }),
    // The peer is the parent process that spawned us (the Tauri shell): writes allowed.
    { allowWrite: true },
  );
  let connection = connect();
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line === options.resetLine) {
      connection.close();
      connection = connect();
      return;
    }
    if (line.trim().length > 0) {
      void connection.receive(line);
    }
  });
  return new Promise((resolve) => {
    lines.once("close", () => {
      connection.close();
      resolve();
    });
  });
}
