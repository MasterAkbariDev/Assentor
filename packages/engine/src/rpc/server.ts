import type { z } from "zod";
import {
  RPC_MAX_FRAME_CHARS,
  RpcErrorCode,
  RpcMethods,
  type RpcAccess,
  type RpcErrorObject,
  type RpcId,
  type RpcMethodDef,
  type RpcMethodName,
  type RpcResult,
} from "#assentor/protocol/rpc.js";

/**
 * JSON-RPC 2.0 server core (task T04-02p): a typed method registry and one
 * `RpcConnection` per client. Transports (in-process, stdio, WebSocket) only
 * move text frames; everything protocol-related happens here.
 *
 * - Params are validated with the method's zod schema (→ -32602), results
 *   with its result schema (a mismatch is a bug → -32603).
 * - A handler error becomes -32603 "Internal error" with the message only
 *   (absolute paths replaced by `<path>`), never a stack. Throw `RpcError` for
 *   a specific code. Frames over `RPC_MAX_FRAME_CHARS` are rejected (-32600).
 * - Write access is default-deny: a method whose contract `access` is not
 *   `"read"` is refused (-32002) unless `connect(send, { allowWrite: true })`.
 *   In-process and stdio grant it; the WebSocket `serve` transport does not.
 * - Outbound frames go through one serialized writer per connection; `notify`
 *   resolves when the transport accepted the frame, so a slow client slows
 *   its producers (subscriptions bound their own queues).
 */

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcContext {
  connection: RpcConnection;
}

type MethodDef<M extends RpcMethodName> = (typeof RpcMethods)[M];
type HandlerParams<M extends RpcMethodName> = z.infer<MethodDef<M>["params"]>;

export type RpcHandler<M extends RpcMethodName> = (
  params: HandlerParams<M>,
  context: RpcContext,
) => Promise<RpcResult<M>> | RpcResult<M>;

/** Handlers for any subset of the contract, for `RpcServer.registerAll`. */
export type RpcHandlers = { [M in RpcMethodName]?: RpcHandler<M> };

interface Registered {
  access: RpcAccess;
  params: z.ZodTypeAny;
  result: z.ZodTypeAny;
  handler: (params: unknown, context: RpcContext) => unknown;
}

/** Sends one text frame. A returned promise means "accepted by the transport". */
export type FrameSender = (frame: string) => void | Promise<void>;

export interface ConnectOptions {
  allowWrite?: boolean;
  /**
   * Runs before every write handler (after params are validated). Throw
   * `RpcError` to refuse (rate limit); a rejected promise refuses too (audit failed).
   */
  beforeWrite?: (method: string) => void | Promise<void>;
}

export class RpcServer {
  private readonly methods = new Map<string, Registered>();

  /** `contract` defaults to `RpcMethods`; tests pass an extended one. */
  constructor(private readonly contract: Readonly<Record<string, RpcMethodDef>> = RpcMethods) {}

  /** Register the handler for a contract method (`packages/protocol/src/rpc.ts`). */
  register<M extends RpcMethodName>(method: M, handler: RpcHandler<M>): this {
    const def = this.contract[method];
    if (!def) {
      throw new Error(`RPC method ${method} is not in the contract`);
    }
    this.methods.set(method, {
      access: def.access,
      params: def.params,
      result: def.result,
      handler: handler as (params: unknown, context: RpcContext) => unknown,
    });
    return this;
  }

  /** Register several handlers at once (see `README.md`). */
  registerAll(handlers: RpcHandlers): this {
    for (const [method, handler] of Object.entries(handlers)) {
      this.register(method as RpcMethodName, handler as RpcHandler<RpcMethodName>);
    }
    return this;
  }

  /** Method names with a handler, for `engine.hello` capabilities. */
  get methodNames(): string[] {
    return [...this.methods.keys()].sort();
  }

  /**
   * Open a connection whose outbound frames go to `send`. Write methods are
   * refused unless `allowWrite` is true (only for a transport whose peer is
   * as trusted as this process).
   */
  connect(send: FrameSender, options: ConnectOptions = {}): RpcConnection {
    return new RpcConnection(this.methods, send, options.allowWrite === true, options.beforeWrite);
  }
}

