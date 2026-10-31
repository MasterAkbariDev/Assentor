import { z } from "zod";
import { AUTONOMY_LEVELS } from "./events.js";
import { ModelIdSchema, SEAT_PROVIDERS, STAGE_KINDS, TeamSchema } from "./seats.js";
import type { EngineEvent } from "./events.js";

/**
 * Engine JSON-RPC contract (task T04-02p). Browser-safe: zod and types only,
 * shared by the engine server, the CLI/TUI and the web UI client.
 *
 * Transport framing is JSON-RPC 2.0 messages, one per frame (an NDJSON line on
 * stdio, one WebSocket message on `serve`). Batches are not supported.
 *
 * Every method declares `access`. `read` methods never start, change or
 * delete anything; any other method is a write and a connection refuses it
 * (`WriteNotAllowed`) unless its transport grants writes. Write methods:
 * `prompt.save/fork`, `team.save/delete`, `settings.save`, and the ones that
 * start a process (`env.doctor`, `env.detectClis`, `models.discover`).
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

const PromptSourceSchema = z.enum(["builtin", "user", "project"]);
/** Where a client may write: never `builtin`. */
const WritableScopeSchema = z.enum(["user", "project"]);
/** Kebab-case id (prompt ids, team names). Rejects `/`, `.`, `_` and everything else a path needs. */
const KebabIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a kebab-case id");
const ValidationSchema = z.object({ ok: z.boolean(), problems: z.array(z.string()) });

const PlaybookSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  source: PromptSourceSchema,
  overridden: z.boolean(),
});

const KeySummarySchema = z.object({ id: z.string(), provider: z.string(), name: z.string(), healthy: z.boolean() });

/** The non-secret settings `settings.get` returns and `settings.save` can change (each key optional on save). */
/** Mirrors `SELECTABLE_EXECUTOR_PROVIDERS` in the engine (a test keeps them equal; this file stays browser-safe). */
const EXECUTOR_PROVIDERS = ["mock", "cursor", "claude-code", "antigravity", "codex", "qwen", "opencode"] as const;
const SettingsShape = {
  // `model` reaches a CLI as an argument value, so it must pass the same check as a seat model (never a flag).
  executor: z.object({ provider: z.enum(EXECUTOR_PROVIDERS), model: ModelIdSchema.optional() }).strict(),
  run: z.object({ autonomy: z.enum(AUTONOMY_LEVELS) }).strict(),
  routing: z
    .object({
      strategy: z.enum(["FREE_FIRST", "CHEAPEST", "BALANCED", "BEST", "CUSTOM"]),
      reviewStrategy: z.enum(["SINGLE", "ADAPTIVE", "PANEL", "FULL"]),
    })
    .strict(),
  limits: z
    .object({
      maxRounds: z.number().int().positive(),
      maxMessages: z.number().int().positive(),
      maxRuntimeMinutes: z.number().int().positive(),
      maxToolCalls: z.number().int().positive(),
    })
    .strict(),
  git: z.object({ checkpoints: z.boolean(), autoCommit: z.boolean() }).strict(),
  artifacts: z
    .object({ diff: z.boolean(), tests: z.boolean(), logs: z.boolean(), screenshots: z.boolean() })
    .strict(),
};
// What is read back is whatever the config holds (e.g. `project-mutating`, an older free-text model), so it is not narrowed.
const SettingsSchema = z
  .object({ ...SettingsShape, executor: z.object({ provider: z.string(), model: z.string().optional() }).strict() })
  .strict();
