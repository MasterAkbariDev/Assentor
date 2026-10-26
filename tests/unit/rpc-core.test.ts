import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEngineRpcServer,
  createId,
  createInProcessTransport,
  EventLog,
  RpcClient,
  RpcErrorCode,
  RpcRemoteError,
  RpcServer,
  serveStdio,
  sessionPaths,
  type EngineEvent,
  type ResyncRequiredParams,
} from "../../src/index.js";
import { runAssentorTask } from "../../src/cli/commands.js";

const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

async function project(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-core-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A raw connection that records every frame the server sends. */
function rawConnection(server: RpcServer) {
  const frames: Array<Record<string, unknown>> = [];
  const connection = server.connect((frame) => {
    frames.push(JSON.parse(frame) as Record<string, unknown>);
  });
  cleanups.push(() => connection.close());
  return { connection, frames };
}

function engineClient(projectPath: string) {
  const server = createEngineRpcServer({
    projectPath,
    engineVersion: "9.9.9-test",
    subscriptions: { pollMs: 10 },
  });
  const { client: transport } = createInProcessTransport(server);
  const client = new RpcClient(transport);
  cleanups.push(() => client.close());
  return client;
}

const draft = (sessionId: string, title = "t") => ({
  type: "session.created" as const,
  sessionId,
  data: { title },
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("JSON-RPC conformance", () => {
  it("maps protocol errors to JSON-RPC codes", async () => {
    const server = createEngineRpcServer({ projectPath: await project(), engineVersion: "x" });
    const { connection, frames } = rawConnection(server);

    await connection.receive("{not json");
    await connection.receive(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "engine.hello" }]));
    await connection.receive(JSON.stringify({ jsonrpc: "1.0", id: 2, method: "engine.hello" }));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: { a: 1 }, method: "engine.hello" }));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nope.nope" }));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "events.subscribe", params: { sessionId: 7 } }));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "events.subscribe", params: { sessionId: "../x" } }));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "sessions.list", params: { extra: true } }));
    // Notifications never get a response, known or not.
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", method: "nope.nope" }));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", method: "engine.hello" }));

    expect(frames.map((f) => [f.id, (f.error as { code: number } | undefined)?.code])).toEqual([
      [null, RpcErrorCode.ParseError],
      [null, RpcErrorCode.InvalidRequest],
      [2, RpcErrorCode.InvalidRequest],
      [null, RpcErrorCode.InvalidRequest],
      [3, RpcErrorCode.MethodNotFound],
      [4, RpcErrorCode.InvalidParams],
      [5, RpcErrorCode.InvalidParams],
      [6, RpcErrorCode.InvalidParams],
    ]);
    expect((frames[1]!.error as { message: string }).message).toMatch(/batches/);
    expect((frames[5]!.error as { data: { issues: unknown[] } }).data.issues.length).toBeGreaterThan(0);
  });

  it("turns a handler crash into -32603 without a stack, and rejects off-contract results", async () => {
    const server = new RpcServer()
      .register("engine.hello", () => {
        throw new Error("disk on fire");
      })
      .register("sessions.list", () => ({ sessions: "nope" }) as never);
    const { connection, frames } = rawConnection(server);
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: "a", method: "engine.hello" }));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: "b", method: "sessions.list" }));

    expect(frames[0]).toEqual({
      jsonrpc: "2.0",
      id: "a",
      error: { code: RpcErrorCode.InternalError, message: "Internal error", data: { message: "disk on fire" } },
    });
    expect(JSON.stringify(frames[0])).not.toMatch(/at .*\.ts/);
    expect((frames[1]!.error as { code: number }).code).toBe(RpcErrorCode.InternalError);
  });

  it("answers the handshake with version and capabilities", async () => {
    const client = engineClient(await project());
    expect(await client.call("engine.hello", { client: "test" })).toEqual({
      engineVersion: "9.9.9-test",
      protocolVersion: 1,
      capabilities: ["engine.hello", "events.subscribe", "events.unsubscribe", "sessions.list"],
    });
    await expect(client.call("events.subscribe", { sessionId: "bad" })).rejects.toBeInstanceOf(RpcRemoteError);
  });
});

