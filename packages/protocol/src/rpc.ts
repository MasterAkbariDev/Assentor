import { z } from "zod";
import { SEAT_PROVIDERS } from "./seats.js";
import { AUTONOMY_LEVELS, type EngineEvent } from "./events.js";

/**
 * Engine JSON-RPC contract (task T04-02p). Browser-safe: zod and types only,
 * shared by the engine server, the CLI/TUI and the web UI client.
 *
 * Transport framing is JSON-RPC 2.0 messages, one per frame (an NDJSON line on
 * stdio, one WebSocket message on `serve`). Batches are not supported.
 *
 * Every method declares `access`. `read` methods never start, change or
 * delete anything; any other method is a write and a connection refuses it
 * (`WriteNotAllowed`) unless its transport grants writes.
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
  /** A write method on a connection whose transport only allows reads (e.g. `serve`). */
  WriteNotAllowed: -32002,
  /** Too many write calls; `serve` limits them. Retry later. */
  RateLimited: -32003,
  /** A valid method the engine has no implementation for yet (e.g. `seat.inject`). */
  NotSupported: -32004,
  /** The engine understood the request and refused it (unknown session, wrong state, git refused). */
  Rejected: -32005,
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

/** Mirrors `PROMPT_ROLES` in src/prompts/format.ts (kept literal so this file stays browser-safe). */
const PromptRoleSchema = z.enum(["builder", "reviewer", "meta"]);

const PromptSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  role: PromptRoleSchema,
  description: z.string().optional(),
  source: z.enum(["builtin", "user", "project"]),
  /** True when this prompt replaces one with the same id from a lower layer. */
  overridden: z.boolean(),
});

const PromptLoadErrorSchema = z.object({
  /** Relative to the layer's prompt directory, with `/` separators. */
  file: z.string(),
  message: z.string(),
});

const TeamSeatSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: z.enum(SEAT_PROVIDERS),
  transport: z.enum(["cli", "api"]),
  model: z.string(),
  role: z.string(),
  permissions: z.enum(["read-only", "edit"]),
});


/** Live state of a session this engine process hosts; absent for sessions it does not run. */
const LiveStateSchema = z.enum(["created", "running", "cancelling"]);
const SessionSummaryLiveSchema = SessionSummarySchema.extend({ live: LiveStateSchema.optional() });
const SeatIdSchema = z.string().min(1).max(100);
const SessionSeatSchema = z.object({ sessionId: SessionIdSchema, seatId: SeatIdSchema });
const OkSchema = z.object({ ok: z.literal(true) });
/** Destructive worktree calls must carry an explicit `confirm: true`. */
const ConfirmSchema = z.literal(true);

export type RpcAccess = "read" | "write";

/** One registry entry: access level, params schema, result schema. */
export interface RpcMethodDef {
  access: RpcAccess;
  params: z.ZodTypeAny;
  result: z.ZodTypeAny;
}