const SettingsPatchSchema = z
  .object({
    executor: SettingsShape.executor.partial().strict().optional(),
    run: SettingsShape.run.optional(),
    routing: SettingsShape.routing.partial().strict().optional(),
    limits: SettingsShape.limits.partial().strict().optional(),
    git: SettingsShape.git.partial().strict().optional(),
    artifacts: SettingsShape.artifacts.partial().strict().optional(),
  })
  .strict();

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
  // Writes and process starts (src/rpc/handlers/*). Refused on connections without write access.
  "prompt.save": {
    access: "write",
    params: z
      .object({
        scope: WritableScopeSchema,
        /** Complete front-matter including `id` (kebab-case; the file is `<id>.md` in the scope). */
        frontMatter: z.record(z.unknown()),
        body: z.string().max(256 * 1024),
      })
      .strict(),
    result: z.object({ id: z.string(), scope: WritableScopeSchema }),
  },
  "prompt.fork": {
    access: "write",
    params: z
      .object({
        id: KebabIdSchema,
        scope: WritableScopeSchema,
        /** Default: the same id, which overrides the original in `scope`. */
        newId: KebabIdSchema.optional(),
      })
      .strict(),
    result: z.object({ id: z.string(), scope: WritableScopeSchema }),
  },
  "prompt.preview": {
    access: "read",
    params: z
      .object({
        id: KebabIdSchema,
        variables: z.record(z.unknown()).default({}),
        /** Render this text instead of the saved body (an unsaved edit). */
        body: z.string().max(256 * 1024).optional(),
      })
      .strict(),
    result: z.object({
      ok: z.boolean(),
      text: z.string().optional(),
      /** Variables the template needs that were not given. */
      missing: z.array(z.string()),
      message: z.string().optional(),
    }),
  },
  "prompt.validate": {
    access: "read",
    params: z
      .object({ frontMatter: z.record(z.unknown()), body: z.string().max(256 * 1024) })
      .strict(),
    result: ValidationSchema.extend({
      /** Variables the body reads. */
      variables: z.array(z.string()),
      /** Used in the body but not declared in front-matter `variables`. */
      undeclared: z.array(z.string()),
    }),
  },
  "team.save": {
    access: "write",
    params: z.object({ name: KebabIdSchema, team: TeamSchema }).strict(),
    result: z.object({ name: z.string() }),
  },
  "team.delete": {
    access: "write",
    params: z.object({ name: KebabIdSchema }).strict(),
    result: z.object({ name: z.string() }),
  },
  "team.validate": {
    access: "read",
    params: z.object({ team: z.unknown() }).strict(),
    result: ValidationSchema,
  },
  "playbook.list": {
    access: "read",
    params: z.object({}).strict().optional(),
    result: z.object({
      playbooks: z.array(PlaybookSummarySchema),
      errors: z.array(PromptLoadErrorSchema),
    }),
  },
  "playbook.get": {
    access: "read",
    params: z.object({ id: z.string().min(1).max(100) }).strict(),
    result: PlaybookSummarySchema.extend({
      teams: z.record(
        z.object({
          description: z.string(),
          seats: z.array(
            z.object({
              provider: z.string(),
              model: z.string(),
              role: z.string(),
              count: z.number(),
              permissions: z.enum(["read-only", "edit"]),
            }),
          ),
        }),
      ),
      stages: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(STAGE_KINDS),
          team: z.string().optional(),
          strategy: z.string().optional(),
          options: z.record(z.unknown()),
          requireApproval: z.boolean(),
          next: z.string().optional(),
          onNeedsWork: z.string().optional(),
        }),
      ),
    }),
  },
  "settings.get": {
    access: "read",
    params: z.object({}).strict().optional(),
    result: z.object({
      /** The effective (user + project) values. */
      settings: SettingsSchema,
      /** Secrets never appear: no key value, mask or ciphertext. */
      keys: z.array(KeySummarySchema),
    }),
  },
  "settings.save": {
    access: "write",
    /** Written to the user config (`~/.assentor/config.yaml`); only the given fields change. */
    params: z.object({ settings: SettingsPatchSchema }).strict(),
    result: z.object({ settings: SettingsSchema }),
  },
  "env.doctor": {
    access: "write",
    params: z.object({}).strict().optional(),
    result: z.object({ items: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })) }),
  },
  "env.detectClis": {
    access: "write",
    params: z.object({}).strict().optional(),
    result: z.object({
      clis: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          installed: z.boolean(),
          available: z.boolean(),
          version: z.string().optional(),
          authenticated: z.boolean().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
  },
  "models.discover": {
    access: "write",
    params: z.object({ provider: z.enum(SEAT_PROVIDERS) }).strict(),
    result: z.object({
      entries: z.array(z.object({ id: z.string(), label: z.string(), source: z.enum(["seed", "discovered", "user"]) })),
      error: z.string().optional(),
    }),
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
