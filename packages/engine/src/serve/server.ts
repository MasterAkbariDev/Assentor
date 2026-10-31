import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { resolvePackageRoot } from "../self/package-root.js";
import { WebSocketServer, type WebSocket } from "ws";
import { RPC_MAX_FRAME_CHARS } from "#assentor/protocol/rpc.js";
import { createEngineRpcServer } from "../rpc/engine.js";
import type { RpcConnection, RpcServer } from "../rpc/server.js";
import type { SubscriptionOptions } from "../rpc/sessions.js";

/**
 * `assentor serve` (task T04-03p): the engine RPC over a WebSocket, plus the
 * web UI's static files, for one local user. Watch-only: only the read-only
 * methods of `createEngineRpcServer` are reachable.
 *
 * Security (Danger list #5):
 * - Binds 127.0.0.1 by default; any non-loopback address needs `unsafeListen`.
 * - Every HTTP request and WebSocket upgrade must carry an allowed `Host`
 *   (DNS-rebinding defence); upgrades also need an allowed `Origin`.
 * - A 256-bit token is given to the browser in the URL fragment (never sent to
 *   the server in a URL) and must be the first WebSocket frame, within a time
 *   limit; it is compared in constant time and never logged.
 * - Auth failures are rate limited per address; connections and frame sizes
 *   are capped; static files are served only from the UI directory, with CSP.
 */

export interface ServeOptions {
  projectPath: string;
  /** Default 4319; 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1. Non-loopback addresses require `unsafeListen`. */
  host?: string;
  unsafeListen?: boolean;
  /** Built UI (`index.html` + assets). Default `<package>/packages/ui/dist`. */
  uiDir?: string;
  /** Tests only; normally a fresh random token per run. */
  token?: string;
  /** Close the server after this long with no connected clients. */
  idleTimeoutMs?: number;
  maxConnections?: number;
  /** Time a new WebSocket has to send its token. Default 5 s. */
  authTimeoutMs?: number;
  /** Diagnostic lines (stderr by default). Never receives the token. */
  log?: (line: string) => void;
  subscriptions?: SubscriptionOptions;
  /** Defaults to `createEngineRpcServer({ projectPath })`. */
  rpcServer?: RpcServer;
}

