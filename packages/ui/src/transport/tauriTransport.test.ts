import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createId } from "#assentor/engine/core/ids.js";
import { EventLog } from "#assentor/engine/events/log.js";
import { createEngineRpcServer } from "#assentor/engine/rpc/engine.js";
import { createInProcessTransport } from "#assentor/engine/rpc/transports.js";
import type { RpcClientTransport } from "#assentor/protocol/rpc-client.js";
import { runTransportContract } from "./contract.test-suite.js";
import { createTauriTransport } from "./tauriTransport.js";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  Channel: class {},
}));

runTransportContract("TauriTransport", async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "tauri-transport-"));
  const sessionId = createId();
  const log = await EventLog.open(projectPath, sessionId);
  const events = [await log.append({ type: "session.created", sessionId, data: { title: "Desktop" } })];
  for (const to of ["EXECUTING", "REVIEWING"]) {
    events.push(await log.append({ type: "session.state", sessionId, data: { to } }));
  }
  const server = createEngineRpcServer({ projectPath, engineVersion: "1.0.0-test", subscriptions: { pollMs: 5 } });
  let link: RpcClientTransport | undefined;
  let generation = 0;
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "engine_connect") {
      link = createInProcessTransport(server).client;
      link.onMessage((frame) => args.channel.onmessage({ frame }));
      link.onClose(() => args.channel.onmessage({ closed: true }));
      return { generation: ++generation, writeGranted: true };
    }
    if (command === "rpc_call" && args.generation === generation) {
      link?.send(args.frame);
      return;
    }
    throw new Error("Invalid mocked IPC request");
  });
  return {
    transport: createTauriTransport(),
    sessionId,
    events,
    emit: () => log.append({ type: "session.state", sessionId, data: { to: "DONE" } }),
    writeGranted: true,
    drop: () => link?.close(),
    async dispose() {
      link?.close();
      await log.close();
      await fs.rm(projectPath, { recursive: true, force: true });
    },
  };
});
