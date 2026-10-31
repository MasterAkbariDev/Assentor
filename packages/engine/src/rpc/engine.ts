import path from "node:path";
import { RPC_PROTOCOL_VERSION, type SessionSummary } from "#assentor/protocol/rpc.js";
import { getLocalVersionSync } from "../self/version.js";
import { registerHandlerMethods } from "./handlers/index.js";
import { registerLibraryMethods } from "./library.js";
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
  /** How long one `sessions.list` result is reused. Default 1 s; 0 disables. */
  listCacheMs?: number;
}

/**
 * The engine's RPC server with every read-only method registered: the
 * handshake, `sessions.list`, `events.subscribe` / `events.unsubscribe`, and
 * the prompt, team and model-catalog reads from `library.ts`, and the
 * prompt / team / playbook / settings / env methods from `handlers/` (the
 * writes among them need a connection with write access).
 */
export function createEngineRpcServer(options: EngineRpcOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  const server = new RpcServer();
  const engineVersion = options.engineVersion ?? getLocalVersionSync();

  // sessions.list reads every task and log; share one result for a second so
  // many clients (or a fast poller) cost one scan.
  let listing: { at: number; promise: Promise<SessionSummary[]> } | undefined;
  const cachedList = (): Promise<SessionSummary[]> => {
    const now = Date.now();
    if (!listing || now - listing.at >= (options.listCacheMs ?? 1_000)) {
      const promise = listSessions(projectPath);
      listing = { at: now, promise };
      promise.catch(() => {
        if (listing?.promise === promise) {
          listing = undefined; // don't cache a failure
        }
      });
    }
    return listing.promise;
  };

  server.registerAll({
    "engine.hello": () => ({
      engineVersion,
      protocolVersion: RPC_PROTOCOL_VERSION,
      capabilities: server.methodNames,
    }),
    "sessions.list": async () => ({ sessions: await cachedList() }),
    "events.subscribe": ({ sessionId, fromSeq }, { connection }) => ({
      subscriptionId: subscribeToSession(connection, projectPath, sessionId, fromSeq, options.subscriptions),
    }),
    "events.unsubscribe": ({ subscriptionId }, { connection }) => ({
      ok: unsubscribeFromSession(connection, subscriptionId),
    }),
  });

  registerLibraryMethods(server, { projectPath });
  registerHandlerMethods(server, { projectPath });
  return server;
}
