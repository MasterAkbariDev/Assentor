import { Channel, invoke } from "@tauri-apps/api/core";
import type { RpcClientTransport } from "#assentor/protocol/rpc-client.js";
import { WebSocketTransport } from "./websocketTransport.js";

type DesktopMessage = { frame: string } | { closed: true };

async function connectDesktop(): Promise<RpcClientTransport & { writeGranted: boolean }> {
  const channel = new Channel<DesktopMessage>();
  let messageListener: ((frame: string) => void) | undefined;
  let closeListener: ((reason?: string) => void) | undefined;
  let closed = false;
  const pending: string[] = [];
  const base = crypto.getRandomValues(new Uint32Array(1))[0]! * 1_000_000;
  function close() {
    if (closed) return;
    closed = true;
    pending.length = 0;
    closeListener?.("desktop engine disconnected");
  }
  channel.onmessage = (message) => {
    if ("closed" in message) {
      close();
      return;
    }
    if (closed) return;
    const reply = JSON.parse(message.frame);
    if (typeof reply.id === "number") {
      if (reply.id <= base || reply.id >= base + 1_000_000) return;
      reply.id -= base;
    }
    const frame = JSON.stringify(reply);
    if (messageListener) messageListener(frame);
    else if (pending.length < 64) pending.push(frame);
    else close();
  };
  const { generation, writeGranted } = await invoke<{ generation: number; writeGranted: boolean }>(
    "engine_connect", { channel },
  );
  if (closed) throw new Error("Desktop engine disconnected during startup");
  return {
    writeGranted,
    send(frame) {
      if (closed) throw new Error("Desktop engine disconnected");
      const request = JSON.parse(frame);
      if (request.id >= 1_000_000) { close(); return; }
      request.id += base;
      void invoke("rpc_call", { generation, frame: JSON.stringify(request) }).catch(close);
    },
    onMessage(listener) {
      messageListener = listener;
      for (const frame of pending.splice(0)) listener(frame);
    },
    onClose(listener) {
      closeListener = listener;
      if (closed) listener("desktop engine disconnected");
    },
    close,
  };
}

export function createTauriTransport() {
  return new WebSocketTransport({ connect: connectDesktop, backoffMs: [1000, 2000, 5000] });
}
