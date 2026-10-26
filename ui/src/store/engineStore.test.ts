import { describe, expect, it } from "vitest";
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
    expect(store.getState().session).toEqual({ id: "another-id", seats: {}, lastSeq: 0, eventCount: 0 });
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
});
