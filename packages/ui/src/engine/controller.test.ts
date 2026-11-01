import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createId } from "#assentor/engine/core/ids.js";
import { EventLog } from "#assentor/engine/events/log.js";
import { createEngineRpcServer } from "#assentor/engine/rpc/engine.js";
import { createInProcessTransport } from "#assentor/engine/rpc/transports.js";
import type { RpcClientTransport } from "#assentor/protocol/rpc-client.js";
import { createEngineStore } from "../store/engineStore.js";
import { AuthRejectedError } from "../transport/websocket.js";
import { mockTransport } from "../transport/mock.js";
import { WebSocketTransport } from "../transport/websocketTransport.js";
import { EngineController } from "./controller.js";

// Drives the controller against the real engine RPC over the in-process transport.

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "ui-controller-"));
  dirs.push(projectPath);
  const server = createEngineRpcServer({ projectPath, engineVersion: "1.0.0-test", subscriptions: { pollMs: 5 } });
  const transports: RpcClientTransport[] = [];
  const store = createEngineStore();
  const transport = new WebSocketTransport({
    connect: async () => {
      const { client } = createInProcessTransport(server);
      transports.push(client);
      return client;
    },
    backoffMs: [10],
  });
  const controller = new EngineController({
    store,
    transport,
    listIntervalMs: 20,
    schedule: (flush) => setTimeout(flush, 0),
  });
  stops.push(() => controller.stop());
  return { projectPath, store, controller, transports };
}