export class RpcConnection {
  private writer: Promise<void> = Promise.resolve();
  private readonly cleanups: Array<() => void> = [];
  private isClosed = false;

  constructor(
    private readonly methods: ReadonlyMap<string, Registered>,
    private readonly send: FrameSender,
    private readonly allowWrite = false,
    private readonly beforeWrite?: (method: string) => void | Promise<void>,
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }

  /** Handle one inbound frame. Never rejects; protocol errors become error responses. */
  async receive(frame: string): Promise<void> {
    if (this.isClosed) {
      return;
    }
    if (frame.length > RPC_MAX_FRAME_CHARS) {
      await this.respondError(null, RpcErrorCode.InvalidRequest, "Invalid request: frame too large");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      await this.respondError(null, RpcErrorCode.ParseError, "Parse error");
      return;
    }

    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = isPlainObject(message) && isRpcId(message.id) ? message.id : null;
      await this.respondError(
        id,
        RpcErrorCode.InvalidRequest,
        Array.isArray(message) ? "Invalid request: batches are not supported" : "Invalid request",
      );
      return;
    }
    const hasId = "id" in message;
    if (hasId && !isRpcId(message.id)) {
      await this.respondError(null, RpcErrorCode.InvalidRequest, "Invalid request: id must be a string or number");
      return;
    }
    const id = hasId ? (message.id as RpcId) : undefined;
    const method = this.methods.get(message.method);

    if (!method) {
      if (id !== undefined) {
        await this.respondError(id, RpcErrorCode.MethodNotFound, `Method not found: ${message.method}`);
      }
      return; // Unknown notifications are ignored, per JSON-RPC.
    }
    // Default-deny: anything not explicitly "read" needs a write-capable transport.
    if (method.access !== "read" && !this.allowWrite) {
      if (id !== undefined) {
        await this.respondError(
          id,
          RpcErrorCode.WriteNotAllowed,
          `Write not allowed: ${message.method} changes state and this connection is read-only`,
        );
      }
      return;
    }

    const parsed = method.params.safeParse(message.params);
    if (!parsed.success) {
      if (id !== undefined) {
        await this.respondError(id, RpcErrorCode.InvalidParams, "Invalid params", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      return;
    }

    let result: unknown;
    try {
      if (method.access !== "read") {
        await this.beforeWrite?.(message.method);
      }
      result = await method.handler(parsed.data, { connection: this });
    } catch (error) {
      if (id !== undefined) {
        if (error instanceof RpcError) {
          await this.respondError(id, error.code, error.message, error.data);
        } else {
          await this.respondError(id, RpcErrorCode.InternalError, "Internal error", {
            message: scrubPaths(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      return;
    }
    if (id === undefined) {
      return;
    }
    const checked = method.result.safeParse(result);
    if (!checked.success) {
      await this.respondError(id, RpcErrorCode.InternalError, "Internal error", {
        message: `Result of ${message.method} does not match its contract`,
      });
      return;
    }
    await this.write({ jsonrpc: "2.0", id, result: checked.data });
  }

  /** Send a notification. Resolves once the transport accepted it; no-op after close. */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  /** Run `fn` when the connection closes (subscriptions use this to stop). */
  onClose(fn: () => void): void {
    if (this.isClosed) {
      fn();
      return;
    }
    this.cleanups.push(fn);
  }

  /** Stop all subscriptions and drop further frames. Safe to call twice. */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // A cleanup failure must not stop the others.
      }
    }
  }

  private respondError(
    id: RpcId | null,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    const error: RpcErrorObject = { code, message, ...(data === undefined ? {} : { data }) };
    return this.write({ jsonrpc: "2.0", id, error });
  }

  private write(message: object): Promise<void> {
    const frame = JSON.stringify(message);
    const next = this.writer.then(async () => {
      if (!this.isClosed) {
        await this.send(frame);
      }
    });
    // A failed send closes the connection; later writes become no-ops.
    this.writer = next.catch(() => this.close());
    return next.catch(() => undefined);
  }
}

/** Hide absolute file paths (they can reach network clients through `serve`). */
function scrubPaths(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"]+/g, "<path>")
    .replace(/(^|[\s'"(])\/[^\s'")]+/g, "$1<path>");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
