// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { SessionBoard } from "./features/session-board/SessionBoard.js";
import { createFrameBatcher } from "./store/engineStore.js";
import { burstFixture } from "./test/fixtures.js";
import { mockTransport } from "./transport/mock.js";
import { renderWithStore } from "./test/render.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("acceptance: 6 seats x 50 events/s", () => {
  it("renders one second of traffic through transport, batcher and board without dropping an event", async () => {
    const { id, events } = burstFixture(6, 50);
    const spawned = events.slice(0, 6);
    const deltas = events.slice(6);
    const transport = mockTransport({ sessions: { [id]: spawned } });
    const { store, container } = renderWithStore(<SessionBoard />);
    vi.useFakeTimers();
    const batcher = createFrameBatcher(store, (flush) => setTimeout(flush, 16));
    act(() => store.getState().select(id));
    await transport.subscribe(id, 0, { onEvent: (event) => batcher.push(id, event) });

    for (let tick = 0; tick < 50; tick += 1) {
      // every 20 ms each of the 6 seats emits one event
      for (const event of deltas.slice(tick * 6, tick * 6 + 6)) transport.emit(event);
      act(() => void vi.advanceTimersByTime(20));
    }
    act(() => void vi.advanceTimersByTime(20));

    const session = store.getState().session!;
    expect(session.eventCount).toBe(events.length);
    expect(session.lastSeq).toBe(events.at(-1)!.seq);
    const lines = Array.from(container.querySelectorAll(".seat-card-line")).map((el) => el.textContent);
    expect(lines).toEqual(Array(6).fill("line 49"));
  });
});