export interface ServeHandle {
  /** Open this in a browser; the token is in the fragment. */
  url: string;
  port: number;
  host: string;
  /** Resolves when the server has stopped (closed or idle timeout). */
  closed: Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4319;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const BLOCK_MS = 60_000;
/** A client whose unsent data stays above this is shed (`slow_consumer`). */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const SEND_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
/** How long a closing socket may take to answer the close frame before it is cut. */
const CLOSE_GRACE_MS = 2_000;
/** The auth frame is `{"auth":"<64 hex>"}`; anything much larger is not a token. */
const MAX_AUTH_FRAME_BYTES = 512;
/** At most one "foreign origin" log line per this interval. */
const ORIGIN_LOG_INTERVAL_MS = 10_000;

export class ServeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeRefusedError";
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Built UI shipped with the package. */
export function defaultUiDir(): string {
  return path.join(resolvePackageRoot(), "packages", "ui", "dist");
}

export async function startServe(options: ServeOptions): Promise<ServeHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host) && !options.unsafeListen) {
    throw new ServeRefusedError(
      `Refusing to listen on ${host}: assentor serve is for this machine only. ` +
        "Use --unsafe-listen only if you understand that anyone who can reach it and has the token can read your sessions.",
    );
  }
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!isLoopbackHost(host)) {
    log(`[assentor serve] WARNING: listening on ${host}, not just this machine.`);
  }
  const token = options.token ?? randomBytes(32).toString("hex");
  const tokenDigest = digest(token);
  const uiDir = options.uiDir ?? defaultUiDir();
  const maxConnections = options.maxConnections ?? 8;
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const rpc =
    options.rpcServer ??
    createEngineRpcServer({ projectPath: options.projectPath, subscriptions: options.subscriptions });

  // Keyed by remote address. On loopback that is one key for every local
  // process: any local process can trigger the 60 s block. Accepted for a
  // loopback-only server with a 256-bit token; browsers can't (Origin check first).
  const failures = new Map<string, { count: number; first: number; blockedUntil: number }>();
  const sockets = new Set<WebSocket>();
  let authenticated = 0;
  let foreignOrigins = 0;
  let lastOriginLog = 0;
  let port = 0;
  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();
  let idleTimer: NodeJS.Timeout | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const isBlocked = (address: string): boolean => {
    const entry = failures.get(address);
    return entry !== undefined && entry.blockedUntil > Date.now();
  };
  const recordFailure = (address: string): void => {
    const now = Date.now();
    for (const [key, value] of failures) {
      if (value.blockedUntil < now && now - value.first > FAILURE_WINDOW_MS) {
        failures.delete(key);
      }
    }
    const entry = failures.get(address);
    if (!entry || now - entry.first > FAILURE_WINDOW_MS) {
      failures.set(address, { count: 1, first: now, blockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.blockedUntil = now + BLOCK_MS;
    }
  };

  const httpServer = http.createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, securityHeaders()).end();
      }
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
      res.writeHead(421, securityHeaders({ "Content-Type": "text/plain" })).end("Misdirected request");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, securityHeaders({ Allow: "GET, HEAD" })).end();
      return;
    }
    const file = await resolveStatic(uiDir, req.url ?? "/");
    if (file === "placeholder") {
      res.writeHead(200, securityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
      res.end(req.method === "HEAD" ? undefined : PLACEHOLDER_HTML);
      return;
    }
    if (!file) {
      res.writeHead(404, securityHeaders({ "Content-Type": "text/plain" })).end("Not found");
      return;
    }
    const body = await fs.readFile(file);
    res.writeHead(200, securityHeaders({ "Content-Type": contentType(file) }));
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const wsOrigins = [...allowedHosts].map((h) => `ws://${h}`).join(" ");
    return {
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src 'self' ${wsOrigins}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
      ...extra,
    };
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: RPC_MAX_FRAME_CHARS,
    // Supported by ws 8 at runtime; missing from @types/ws.
    ...({ closeTimeout: CLOSE_GRACE_MS } as object),
  });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const address = req.socket.remoteAddress ?? "unknown";
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (new URL(req.url ?? "/", "http://x").pathname !== "/rpc") {
      return reject(404, "Not Found");
    }
    if (closing) {
      return reject(503, "Service Unavailable");
    }
    if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
      return reject(421, "Misdirected Request");
    }
    if (!allowedOrigins.has(String(req.headers.origin ?? "").toLowerCase())) {
      // Any web page can try this; log a count, not a line per attempt.
      foreignOrigins += 1;
      const now = Date.now();
      if (now - lastOriginLog >= ORIGIN_LOG_INTERVAL_MS) {
        lastOriginLog = now;
        log(`[assentor serve] rejected ${foreignOrigins} connection(s) from a foreign origin`);
        foreignOrigins = 0;
      }
      return reject(403, "Forbidden");
    }
    if (isBlocked(address)) {
      return reject(429, "Too Many Requests");
    }
    if (sockets.size >= maxConnections) {
      return reject(503, "Service Unavailable");
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, address));
  });

  function onSocket(ws: WebSocket, address: string): void {
    sockets.add(ws);
    // pending → open after a good token; rejected after a bad one. Only
    // pending and open sockets get their frames looked at.
    let state: "pending" | "open" | "rejected" = "pending";
    let connection: RpcConnection | undefined;
    let alive = true;

    const reject = (reason: string, message: string) => {
      state = "rejected";
      recordFailure(address);
      log(`[assentor serve] ${message} (${address})`);
      // Terminate, not close: a closing socket still delivers frames and holds a slot.
      ws.close(4401, reason);
      setTimeout(() => ws.terminate(), 50).unref?.();
    };

    const authTimer = setTimeout(() => {
      if (state === "pending") {
        reject("authentication required", "a client did not authenticate in time");
      }
    }, authTimeoutMs);

    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_INTERVAL_MS);
    ping.unref?.();
    ws.on("pong", () => (alive = true));

    ws.on("message", (data, isBinary) => {
      if (state === "open") {
        void connection!.receive(isBinary ? "" : data.toString());
        return;
      }
      if (state !== "pending") {
        return;
      }
      clearTimeout(authTimer);
      const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as ArrayBuffer).byteLength;
      if (isBinary || size > MAX_AUTH_FRAME_BYTES || !checkToken(data.toString(), tokenDigest)) {
        reject("invalid token", "rejected a client with a wrong token");
        return;
      }
      state = "open";
      authenticated += 1;
      stopIdleTimer();
      failures.delete(address);
      connection = rpc.connect((frame) => sendFrame(ws, frame));
      ws.send(JSON.stringify({ auth: "ok" }));
    });

    const finish = () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      connection?.close();
      sockets.delete(ws);
      if (state === "open") {
        authenticated -= 1;
      }
      state = "rejected";
      if (authenticated === 0 && !closing) {
        startIdleTimer();
      }
    };
    ws.on("close", finish);
    ws.on("error", () => ws.terminate());
  }

  /**
   * Resolve once `ws` has flushed the frame, so the RPC writer (and every
   * subscription) waits on a slow browser. Shed a client whose buffer stays
   * full or whose send stalls: it reconnects and resubscribes from its last seq.
   */
  function shed(ws: WebSocket): void {
    // Tell the client why, but free the slot now: the close frame would queue
    // behind data it is already not reading.
    ws.close(1013, "slow_consumer");
    setTimeout(() => ws.terminate(), 50).unref?.();
  }

  function sendFrame(ws: WebSocket, frame: string): Promise<void> {
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      shed(ws);
      return Promise.reject(new Error("slow_consumer"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        shed(ws);
        reject(new Error("send timed out"));
      }, SEND_TIMEOUT_MS);
      timer.unref?.();
      ws.send(frame, (error) => {
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  function startIdleTimer(): void {
    if (options.idleTimeoutMs === undefined || idleTimer) {
      return;
    }
    idleTimer = setTimeout(() => {
      log("[assentor serve] no clients for a while; stopping.");
      void close();
    }, options.idleTimeoutMs);
    idleTimer.unref?.();
  }

  function stopIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      stopIdleTimer();
      for (const ws of sockets) {
        ws.close(1001, "server stopping");
      }
      // Give clients a moment to answer, then cut whatever is left.
      await new Promise((resolve) => setTimeout(resolve, sockets.size > 0 ? 200 : 0));
      for (const ws of sockets) {
        ws.terminate();
      }
      wss.close();
      const stopped = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeAllConnections?.();
      await stopped;
      resolveClosed();
    })();
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? DEFAULT_PORT, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  port = (httpServer.address() as AddressInfo).port;
  const boundName = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const names = new Set([boundName.toLowerCase()]);
  if (isLoopbackHost(host)) {
    for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
      names.add(name);
    }
  }
  // Browsers leave the default port out of Host and Origin.
  const suffixes = port === 80 ? [`:${port}`, ""] : [`:${port}`];
  allowedHosts = new Set([...names].flatMap((name) => suffixes.map((suffix) => `${name}${suffix}`)));
  allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  startIdleTimer();

  // A wildcard bind is not an address a browser can open; show loopback.
  const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : boundName;
  return {
    url: `http://${shownHost}:${port}/#token=${token}`,
    port,
    host,
    closed,
    close,
  };
}