export const RpcMethods = {
  "engine.hello": {
    access: "read",
    params: z.object({ client: z.string().max(100).optional() }).strict().optional(),
    result: z.object({
      engineVersion: z.string(),
      protocolVersion: z.literal(RPC_PROTOCOL_VERSION),
      capabilities: z.array(z.string()),
    }),
  },
  "sessions.list": {
    access: "read",
    params: z.object({}).strict().optional(),
    result: z.object({ sessions: z.array(SessionSummarySchema) }),
  },
  "events.subscribe": {
    access: "read",
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
    access: "read",
    params: z.object({ subscriptionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  // Read-only library methods (src/rpc/library.ts). None of them writes or starts anything.
  "prompt.list": {
    access: "read",
    params: z.object({}).strict().optional(),
    result: z.object({
      prompts: z.array(PromptSummarySchema),
      errors: z.array(PromptLoadErrorSchema),
    }),
  },
  "prompt.get": {
    access: "read",
    params: z.object({ id: z.string().min(1).max(100) }).strict(),
    result: z.object({
      id: z.string(),
      title: z.string(),
      role: PromptRoleSchema,
      source: z.enum(["builtin", "user", "project"]),
      frontMatter: z.record(z.unknown()),
      body: z.string(),
    }),
  },
  "team.list": {
    access: "read",
    params: z.object({}).strict().optional(),
    result: z.object({
      teams: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          source: z.enum(["config", "legacy-review"]),
          seats: z.array(TeamSeatSchema),
        }),
      ),
      /** Team names set in `modes.review` and `modes.negotiate`. */
      modes: z.object({ review: z.string().optional(), negotiate: z.string().optional() }).strict(),
    }),
  },
  "models.catalog": {
    access: "read",
    params: z.object({ provider: z.enum(SEAT_PROVIDERS) }).strict(),
    result: z.object({
      entries: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          source: z.enum(["seed", "discovered", "user"]),
        }),
      ),
    }),
  },
  // Session control (src/rpc/session-control.ts). Every method that starts, stops, answers or
  // deletes something is "write". Methods marked "not supported yet" answer NotSupported.
  "session.create": {
    access: "write",
    params: z
      .object({
        mode: z.string().min(1).max(50),
        goal: z.string().min(1).max(20_000),
        title: z.string().max(200).optional(),
        /** The host may lower this; a session never runs with more autonomy than it is configured for. */
        autonomy: z.enum(AUTONOMY_LEVELS).optional(),
      })
      .strict(),
    result: z.object({ sessionId: z.string(), mode: z.string(), autonomy: z.enum(AUTONOMY_LEVELS) }),
  },
  "session.start": {
    access: "write",
    params: z.object({ sessionId: SessionIdSchema }).strict(),
    result: z.object({ sessionId: z.string(), live: LiveStateSchema }),
  },
  // Not supported yet: no engine pause, and a static session has no prepared resume path.
  "session.pause": { access: "write", params: z.object({ sessionId: SessionIdSchema }).strict(), result: OkSchema },
  "session.resume": { access: "write", params: z.object({ sessionId: SessionIdSchema }).strict(), result: OkSchema },
  "session.cancel": {
    access: "write",
    params: z.object({ sessionId: SessionIdSchema }).strict(),
    result: z.object({ ok: z.literal(true), live: LiveStateSchema }),
  },
  "session.list": {
    access: "read",
    params: z.object({}).strict().optional(),
    result: z.object({ sessions: z.array(SessionSummaryLiveSchema) }),
  },
  "session.get": {
    access: "read",
    params: z.object({ sessionId: SessionIdSchema }).strict(),
    result: z.object({
      session: SessionSummaryLiveSchema,
      /** Pending approval question ids (dynamic modes) or stage ids (static) of a live session. */
      pendingApprovals: z.array(z.string()),
    }),
  },
  "session.approve": {
    access: "write",
    params: z
      .object({
        sessionId: SessionIdSchema,
        /** `questionId` of the `user.question` event (dynamic modes) or the stage id (static modes). */
        id: z.string().min(1).max(200),
        /** Static stage gates can only be approved; to refuse one, cancel the session. */
        decision: z.enum(["approve", "deny"]),
      })
      .strict(),
    result: OkSchema,
  },
  "session.export": {
    access: "read",
    params: z.object({ sessionId: SessionIdSchema, fromSeq: z.number().int().nonnegative().default(0) }).strict(),
    result: z.object({ events: z.array(z.record(z.unknown())), truncated: z.boolean() }),
  },
  // Not supported yet: no registry reaches a live Supervisor/executor from a session id.
  "seat.setModel": {
    access: "write",
    params: SessionSeatSchema.extend({ model: z.string().min(1).max(200), immediate: z.boolean().optional() }).strict(),
    result: OkSchema,
  },
  "seat.inject": {
    access: "write",
    params: SessionSeatSchema.extend({ text: z.string().min(1).max(20_000) }).strict(),
    result: OkSchema,
  },
  "seat.stop": { access: "write", params: SessionSeatSchema.strict(), result: OkSchema },
  "seat.restart": { access: "write", params: SessionSeatSchema.strict(), result: OkSchema },
  // Worktrees are addressed by (sessionId, seatId) and checked against the manager's manifest; never by path.
  "worktree.diff": {
    access: "read",
    params: SessionSeatSchema.strict(),
    result: z.object({
      baseSha: z.string(),
      head: z.string(),
      dirty: z.boolean(),
      files: z.array(z.string()),
      diff: z.string(),
      /** True when `diff` was cut at 512 KiB; `files` is always complete. */
      truncated: z.boolean(),
    }),
  },
  "worktree.apply": {
    access: "write",
    params: SessionSeatSchema.extend({
      confirm: ConfirmSchema,
      strategy: z.enum(["merge", "squash", "patch"]).default("squash"),
      message: z.string().max(500).optional(),
      /** Repo-relative files or directories the seat may change; anything else aborts the apply. */
      allowedPaths: z.array(z.string().min(1).max(500)).max(500).optional(),
    }).strict(),
    result: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        strategy: z.enum(["merge", "squash", "patch"]),
        changed: z.boolean(),
        commit: z.string().optional(),
        warning: z.string().optional(),
      }),
      z.object({
        ok: z.literal(false),
        strategy: z.enum(["merge", "squash", "patch"]),
        conflicts: z.array(z.string()),
        message: z.string(),
      }),
    ]),
  },
  "worktree.discard": {
    access: "write",
    params: SessionSeatSchema.extend({
      confirm: ConfirmSchema,
      /** Also throw away uncommitted changes in the worktree. */
      force: z.boolean().optional(),
    }).strict(),
    result: OkSchema,
  },
} as const satisfies Record<string, RpcMethodDef>;

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
