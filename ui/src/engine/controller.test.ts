import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createId } from "@engine/core/ids.js";
import { EventLog } from "@engine/events/log.js";
import { createEngineRpcServer } from "@engine/rpc/engine.js";
import { createInProcessTransport } from "@engine/rpc/transports.js";
import type { RpcClientTransport } from "@engine/rpc/browser.js";
import { createEngineStore } from "../store/engineStore.js";
import { AuthRejectedError } from "../transport/websocket.js";
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
  const controller = new EngineController({
    store,
    connect: async () => {
      const { client } = createInProcessTransport(server);
      transports.push(client);
      return client;
    },
    listIntervalMs: 20,
    backoffMs: [10],
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

    await controller.start();
    expect(store.getState().connection).toBe("connected");
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
    await controller.start();
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

  it("stops retrying when the token is rejected", async () => {
    const store = createEngineStore();
    let attempts = 0;
    const controller = new EngineController({
      store,
      connect: async () => {
        attempts += 1;
        throw new AuthRejectedError();
      },
      backoffMs: [5],
    });
    stops.push(() => controller.stop());
    await controller.start();
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
    const controller = new EngineController({
      store,
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
      listIntervalMs: 1000,
      backoffMs: [10],
      schedule: (flush) => setTimeout(flush, 0),
    });
    stops.push(() => controller.stop());

    const a = createId();
    const b = createId();
    for (const id of [a, b]) {
      const log = await EventLog.open(projectPath, id);
      stops.push(() => void log.close());
      await log.append({ type: "session.created", sessionId: id, data: { title: id } });
    }
    await controller.start();

    store.getState().select(a);
    store.getState().select(b);
    store.getState().select(a);
    await until(() => store.getState().session?.id === a && store.getState().session!.lastSeq === 1);
    await new Promise((r) => setTimeout(r, 50));

    expect(calls.subscribe - calls.unsubscribe).toBe(1);
  });
});