/** The first frame must be `{"auth":"<token>"}`. Constant-time compare. */
function checkToken(frame: string, expected: Buffer): boolean {
  try {
    const value = (JSON.parse(frame) as { auth?: unknown }).auth;
    return typeof value === "string" && timingSafeEqual(digest(value), expected);
  } catch {
    return false;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Map a URL path to a file inside `uiDir`, or "placeholder" for `/` when the
 * UI is not built. Rejects traversal, dotfiles and symlinks out of `uiDir`.
 */
async function resolveStatic(uiDir: string, url: string): Promise<string | "placeholder" | undefined> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, "http://x").pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0")) {
    return undefined;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relative.split(/[\\/]/).some((part) => part === ".." || part.startsWith("."))) {
    return undefined;
  }
  let root: string;
  try {
    root = await fs.realpath(uiDir);
  } catch {
    return pathname === "/" ? "placeholder" : undefined;
  }
  try {
    const real = await fs.realpath(path.join(root, relative));
    const inside = path.relative(root, real);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      return undefined;
    }
    return (await fs.stat(real)).isFile() ? real : undefined;
  } catch {
    return pathname === "/" ? "placeholder" : undefined;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Assentor</title></head>
<body><h1>Assentor</h1><p>The web UI is not built yet. The engine is running; build the UI with <code>pnpm build:ui</code> and reload.</p></body></html>
`;
