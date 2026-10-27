import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@engine/protocol/events.js";
import { burstFixture, sessionFixture } from "../test/fixtures.js";
import { createEngineStore, createFrameBatcher } from "./engineStore.js";

describe("engine store", () => {
  it("reconstructs identical state when a stream is replayed after a mid-stream reload", () => {
    const { id, events } = sessionFixture;
    const whole = createEngineStore();
    whole.getState().select(id);
    whole.getState().applyEvents(id, events);

    // "Reload": a new store applies the first half, then resubscribes from lastSeq.
    const reloaded = createEngineStore();
    reloaded.getState().select(id);
    const half = Math.floor(events.length / 2);
    reloaded.getState().applyEvents(id, events.slice(0, half));
    const fromSeq = reloaded.getState().session!.lastSeq;
    // The server sends seq > fromSeq; a resend of seen events must be ignored too.
    reloaded.getState().applyEvents(id, events.filter((e) => e.seq > fromSeq - 2));

    expect(reloaded.getState().session).toEqual(whole.getState().session);
    const seats = whole.getState().session!.seats;
    expect(Object.keys(seats).sort()).toEqual(["executor", "panel", "reviewer-1", "reviewer-2"]);
    expect(seats.executor!.status).toBe("done");
    expect(seats["reviewer-2"]!.status).toBe("failed");
    expect(whole.getState().session!.state).toBe("REVIEWING");
  });

  it("ignores events for another session and resets when the selection changes", () => {
    const store = createEngineStore();
    store.getState().select(sessionFixture.id);
    store.getState().applyEvents("other", sessionFixture.events);
    expect(store.getState().session!.eventCount).toBe(0);
    store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
    store.getState().select("another-id");
    expect(store.getState().session).toEqual({
      id: "another-id",
      seats: {},
      seatInfo: {},
      seatEvents: {},
      lastSeq: 0,
      eventCount: 0,
    });
  });

  it("keeps each seat's spawn info and closes the drawer when the run changes", () => {
    const { id, events } = sessionFixture;
    const store = createEngineStore();
    store.getState().select(id);
    store.getState().applyEvents(id, events);
    expect(store.getState().session!.seatInfo.executor).toEqual({ provider: "mock", transport: "api", permissions: "edit" });
    expect(store.getState().session!.seatInfo["reviewer-1"]!.permissions).toBe("read-only");

    store.getState().openSeat("executor");
    store.getState().select(id); // same run: the drawer stays open
    expect(store.getState().openSeatId).toBe("executor");
    store.getState().select("another-id");
    expect(store.getState().openSeatId).toBeUndefined();
  });

  it("keeps the last 200 non-delta events per seat, in order, and only that seat's", () => {
    const id = "cap-run";
    let seq = 0;
    const at = new Date(Date.UTC(2026, 9, 25, 10, 0, 0)).toISOString();
    const ev = (seatId: string, type: string, data: object) => ({ seq: ++seq, sessionId: id, seatId, at, type, data }) as EngineEvent;
    const events: EngineEvent[] = [
      ev("a", "seat.spawned", { displayName: "A", provider: "mock", transport: "api", model: "AUTO", role: "r", permissions: "edit" }),
      ...Array.from({ length: 300 }, (_, i) => ev("a", "seat.status", { status: i % 2 ? "writing" : "thinking" })),
      ...Array.from({ length: 40 }, () => ev("a", "seat.output.delta", { text: "x" })),
      ev("b", "seat.status", { status: "writing" }),
    ];
    const store = createEngineStore();
    store.getState().select(id);
    store.getState().applyEvents(id, events);

    const seatEvents = store.getState().session!.seatEvents;
    // 301 non-delta events for "a" (spawn + 300 statuses); the last 200 are kept.
    expect(seatEvents.a).toHaveLength(200);
    expect(seatEvents.a![0]!.seq).toBe(102);
    expect(seatEvents.a!.at(-1)!.seq).toBe(301);
    expect(seatEvents.a!.every((e) => e.type !== "seat.output.delta")).toBe(true);
    expect(seatEvents.b!.map((e) => e.seq)).toEqual([342]);
  });

  it("a mid-stream reload rebuilds identical seat info and capped seat events", () => {
    const id = "cap-replay";
    const at = new Date(Date.UTC(2026, 9, 25, 10, 0, 0)).toISOString();
    const events = [
      { seq: 1, sessionId: id, seatId: "a", at, type: "seat.spawned", data: { displayName: "A", provider: "mock", transport: "cli", model: "AUTO", role: "r", permissions: "read-only" } },
      ...Array.from({ length: 260 }, (_, i) => ({ seq: i + 2, sessionId: id, seatId: "a", at, type: "seat.status", data: { status: i % 2 ? "writing" : "thinking" } })),
    ] as EngineEvent[];
    const whole = createEngineStore();
    whole.getState().select(id);
    whole.getState().applyEvents(id, events);

    const reloaded = createEngineStore();
    reloaded.getState().select(id);
    reloaded.getState().applyEvents(id, events.slice(0, 100));
    const fromSeq = reloaded.getState().session!.lastSeq;
    reloaded.getState().applyEvents(id, events.filter((e) => e.seq > fromSeq - 2));

    expect(reloaded.getState().session).toEqual(whole.getState().session);
    expect(reloaded.getState().session!.seatInfo.a).toEqual({ provider: "mock", transport: "cli", permissions: "read-only" });
    expect(reloaded.getState().session!.seatEvents.a).toHaveLength(200);
  });

  it("applies a 6-seat × 50-event burst per frame without dropping events", () => {
    const { id, events } = burstFixture(6, 50);
    const store = createEngineStore();
    store.getState().select(id);
    const frames: Array<() => void> = [];
    const batcher = createFrameBatcher(store, (flush) => frames.push(flush));
    let renders = 0;
    store.subscribe(() => (renders += 1));

    for (const event of events) {
      batcher.push(id, event);
    }
    expect(frames).toHaveLength(1); // one frame scheduled for the whole burst
    frames.shift()!();
    expect(renders).toBe(1);
    const session = store.getState().session!;
    expect(session.eventCount).toBe(events.length);
    expect(session.lastSeq).toBe(events.at(-1)!.seq);
    expect(session.seats["seat-3"]!.lastLine).toBe("line 49");
  });

  it("stays bounded when frames never run (hidden tab)", () => {
    const { id, events } = burstFixture(5, 500);
    const store = createEngineStore();
    store.getState().select(id);
    const batcher = createFrameBatcher(store, () => undefined, 1000);

    for (const event of events) {
      batcher.push(id, event);
    }

    // 2,500 events with a cap of 1,000: two forced applies, 500 still waiting.
    expect(store.getState().session!.eventCount).toBe(2000);
    batcher.flush();
    expect(store.getState().session!.eventCount).toBe(events.length);
  });
});