describe("EngineController", () => {
  it("connects, lists sessions and streams the selected one live", async () => {
    const { projectPath, store, controller } = await setup();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    stops.push(() => void log.close());
    await log.append({ type: "session.created", sessionId, data: { title: "Live run" } });

    controller.start();
    await until(() => store.getState().connection === "connected");
    expect(store.getState().engineVersion).toBe("1.0.0-test");
    await until(() => store.getState().sessions.length === 1);
    expect(store.getState().sessions[0]).toMatchObject({ id: sessionId, title: "Live run" });

    store.getState().select(sessionId);
    await log.append({ type: "session.state", sessionId, data: { to: "EXECUTING" } });
    await until(() => store.getState().session?.state === "EXECUTING");
    expect(store.getState().session!.lastSeq).toBe(2);
  });

  it("reconnects after a drop and resumes from the last seq without gaps or repeats", async () => {
    const { projectPath, store, controller, transports } = await setup();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    stops.push(() => void log.close());
    await log.append({ type: "session.created", sessionId, data: { title: "t" } });
    controller.start();
    store.getState().select(sessionId);
    await until(() => store.getState().session?.lastSeq === 1);

    transports[0]!.close(); // the connection drops
    await log.append({ type: "session.state", sessionId, data: { to: "EXECUTING" } });
    await log.append({ type: "session.state", sessionId, data: { to: "REVIEWING" } });
    await until(() => store.getState().session?.lastSeq === 3);
    expect(transports.length).toBeGreaterThanOrEqual(2);
    expect(store.getState().connection).toBe("connected");
    expect(store.getState().session!.eventCount).toBe(3);
    expect(store.getState().session!.state).toBe("REVIEWING");
  });

  it("keeps the session pause and the lead pause, apart, across a reconnect and a resync", async () => {
    const { projectPath, store, controller, transports } = await setup();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    stops.push(() => void log.close());
    await log.append({ type: "session.created", sessionId, data: { title: "t" } });
    await log.append({ type: "mode.selected", sessionId, data: { mode: "lead", kind: "dynamic", autonomy: "supervised" } });
    await log.append({ type: "session.paused", sessionId, data: {} });
    await log.append({ type: "lead.action", sessionId, data: { action: "pause", accepted: true, by: "user" } });
    controller.start();
    store.getState().select(sessionId);
    await until(() => store.getState().session?.lastSeq === 4);
    expect(store.getState().session).toMatchObject({ paused: true, lead: { paused: true } });

    transports[0]!.close(); // the connection drops; the resubscribe replays from the last seq
    await log.append({ type: "session.resumed", sessionId, data: {} });
    await until(() => store.getState().session?.lastSeq === 5);
    expect(store.getState().session!.eventCount).toBe(5);
    expect(store.getState().session).toMatchObject({ paused: false, lead: { paused: true } });

    // A resync from scratch (page reload) rebuilds the same state from the log.
    const fresh = createEngineStore();
    fresh.getState().select(sessionId);
    const events = store.getState().session!.lastSeq;
    expect(events).toBe(5);
    const second = new EngineController({
      store: fresh,
      transport: new WebSocketTransport({
        connect: async () => {
          const { client } = createInProcessTransport(createEngineRpcServer({ projectPath, engineVersion: "1.0.0-test", subscriptions: { pollMs: 5 } }));
          return client;
        },
        backoffMs: [10],
      }),
      schedule: (flush) => setTimeout(flush, 0),
    });
    stops.push(() => second.stop());
    second.start();
    await until(() => fresh.getState().session?.lastSeq === 5);
    expect(fresh.getState().session).toMatchObject({ paused: false, lead: { paused: true } });
  });

  it("stops retrying when the token is rejected", async () => {
    const store = createEngineStore();
    let attempts = 0;
    const controller = new EngineController({
      store,
      transport: new WebSocketTransport({
        connect: async () => {
          attempts += 1;
          throw new AuthRejectedError();
        },
        backoffMs: [5],
      }),
    });
    stops.push(() => controller.stop());
    controller.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(store.getState().connection).toBe("unauthorized");
    expect(attempts).toBe(1);
  });

  it("keeps exactly one live subscription when the selection flips quickly", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "ui-controller-"));
    dirs.push(projectPath);
    const server = createEngineRpcServer({ projectPath, engineVersion: "1.0.0-test", subscriptions: { pollMs: 5 } });
    const calls = { subscribe: 0, unsubscribe: 0 };
    const store = createEngineStore();
    const transport = new WebSocketTransport({
      backoffMs: [10],
      connect: async () => {
        const { client } = createInProcessTransport(server);
        // Count subscribe/unsubscribe requests on the wire.
        return {
          send(frame: string) {
            const method = (JSON.parse(frame) as { method?: string }).method;
            if (method === "events.subscribe") calls.subscribe += 1;
            if (method === "events.unsubscribe") calls.unsubscribe += 1;
            client.send(frame);
          },
          onMessage: (listener) => client.onMessage(listener),
          onClose: (listener) => client.onClose(listener),
          close: () => client.close(),
        };
      },
    });
    const controller = new EngineController({ store, transport, listIntervalMs: 1000, schedule: (flush) => setTimeout(flush, 0) });
    stops.push(() => controller.stop());

    const a = createId();
    const b = createId();
    for (const id of [a, b]) {
      const log = await EventLog.open(projectPath, id);
      stops.push(() => void log.close());
      await log.append({ type: "session.created", sessionId: id, data: { title: id } });
    }
    controller.start();

    store.getState().select(a);
    store.getState().select(b);
    store.getState().select(a);
    await until(() => store.getState().session?.id === a && store.getState().session!.lastSeq === 1);
    await new Promise((r) => setTimeout(r, 50));

    expect(calls.subscribe - calls.unsubscribe).toBe(1);
  });
});

describe("EngineController: hello failure", () => {
  it("retries engine.hello on an open link until it works", async () => {
    let hellos = 0;
    const transport = mockTransport({
      engineVersion: "2.0.0",
      handlers: {
        "engine.hello": () => {
          hellos += 1;
          if (hellos === 1) throw new Error("engine busy");
          return { engineVersion: "2.0.0", protocolVersion: 1, capabilities: [] };
        },
      },
    });
    const store = createEngineStore();
    const controller = new EngineController({ store, transport, helloRetryMs: [10] });
    stops.push(() => controller.stop());
    controller.start();
    await until(() => store.getState().connection === "connected");
    expect(hellos).toBe(2);
    expect(store.getState().engineVersion).toBe("2.0.0");
  });
});
