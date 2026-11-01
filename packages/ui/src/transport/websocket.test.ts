import { describe, expect, it } from "vitest";
import { connectWebSocket, type WebSocketLike } from "./websocket.js";

function fakeSocket(reply: unknown) {
  const sent: string[] = [];
  const socket: WebSocketLike = {
    readyState: 1,
    send: (data) => {
      sent.push(data);
      if (sent.length === 1) queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(reply) }));
    },
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return { socket, sent, open: () => socket.onopen?.({}) };
}

describe("connectWebSocket write opt-in", () => {
  it("always asks for write in the auth frame and records what the server granted", async () => {
    for (const [reply, granted] of [
      [{ auth: "ok", write: true }, true],
      [{ auth: "ok", write: false }, false],
      [{ auth: "ok" }, false],
    ] as const) {
      const f = fakeSocket(reply);
      const link = connectWebSocket("ws://x/rpc", "tok", () => f.socket);
      f.open();
      expect((await link).writeGranted).toBe(granted);
      expect(JSON.parse(f.sent[0]!)).toEqual({ auth: "tok", write: true });
    }
  });
});
