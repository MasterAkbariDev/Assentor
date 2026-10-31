import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createId, EventLog, type EngineEvent } from "../../packages/engine/src/index.js";
import { isLoopbackHost, ServeRefusedError, startServe, type ServeHandle } from "../../packages/engine/src/serve/index.js";

const TOKEN = "a".repeat(64);
const dirs: string[] = [];
const handles: ServeHandle[] = [];
const sockets: WebSocket[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.terminate();
  }
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function serve(extra: Partial<Parameters<typeof startServe>[0]> = {}) {
  const projectPath = await tempDir("serve-project-");
  const logs: string[] = [];
  const handle = await startServe({
    projectPath,
    port: 0,
    token: TOKEN,
    authTimeoutMs: 200,
    log: (line) => logs.push(line),
    subscriptions: { pollMs: 10 },
    ...extra,
  });
  handles.push(handle);
  return { handle, projectPath, logs, origin: `http://127.0.0.1:${handle.port}`, host: `127.0.0.1:${handle.port}` };
}

function request(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: options.path ?? "/", method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Open a WebSocket; resolves with the socket, or the HTTP status of a refused upgrade. */
function connect(
  port: number,
  options: { origin?: string; host?: string } = {},
): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.host ? { headers: { host: options.host } } : {}),
    });
    sockets.push(ws);
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.once("error", () => resolve({}));
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

async function authenticated(port: number, origin: string) {
  const { ws } = await connect(port, { origin });
  ws!.send(JSON.stringify({ auth: TOKEN }));
  expect(await nextMessage(ws!)).toEqual({ auth: "ok" });
  return ws!;
}

describe("assentor serve: binding", () => {
  it("refuses a non-loopback address unless told it is unsafe", async () => {
    await expect(startServe({ projectPath: os.tmpdir(), host: "0.0.0.0", port: 0 })).rejects.toBeInstanceOf(
      ServeRefusedError,
    );
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });

  it("prints the token only in the URL fragment", async () => {
    const { handle } = await serve();
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/#token=${TOKEN}`);
    expect(new URL(handle.url).search).toBe("");
  });
});

describe("assentor serve: HTTP", () => {
  it("serves the UI with security headers and a placeholder before the UI is built", async () => {
    const { handle, host } = await serve({ uiDir: path.join(os.tmpdir(), "no-such-ui-dir") });
    const res = await request(handle.port, { headers: { host } });
    expect(res.status).toBe(200);
    expect(res.body).toContain("not built yet");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain(`connect-src 'self' ws://127.0.0.1:${handle.port}`);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves only files inside the UI directory", async () => {
    const uiDir = await tempDir("serve-ui-");
    await fs.writeFile(path.join(uiDir, "index.html"), "<p>app</p>", "utf8");
    await fs.mkdir(path.join(uiDir, "assets"));
    await fs.writeFile(path.join(uiDir, "assets", "app.js"), "console.log(1)", "utf8");
    await fs.writeFile(path.join(uiDir, ".env"), "SECRET=1", "utf8");
    const outside = await tempDir("serve-outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
    // Creating symlinks needs elevated rights on Windows runners; the rest of the test still runs there.
    const canSymlink = process.platform !== "win32";
    if (canSymlink) {
      await fs.symlink(path.join(outside, "secret.txt"), path.join(uiDir, "link.txt"));
    }
    const { handle, host } = await serve({ uiDir });

    const get = (p: string) => request(handle.port, { path: p, headers: { host } });
    expect((await get("/")).body).toBe("<p>app</p>");
    expect((await get("/assets/app.js")).headers["content-type"]).toContain("text/javascript");
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/assets/..%2f..%2fpackage.json", "/.env", ...(canSymlink ? ["/link.txt"] : []), "/nope.js"]) {
      expect((await get(p)).status, p).toBe(404);
    }
    expect((await request(handle.port, { method: "POST", headers: { host } })).status).toBe(405);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const { handle } = await serve();
    expect((await request(handle.port, { headers: { host: "evil.example:80" } })).status).toBe(421);
    expect((await request(handle.port, { headers: { host: `attacker.test:${handle.port}` } })).status).toBe(421);
    expect((await request(handle.port, { headers: { host: `localhost:${handle.port}` } })).status).toBe(200);
  });
});

