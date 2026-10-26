import { z } from "zod";
import type { EngineEvent } from "./events.js";

/**
 * Engine JSON-RPC contract (task T04-02p). Browser-safe: zod and types only,
 * shared by the engine server, the CLI/TUI and the web UI client.
 *
 * Transport framing is JSON-RPC 2.0 messages, one per frame (an NDJSON line on
 * stdio, one WebSocket message on `serve`). Batches are not supported.
 *
 * This first cut is read-only: it can describe the engine, list sessions and
 * stream a session's events. Nothing here starts, changes or deletes anything.
 */

export const RPC_PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 error codes, plus engine codes in the -32000…-32099 range. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Too many live subscriptions on one connection. */
  SubscriptionLimit: -32001,
} as const;

/** Largest inbound frame a connection accepts (characters of JSON text). */
export const RPC_MAX_FRAME_CHARS = 1024 * 1024;


export type RpcErrorCodeValue = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId | null; error: RpcErrorObject };

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const SessionIdSchema = z.string().min(1).max(200);

export const SessionSummarySchema = z.object({
  id: z.string(),
  /** The task goal, or the session's `session.created` title. */
  title: z.string(),
  /** Task state (`DONE`, `EXECUTING`, …) when a task record exists. */
  status: z.string().optional(),
  /** True when `.assentor/sessions/<id>/events.ndjson` exists (runs before the event log have none). */
  hasLiveLog: z.boolean(),
  /** Sequence number of the last complete event in the log; 0 without a log. */
  lastSeq: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const RpcMethods = {
  "engine.hello": {
    params: z.object({ client: z.string().max(100).optional() }).strict().optional(),
    result: z.object({
      engineVersion: z.string(),
      protocolVersion: z.literal(RPC_PROTOCOL_VERSION),
      capabilities: z.array(z.string()),
    }),
  },
  "sessions.list": {
    params: z.object({}).strict().optional(),
    result: z.object({ sessions: z.array(SessionSummarySchema) }),
  },
  "events.subscribe": {
    params: z
      .object({
        sessionId: SessionIdSchema,
        /** Deliver events with `seq > fromSeq`. Default 0 (everything). */
        fromSeq: z.number().int().nonnegative().default(0),
      })
      .strict(),
    result: z.object({ subscriptionId: z.string() }),
  },
  "events.unsubscribe": {
    params: z.object({ subscriptionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
} as const;

export type RpcMethodName = keyof typeof RpcMethods;
export type RpcParams<M extends RpcMethodName> = z.input<(typeof RpcMethods)[M]["params"]>;
export type RpcResult<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]["result"]>;

// ---------------------------------------------------------------------------
// Server → client notifications
// ---------------------------------------------------------------------------

export const RPC_NOTIFICATIONS = {
  /** One event for a subscription, in `seq` order. */
  event: "events.event",
  /**
   * The subscription has stopped. For `log_replaced` and `slow_consumer`,
   * resubscribe with `fromSeq: lastSeq` to continue without a gap; see
   * `ResyncRequiredParams.reason`.
   */
  resyncRequired: "events.resync_required",
} as const;

export interface EventNotificationParams {
  subscriptionId: string;
  event: EngineEvent;
}

export interface ResyncRequiredParams {
  subscriptionId: string;
  sessionId: string;
  /** Last `seq` delivered on this subscription (resubscribe from here). */
  lastSeq: number;
  /**
   * `log_replaced`: the file shrank or was swapped. Resubscribe from `lastSeq`.
   * `io_error`: reading failed (e.g. a file held by antivirus or a backup on
   *   Windows). Resubscribe from `lastSeq` after a backoff.
   * `slow_consumer`: the transport shed a lagging client. Resubscribe from `lastSeq`.
   * `unreadable_log`: a line is longer than the server accepts. **Terminal:**
   *   resubscribing would hit the same line; show an error instead.
   */
  reason: "slow_consumer" | "log_replaced" | "io_error" | "unreadable_log";
}
