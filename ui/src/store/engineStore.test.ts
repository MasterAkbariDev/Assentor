import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@engine/protocol/events.js";
import { burstFixture, sessionFixture } from "../test/fixtures.js";
import { emptyLeadBoardView } from "@engine/ui-shared/lead.js";
import { ACTIVITY_EVENT_TYPES, createEngineStore, createFrameBatcher } from "./engineStore.js";

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
      reviewFindings: [],
      negotiationEvents: [],
      lead: emptyLeadBoardView(),
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
    // 300 status events for "a" (spawn is not an activity type); the last 200 are kept: seq 102..301.
    expect(seatEvents.a).toHaveLength(200);
    expect(seatEvents.a![0]!.seq).toBe(102);
    expect(seatEvents.a!.at(-1)!.seq).toBe(301);
    expect(seatEvents.a!.every((e) => ACTIVITY_EVENT_TYPES.has(e.type))).toBe(true);
    expect(seatEvents.b!.map((e) => e.seq)).toEqual([342]);
  });

  it("high-volume types the drawer does not show never evict its activity rows", () => {
    const id = "noise-run";
    const at = new Date(Date.UTC(2026, 9, 25, 10, 0, 0)).toISOString();
    const ev = (seq: number, type: string, data: object) => ({ seq, sessionId: id, seatId: "a", at, type, data }) as EngineEvent;
    const events: EngineEvent[] = [
      ev(1, "seat.status", { status: "starting" }),
      ev(2, "seat.status", { status: "thinking" }),
      ...Array.from({ length: 300 }, (_, i) => ev(3 + i, "seat.tokens", { tokensIn: 1, tokensOut: 1 })),
      ...Array.from({ length: 300 }, (_, i) => ev(303 + i, "seat.thinking", { text: `t${i}` })),
    ];
    const store = createEngineStore();
    store.getState().select(id);
    store.getState().applyEvents(id, events);

    const seatEvents = store.getState().session!.seatEvents;
    expect(seatEvents.a!.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.getState().session!.lastSeq).toBe(602);
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

  it("keeps only the last 1,000 negotiation events of a 1,100-event mixed batch, and no other types", () => {
    const id = "mixed-run";
    const store = createEngineStore();
    store.getState().select(id);
    const events: EngineEvent[] = [];
    for (let seq = 1; seq <= 1_100; seq += 1) {
      const at = new Date(Date.UTC(2026, 9, 25, 12, 0, 0, seq)).toISOString();
      // Every 22nd event is seat output; the rest are negotiation proposals (1,050 of them).
      events.push(
        seq % 22 === 0
          ? ({ seq, sessionId: id, seatId: "executor", at, type: "seat.output.delta", data: { text: "x\n" } } as EngineEvent)
          : ({ seq, sessionId: id, stageId: "debate-1", at, type: "negotiation.proposal", data: { round: 1, label: `Proposal ${seq}`, text: "t" } } as EngineEvent),
      );
    }
    store.getState().applyEvents(id, events);

    const session = store.getState().session!;
    const negotiationSeqs = events.filter((e) => e.type.startsWith("negotiation.")).map((e) => e.seq);
    expect(negotiationSeqs).toHaveLength(1_050);
    expect(session.negotiationEvents).toHaveLength(1_000);
    expect(session.negotiationEvents[0]!.seq).toBe(negotiationSeqs[negotiationSeqs.length - 1_000]);
    expect(session.negotiationEvents.at(-1)!.seq).toBe(negotiationSeqs[negotiationSeqs.length - 1]);
    expect(session.negotiationEvents.every((e) => e.type.startsWith("negotiation."))).toBe(true);
    // The rest of the batch still applies.
    expect(session.eventCount).toBe(1_100);
    expect(session.lastSeq).toBe(1_100);
  });
});