describe("sessions.list", () => {
  it("lists runs with and without a live log, newest first", async () => {
    const projectPath = await project();
    const userDir = await project();
    const saved = process.env.ASSENTOR_USER_DIR;
    process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
    try {
      await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
      await fs.writeFile(
        path.join(projectPath, ".assentor", "config.yaml"),
        "git:\n  checkpoints: false\nexecutor:\n  provider: mock\nreviewers:\n  - provider: mock\n",
        "utf8",
      );
      const { result } = await runAssentorTask({
        projectPath,
        prompt: "Implement average()",
        skipPreflight: true,
        skipGates: true,
      });
      // An old-style run: task record, no session log.
      const oldId = createId();
      await fs.mkdir(path.join(projectPath, ".assentor", "tasks", oldId), { recursive: true });
      const state = JSON.parse(
        await fs.readFile(path.join(projectPath, ".assentor", "tasks", result.taskId, "state.json"), "utf8"),
      );
      await fs.writeFile(
        path.join(projectPath, ".assentor", "tasks", oldId, "state.json"),
        JSON.stringify({ ...state, taskId: oldId, updatedAt: "2020-01-01T00:00:00.000Z" }),
        "utf8",
      );
      // A session log with no task record, and a junk directory.
      const loose = createId();
      const log = await EventLog.open(projectPath, loose);
      await log.append(draft(loose, "Loose session"));
      await log.close();
      await fs.mkdir(path.join(projectPath, ".assentor", "sessions", "not-an-id"), { recursive: true });

      const client = engineClient(projectPath);
      const { sessions } = await client.call("sessions.list");
      const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
      // Newest first: the log-only session (by its log's last write), the run, then the 2020 task.
      expect(sessions.map((x) => x.id)).toEqual([loose, result.taskId, oldId]);
      expect(byId[result.taskId]).toMatchObject({ title: "Implement average()", status: "DONE", hasLiveLog: true });
      expect(byId[result.taskId]!.lastSeq).toBeGreaterThan(5);
      expect(byId[oldId]).toMatchObject({ hasLiveLog: false, lastSeq: 0 });
      expect(byId[loose]).toMatchObject({ title: "Loose session", hasLiveLog: true, lastSeq: 1 });
      expect(byId["not-an-id"]).toBeUndefined();
    } finally {
      if (saved === undefined) {
        delete process.env.ASSENTOR_USER_DIR;
      } else {
        process.env.ASSENTOR_USER_DIR = saved;
      }
    }
  });
});

describe("sessions.list cache", () => {
  it("shares one scan for a second, and can be turned off", async () => {
    const projectPath = await project();
    const make = (listCacheMs?: number) => {
      const server = createEngineRpcServer({ projectPath, engineVersion: "x", ...(listCacheMs === undefined ? {} : { listCacheMs }) });
      const client = new RpcClient(createInProcessTransport(server).client);
      cleanups.push(() => client.close());
      return client;
    };
    const cached = make();
    const uncached = make(0);
    expect((await cached.call("sessions.list")).sessions).toEqual([]);
    expect((await uncached.call("sessions.list")).sessions).toEqual([]);
    const id = createId();
    const log = await EventLog.open(projectPath, id);
    await log.append(draft(id));
    await log.close();
    expect((await cached.call("sessions.list")).sessions).toEqual([]);
    expect((await uncached.call("sessions.list")).sessions.map((x) => x.id)).toEqual([id]);
  });
});

