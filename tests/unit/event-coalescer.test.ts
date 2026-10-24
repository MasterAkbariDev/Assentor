import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeltaCoalescer, type CoalescedDelta } from "../../src/index.js";

describe("createDeltaCoalescer", () => {
  let frames: CoalescedDelta[];

  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps order within a seat and emits different seats separately", () => {
    const coalescer = createDeltaCoalescer({ intervalMs: 40, emit: (d) => frames.push(d) });
    coalescer.push("a", "a1");
    coalescer.push("b", "b1");
    coalescer.push("a", "a2");
    coalescer.push("b", "b2");

    vi.advanceTimersByTime(40);

    expect(frames).toEqual([
      { seatId: "a", text: "a1a2" },
      { seatId: "b", text: "b1b2" },
    ]);
    coalescer.dispose();
  });

  it("batches many pushes within the interval into one emit", () => {
    const coalescer = createDeltaCoalescer({ intervalMs: 40, emit: (d) => frames.push(d) });
    for (let i = 0; i < 10; i += 1) {
      coalescer.push("a", String(i));
    }

    vi.advanceTimersByTime(39);
    expect(frames).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(frames).toEqual([{ seatId: "a", text: "0123456789" }]);
    coalescer.dispose();
  });

  it("emits immediately when a seat's buffer exceeds maxChars and cancels its timer", () => {
    const coalescer = createDeltaCoalescer({
      intervalMs: 40,
      maxChars: 10,
      emit: (d) => frames.push(d),
    });
    coalescer.push("a", "12345");
    expect(frames).toEqual([]);

    coalescer.push("a", "678901");
    expect(frames).toEqual([{ seatId: "a", text: "12345678901" }]);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(100);
    expect(frames).toHaveLength(1);
    coalescer.dispose();
  });

  it("flush(seatId) emits that seat now, and a second flush emits nothing", () => {
    const coalescer = createDeltaCoalescer({ intervalMs: 40, emit: (d) => frames.push(d) });
    coalescer.push("a", "x");
    coalescer.push("b", "y");

    coalescer.flush("a");
    expect(frames).toEqual([{ seatId: "a", text: "x" }]);

    coalescer.flush("a");
    expect(frames).toHaveLength(1);
    coalescer.dispose();
  });

  it("flush() with no id emits every seat's buffer", () => {
    const coalescer = createDeltaCoalescer({ intervalMs: 40, emit: (d) => frames.push(d) });
    coalescer.push("a", "x");
    coalescer.push("b", "y");

    coalescer.flush();
    expect(frames).toEqual([
      { seatId: "a", text: "x" },
      { seatId: "b", text: "y" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    coalescer.dispose();
  });

  it("never emits an empty buffer", () => {
    const coalescer = createDeltaCoalescer({ intervalMs: 40, emit: (d) => frames.push(d) });
    coalescer.push("a", "");
    expect(vi.getTimerCount()).toBe(0);

    coalescer.flush("a");
    coalescer.flush();
    vi.advanceTimersByTime(100);
    expect(frames).toEqual([]);
    coalescer.dispose();
  });

  it("dispose flushes all seats, leaves no timers, and rejects later pushes", () => {
    const coalescer = createDeltaCoalescer({ intervalMs: 40, emit: (d) => frames.push(d) });
    coalescer.push("a", "x");
    coalescer.push("b", "y");
    expect(vi.getTimerCount()).toBe(2);

    coalescer.dispose();
    expect(frames).toEqual([
      { seatId: "a", text: "x" },
      { seatId: "b", text: "y" },
    ]);
    expect(vi.getTimerCount()).toBe(0);

    expect(() => coalescer.push("a", "z")).toThrow("Delta coalescer is disposed");
    vi.advanceTimersByTime(100);
    expect(frames).toHaveLength(2);
  });

  it("uses injected timers when given", () => {
    const scheduled: Array<{ callback: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const coalescer = createDeltaCoalescer({
      intervalMs: 25,
      emit: (d) => frames.push(d),
      setTimer: (callback, ms) => {
        scheduled.push({ callback, ms });
        return scheduled.length;
      },
      clearTimer: (handle) => cleared.push(handle),
    });
    coalescer.push("a", "x");
    expect(scheduled.map((s) => s.ms)).toEqual([25]);

    scheduled[0]!.callback();
    expect(frames).toEqual([{ seatId: "a", text: "x" }]);
    coalescer.dispose();
  });
});
