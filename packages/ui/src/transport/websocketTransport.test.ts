import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createId } from "#assentor/engine/core/ids.js";
import { EventLog } from "#assentor/engine/events/log.js";
import type { RpcClientTransport } from "#assentor/protocol/rpc-client.js";
import { createEngineRpcServer } from "#assentor/engine/rpc/engine.js";
import { createInProcessTransport } from "#assentor/engine/rpc/transports.js";
import { runTransportContract } from "./contract.test-suite.js";
import { WebSocketTransport } from "./websocketTransport.js";

// The real engine RPC server over the in-process link stands in for `assentor serve`.
runTransportContract("WebSocketTransport", async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "ui-transport-"));
  const sessionId = createId();
  const log = await EventLog.open(projectPath, sessionId);
  const events = [await log.append({ type: "session.created", sessionId, data: { title: "t" } })];
  for (const to of ["EXECUTING", "REVIEWING"]) {
    events.push(await log.append({ type: "session.state", sessionId, data: { to } }));
  }
  const server = createEngineRpcServer({ projectPath, engineVersion: "1.0.0-test", subscriptions: { pollMs: 5 } });
  const links: RpcClientTransport[] = [];
  const transport = new WebSocketTransport({
    backoffMs: [10],
    connect: async () => {
      const { client } = createInProcessTransport(server);
      links.push(client);
      return Object.assign(client, { writeGranted: true }); // in-process links are trusted: writes allowed
    },
  });
  return {
    transport,
    sessionId,
    events,
    emit: () => log.append({ type: "session.state", sessionId, data: { to: "DONE" } }),
    writeGranted: true,
    drop: () => links.at(-1)!.close(),
    dispose: async () => {
      await log.close();
      await fs.rm(projectPath, { recursive: true, force: true });
    },
  };
});
