import path from "node:path";
import { RPC_PROTOCOL_VERSION } from "../protocol/rpc.js";
import { getLocalVersionSync } from "../self/version.js";
import { RpcServer } from "./server.js";
import {
  listSessions,
  subscribeToSession,
  unsubscribeFromSession,
  type SubscriptionOptions,
} from "./sessions.js";

export interface EngineRpcOptions {
  /** Project whose `.assentor/` the engine reads. */
  projectPath: string;
  /** Overrides for event tailing (tests use a short poll). */
  subscriptions?: SubscriptionOptions;
  /** Defaults to the installed package version. */
  engineVersion?: string;
}

/**
 * The engine's RPC server with every read-only method registered: the
 * handshake, `sessions.list` and `events.subscribe` / `events.unsubscribe`.
 */
export function createEngineRpcServer(options: EngineRpcOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  const server = new RpcServer();
  const engineVersion = options.engineVersion ?? getLocalVersionSync();

  server
    .register("engine.hello", () => ({
      engineVersion,
      protocolVersion: RPC_PROTOCOL_VERSION,
      capabilities: server.methodNames,
    }))
    .register("sessions.list", async () => ({ sessions: await listSessions(projectPath) }))
    .register("events.subscribe", ({ sessionId, fromSeq }, { connection }) => ({
      subscriptionId: subscribeToSession(
        connection,
        projectPath,
        sessionId,
        fromSeq,
        options.subscriptions,
      ),
    }))
    .register("events.unsubscribe", ({ subscriptionId }, { connection }) => ({
      ok: unsubscribeFromSession(connection, subscriptionId),
    }));

  return server;
}