describe("assentor serve: WebSocket", () => {
  it("refuses foreign origins, foreign hosts and other paths", async () => {
    const { handle, origin } = await serve();
    expect((await connect(handle.port, { origin: "http://evil.example" })).status).toBe(403);
    expect((await connect(handle.port)).status).toBe(403); // no Origin at all
    expect((await connect(handle.port, { origin, host: "evil.example" })).status).toBe(421);
  });

  it("closes a client that never sends the token, or sends a wrong one, and never logs it", async () => {
    const { handle, origin, logs } = await serve();
    const silent = await connect(handle.port, { origin });
    expect(await closeCode(silent.ws!)).toBe(4401);

    const wrong = await connect(handle.port, { origin });
    wrong.ws!.send(JSON.stringify({ auth: "b".repeat(64) }));
    expect(await closeCode(wrong.ws!)).toBe(4401);

    const ws = await authenticated(handle.port, origin);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.hello" }));
    expect(await nextMessage(ws)).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it("blocks an address after repeated auth failures", async () => {
    const { handle, origin } = await serve();
    for (let i = 0; i < 5; i += 1) {
      const { ws } = await connect(handle.port, { origin });
      ws!.send(JSON.stringify({ auth: "wrong" }));
      await closeCode(ws!);
    }
    expect((await connect(handle.port, { origin })).status).toBe(429);
  });

  it("caps connections", async () => {
    const { handle, origin } = await serve({ maxConnections: 2 });
    await authenticated(handle.port, origin);
    await authenticated(handle.port, origin);
    expect((await connect(handle.port, { origin })).status).toBe(503);
  });

  it("streams a session's events to an authenticated browser", async () => {
    const { handle, origin, projectPath } = await serve();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append({ type: "session.created", sessionId, data: { title: "live" } });

    const ws = await authenticated(handle.port, origin);
    const events: EngineEvent[] = [];
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { method?: string; params?: { event: EngineEvent } };
      if (message.method === "events.event") {
        events.push(message.params!.event);
      }
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { sessionId } }));
    await log.append({ type: "session.state", sessionId, data: { to: "EXECUTING" } });
    const start = Date.now();
    while (events.length < 2 && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await log.close();
    expect(events.map((e) => e.type)).toEqual(["session.created", "session.state"]);
  });

  it("ignores every frame after a rejected token, including the right one", async () => {
    const { handle, origin, logs } = await serve();
    const { ws } = await connect(handle.port, { origin });
    const replies: string[] = [];
    ws!.on("message", (data) => replies.push(data.toString()));
    ws!.send(JSON.stringify({ auth: "wrong" }));
    for (let i = 0; i < 20; i += 1) {
      ws!.send(JSON.stringify({ auth: `guess-${i}` }));
    }
    ws!.send(JSON.stringify({ auth: TOKEN }));
    expect(await closeCode(ws!)).not.toBe(1000);
    expect(replies).toEqual([]);
    expect(logs.filter((line) => line.includes("wrong token"))).toHaveLength(1);
  });

  it("refuses Origin: null and a binary first frame", async () => {
    const { handle, origin } = await serve();
    expect((await connect(handle.port, { origin: "null" })).status).toBe(403);
    const { ws } = await connect(handle.port, { origin });
    const closedWith = closeCode(ws!);
    ws!.send(Buffer.from(JSON.stringify({ auth: TOKEN })), { binary: true });
    expect(await closedWith).toBe(4401);
  });

  it("frees the slot of a socket that never answers, and close() does not wait for it", async () => {
    const { handle, origin } = await serve({ maxConnections: 1, authTimeoutMs: 100 });
    // A raw client that completes the upgrade and then ignores everything.
    const raw = net.connect(handle.port, "127.0.0.1");
    await new Promise<void>((resolve) => raw.once("connect", () => resolve()));
    raw.write(
      [
        "GET /rpc HTTP/1.1",
        `Host: 127.0.0.1:${handle.port}`,
        `Origin: ${origin}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    raw.on("data", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400)); // auth timeout + terminate
    const ws = await authenticated(handle.port, origin);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const raw2 = net.connect(handle.port, "127.0.0.1");
    raw2.on("data", () => undefined);
    raw2.on("error", () => undefined);
    const started = Date.now();
    await handle.close();
    expect(Date.now() - started).toBeLessThan(1500);
    raw.destroy();
    raw2.destroy();
  });

  it("warns on an unsafe listen address and shows a URL a browser can open", async () => {
    const logs: string[] = [];
    const handle = await startServe({
      projectPath: os.tmpdir(),
      host: "0.0.0.0",
      unsafeListen: true,
      port: 0,
      token: TOKEN,
      log: (line) => logs.push(line),
    });
    handles.push(handle);
    expect(logs.join("\n")).toMatch(/WARNING: listening on 0\.0\.0\.0/);
    expect(handle.url.startsWith(`http://127.0.0.1:${handle.port}/`)).toBe(true);
  });

  it("does not restart the idle timer while closing", async () => {
    const { handle, origin, logs } = await serve({ idleTimeoutMs: 60 });
    await authenticated(handle.port, origin);
    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(logs.some((line) => line.includes("no clients for a while"))).toBe(false);
  });

  it("stops after the idle timeout with no clients", async () => {
    const { handle } = await serve({ idleTimeoutMs: 50 });
    await handle.closed;
    await expect(request(handle.port)).rejects.toThrow();
  });
});