describe("events.subscribe", () => {
  it("delivers the backlog, then tails new events in order, without partial lines", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    cleanups.push(() => log.close());
    for (let i = 0; i < 3; i += 1) {
      await log.append(draft(sessionId, `e${i + 1}`));
    }

    const client = engineClient(projectPath);
    const seen: EngineEvent[] = [];
    const sub = await client.subscribeEvents(sessionId, 1, { onEvent: (e) => seen.push(e) });
    await until(() => seen.length === 2);
    expect(seen.map((e) => e.seq)).toEqual([2, 3]);

    // A write in progress (no newline yet) is not delivered...
    const file = sessionPaths(projectPath, sessionId).events;
    const partial = JSON.stringify({ ...(await log.readFrom(0))[0], seq: 4 });
    await fs.appendFile(file, partial.slice(0, 20), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(2);
    // ...until it completes.
    await fs.appendFile(file, `${partial.slice(20)}\n`, "utf8");
    await until(() => seen.length === 3);

    await sub.unsubscribe();
    await fs.appendFile(file, `${JSON.stringify({ ...JSON.parse(partial), seq: 5 })}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("resumes without gaps from the last seq, and waits for a log that does not exist yet", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const client = engineClient(projectPath);
    const seen: number[] = [];
    const first = await client.subscribeEvents(sessionId, 0, { onEvent: (e) => seen.push(e.seq) });

    const log = await EventLog.open(projectPath, sessionId);
    cleanups.push(() => log.close());
    await log.append(draft(sessionId));
    await log.append(draft(sessionId));
    await until(() => seen.length === 2);
    await first.unsubscribe();

    await log.append(draft(sessionId));
    await log.append(draft(sessionId));
    const second = await client.subscribeEvents(sessionId, seen.at(-1)!, { onEvent: (e) => seen.push(e.seq) });
    await until(() => seen.length === 4);
    expect(seen).toEqual([1, 2, 3, 4]);
    await second.unsubscribe();
  });

  it("keeps memory bounded for a slow client: it falls behind instead of buffering", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    cleanups.push(() => log.close());
    for (let i = 0; i < 300; i += 1) {
      await log.append(draft(sessionId, "x".repeat(200)));
    }

    const server = createEngineRpcServer({
      projectPath,
      engineVersion: "x",
      subscriptions: { pollMs: 5, chunkBytes: 4096 },
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const delivered: number[] = [];
    let release: (() => void) | undefined;
    const connection = server.connect(async (frame) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const message = JSON.parse(frame) as { method?: string; params?: { event: EngineEvent } };
      if (message.method === "events.event") {
        delivered.push(message.params!.event.seq);
        if (delivered.length === 10) {
          await new Promise<void>((resolve) => (release = resolve)); // the client stalls
        }
      }
      inFlight -= 1;
    });
    cleanups.push(() => connection.close());
    await connection.receive(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { sessionId } }),
    );
    await until(() => delivered.length === 10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Stalled: nothing more is sent or queued while the client is stuck.
    expect(delivered).toHaveLength(10);
    expect(maxInFlight).toBe(1);
    release!();
    await until(() => delivered.length === 300);
    expect(delivered).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it("asks the client to resync when the log is replaced", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId));
    await log.append(draft(sessionId));
    await log.close();

    const client = engineClient(projectPath);
    const seen: number[] = [];
    let resync: ResyncRequiredParams | undefined;
    await client.subscribeEvents(sessionId, 0, {
      onEvent: (e) => seen.push(e.seq),
      onResync: (params) => (resync = params),
    });
    await until(() => seen.length === 2);
    await fs.truncate(sessionPaths(projectPath, sessionId).events, 0);
    await until(() => resync !== undefined);
    expect(resync).toMatchObject({ sessionId, lastSeq: 2, reason: "log_replaced" });
  });

  it("limits subscriptions per connection", async () => {
    const projectPath = await project();
    const client = engineClient(projectPath);
    for (let i = 0; i < 16; i += 1) {
      await client.call("events.subscribe", { sessionId: createId() });
    }
    await expect(client.call("events.subscribe", { sessionId: createId() })).rejects.toMatchObject({
      code: RpcErrorCode.SubscriptionLimit,
    });
  });

  it("stops tailing when the connection closes", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    cleanups.push(() => log.close());
    const server = createEngineRpcServer({ projectPath, engineVersion: "x", subscriptions: { pollMs: 5 } });
    const frames: string[] = [];
    const connection = server.connect((frame) => {
      frames.push(frame);
    });
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { sessionId } }));
    await log.append(draft(sessionId));
    await until(() => frames.some((f) => f.includes('"events.event"')));
    connection.close();

    const opens = vi.spyOn(fs, "open");
    const sent = frames.length;
    await log.append(draft(sessionId));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(frames).toHaveLength(sent);
    expect(opens.mock.calls.filter(([file]) => String(file).endsWith("events.ndjson"))).toEqual([]);
    opens.mockRestore();
  });

  it("catches up quickly from a high fromSeq on a large log", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    cleanups.push(() => log.close());
    for (let i = 0; i < 2000; i += 1) {
      await log.append(draft(sessionId, "y".repeat(500)));
    }
    const server = createEngineRpcServer({
      projectPath,
      engineVersion: "x",
      subscriptions: { pollMs: 200, chunkBytes: 16 * 1024 },
    });
    const seen: number[] = [];
    const connection = server.connect((frame) => {
      const message = JSON.parse(frame) as { params?: { event?: EngineEvent } };
      if (message.params?.event) {
        seen.push(message.params.event.seq);
      }
    });
    cleanups.push(() => connection.close());
    const started = Date.now();
    await connection.receive(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { sessionId, fromSeq: 1998 } }),
    );
    await until(() => seen.length === 2);
    // ~1 MB of already-seen lines in 16 KiB chunks must not wait a poll per chunk.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen).toEqual([1999, 2000]);
  });

  it("ends with a terminal unreadable_log for a line beyond the limit", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId, "z".repeat(5000)));
    await log.close();
    const server = createEngineRpcServer({
      projectPath,
      engineVersion: "x",
      subscriptions: { pollMs: 5, chunkBytes: 256, maxLineBytes: 1024 },
    });
    const { client: transport } = createInProcessTransport(server);
    const client = new RpcClient(transport);
    cleanups.push(() => client.close());
    let resync: ResyncRequiredParams | undefined;
    await client.subscribeEvents(sessionId, 0, { onEvent: () => undefined, onResync: (p) => (resync = p) });
    await until(() => resync !== undefined);
    expect(resync).toMatchObject({ reason: "unreadable_log", lastSeq: 0 });
  });

  it("detects a log replaced by rename", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId));
    await log.close();
    const client = engineClient(projectPath);
    const seen: number[] = [];
    let resync: ResyncRequiredParams | undefined;
    await client.subscribeEvents(sessionId, 0, { onEvent: (e) => seen.push(e.seq), onResync: (p) => (resync = p) });
    await until(() => seen.length === 1);

    const file = sessionPaths(projectPath, sessionId).events;
    const replacement = `${file}.new`;
    const content = await fs.readFile(file, "utf8");
    await fs.writeFile(replacement, content + content, "utf8"); // bigger, so size alone wouldn't tell
    await fs.rename(replacement, file);
    await until(() => resync !== undefined);
    expect(resync).toMatchObject({ reason: "log_replaced", lastSeq: 1 });
  });

});

describe("RpcClient", () => {
  it("delivers a resync that arrives before the subscribe response settles", async () => {
    let toClient: (frame: string) => void = () => undefined;
    const transport = {
      send(frame: string) {
        const { id } = JSON.parse(frame) as { id: number };
        // Response and resync in the same tick, before the awaiting code resumes.
        toClient(JSON.stringify({ jsonrpc: "2.0", id, result: { subscriptionId: "s1" } }));
        toClient(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "events.resync_required",
            params: { subscriptionId: "s1", sessionId: "x", lastSeq: 0, reason: "unreadable_log" },
          }),
        );
      },
      onMessage(listener: (frame: string) => void) {
        toClient = listener;
      },
      onClose() {},
      close() {},
    };
    const client = new RpcClient(transport);
    let resync: ResyncRequiredParams | undefined;
    await client.subscribeEvents("x", 0, { onEvent: () => undefined, onResync: (p) => (resync = p) });
    expect(resync).toMatchObject({ subscriptionId: "s1", reason: "unreadable_log" });
  });

  it("rejects pending calls and tells subscriptions when the connection drops", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    cleanups.push(() => log.close());
    await log.append(draft(sessionId));
    const server = createEngineRpcServer({ projectPath, engineVersion: "x", subscriptions: { pollMs: 5 } });
    const { client: transport } = createInProcessTransport(server);
    const client = new RpcClient(transport);
    let disconnected: { lastSeq: number } | undefined;
    const seen: number[] = [];
    await client.subscribeEvents(sessionId, 0, {
      onEvent: (e) => seen.push(e.seq),
      onDisconnect: (info) => (disconnected = info),
    });
    await until(() => seen.length === 1);
    const pending = client.call("sessions.list");
    transport.close();
    await expect(pending).rejects.toThrow(/closed/);
    expect(disconnected).toEqual({ lastSeq: 1, reason: "closed" });
    expect(client.isClosed).toBe(true);
    await expect(client.call("engine.hello")).rejects.toThrow(/closed/);
  });
});

describe("resumable read failures", () => {
  it("reports a persistently busy file as io_error, not the terminal unreadable_log", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId));
    await log.close();
    const realOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith("events.ndjson")) {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return realOpen(file, ...(rest as []));
    });
    try {
      const client = engineClient(projectPath);
      let resync: ResyncRequiredParams | undefined;
      await client.subscribeEvents(sessionId, 0, { onEvent: () => undefined, onResync: (p) => (resync = p) });
      await until(() => resync !== undefined);
      expect(resync).toMatchObject({ reason: "io_error", lastSeq: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("tells an in-process client when the server closes the connection", async () => {
    const server = createEngineRpcServer({ projectPath: await project(), engineVersion: "x" });
    const { client: transport, connection } = createInProcessTransport(server);
    const client = new RpcClient(transport);
    let reason: string | undefined;
    client.onClose((r) => (reason = r));
    connection.close();
    expect(reason).toBe("closed by server");
    expect(client.isClosed).toBe(true);
  });
});

describe("RpcConnection limits", () => {
  it("rejects oversized frames and hides absolute paths in internal errors", async () => {
    const server = new RpcServer().register("engine.hello", () => {
      throw new Error("ENOENT: no such file, open '/Users/someone/project/.assentor/x'");
    });
    const { connection, frames } = rawConnection(server);
    await connection.receive(`{"jsonrpc":"2.0","id":1,"method":"engine.hello","params":{"client":"${"a".repeat(1024 * 1024)}"}}`);
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "engine.hello" }));
    expect(frames[0]).toMatchObject({ id: null, error: { code: RpcErrorCode.InvalidRequest, message: "Invalid request: frame too large" } });
    expect(JSON.stringify(frames[1])).not.toContain("/Users/someone");
    expect((frames[1]!.error as { data: { message: string } }).data.message).toBe("ENOENT: no such file, open '<path>'");
  });

  it("keeps the browser entry free of Node imports", async () => {
    const seen = new Set<string>();
    const nodeImports: string[] = [];
    const visit = async (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await fs.readFile(file, "utf8");
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = match[1]!;
        if (spec.startsWith("node:") || ["fs", "path", "os", "crypto", "readline", "stream"].includes(spec)) {
          nodeImports.push(`${path.relative(process.cwd(), file)} → ${spec}`);
        } else if (spec.startsWith(".")) {
          await visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
        }
      }
    };
    await visit(path.resolve("src/rpc/browser.ts"));
    expect(nodeImports).toEqual([]);
  });
});

describe("stdio transport", () => {
  it("frames one JSON message per line, across split chunks, and answers bad lines", async () => {
    const server = createEngineRpcServer({ projectPath: await project(), engineVersion: "1.2.3" });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Array<Record<string, unknown>> = [];
    let buffer = "";
    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        lines.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    const done = serveStdio(server, { input, output });

    const hello = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.hello" });
    input.write(hello.slice(0, 10));
    input.write(`${hello.slice(10)}\n{oops}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sessions.list" })}\r\n`);
    await until(() => lines.length === 3);
    input.end();
    await done;

    // Responses may arrive out of order (JSON-RPC allows it); match by id.
    const byId = (id: unknown) => lines.find((line) => line.id === id);
    expect(byId(1)).toMatchObject({ result: { engineVersion: "1.2.3", protocolVersion: 1 } });
    expect(byId(null)).toMatchObject({ error: { code: RpcErrorCode.ParseError } });
    expect(byId(2)).toMatchObject({ result: { sessions: [] } });
  });
});
