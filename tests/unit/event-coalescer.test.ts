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

  it("uses injected timers and clears them on flush and on overflow", () => {
    const scheduled: Array<{ callback: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const coalescer = createDeltaCoalescer({
      intervalMs: 25,
      maxChars: 4,
      emit: (d) => frames.push(d),
      setTimer: (callback, ms) => {
        scheduled.push({ callback, ms });
        return scheduled.length;
      },
      clearTimer: (handle) => {
        cleared.push(handle);
      },
    });

    coalescer.push("a", "xy");
    expect(scheduled.map((s) => s.ms)).toEqual([25]);
    coalescer.flush("a");
    expect(frames).toEqual([{ seatId: "a", text: "xy" }]);
    expect(cleared).toEqual([1]);

    coalescer.push("b", "xy");
    coalescer.push("b", "zzzz");
    expect(frames).toHaveLength(2);
    expect(cleared).toEqual([1, 2]);
    coalescer.dispose();
  });

  it("routes a timer-path emit error to onError without throwing", () => {
    const boom = new Error("disk full");
    const errors: Array<[unknown, string]> = [];
    const coalescer = createDeltaCoalescer({
      intervalMs: 40,
      emit: () => {
        throw boom;
      },
      onError: (error, seatId) => errors.push([error, seatId]),
    });
    coalescer.push("a", "x");

    expect(() => vi.advanceTimersByTime(40)).not.toThrow();
    expect(errors).toEqual([[boom, "a"]]);
    expect(vi.getTimerCount()).toBe(0);
    coalescer.dispose();
  });

  it("logs a timer-path emit error to stderr by default", () => {
    const boom = new Error("disk full");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const coalescer = createDeltaCoalescer({
        intervalMs: 40,
        emit: () => {
          throw boom;
        },
      });
      coalescer.push("seat-1", "x");
      expect(() => vi.advanceTimersByTime(40)).not.toThrow();
      expect(spy).toHaveBeenCalledWith(
        "[assentor] delta coalescer emit failed for seat-1:",
        boom,
      );
      coalescer.dispose();
    } finally {
      spy.mockRestore();
    }
  });

  it("routes a rejected Promise from emit on the timer path to onError", async () => {
    const boom = new Error("write failed");
    const errors: Array<[unknown, string]> = [];
    const coalescer = createDeltaCoalescer({
      intervalMs: 40,
      emit: () => Promise.reject(boom),
      onError: (error, seatId) => errors.push([error, seatId]),
    });
    coalescer.push("a", "x");

    vi.advanceTimersByTime(40);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([[boom, "a"]]);
    coalescer.dispose();
  });

  it("routes a rejected Promise on an explicit flush to onError instead of the caller", async () => {
    const boom = new Error("write failed");
    const errors: Array<[unknown, string]> = [];
    const coalescer = createDeltaCoalescer({
      intervalMs: 40,
      emit: () => Promise.reject(boom),
      onError: (error, seatId) => errors.push([error, seatId]),
    });
    coalescer.push("a", "x");

    expect(() => coalescer.flush("a")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([[boom, "a"]]);
    coalescer.dispose();
  });

  it("dispose still flushes other seats, clears timers, then throws and rejects later pushes", () => {
    const emitted: CoalescedDelta[] = [];
    const coalescer = createDeltaCoalescer({
      intervalMs: 40,
      emit: (d) => {
        if (d.seatId === "bad") {
          throw new Error("boom");
        }
        emitted.push(d);
      },
    });
    coalescer.push("bad", "x");
    coalescer.push("good", "y");

    expect(() => coalescer.dispose()).toThrow("boom");
    expect(emitted).toEqual([{ seatId: "good", text: "y" }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => coalescer.push("a", "z")).toThrow("Delta coalescer is disposed");
  });

  it("dispose throws an AggregateError when several seats fail", () => {
    const coalescer = createDeltaCoalescer({
      intervalMs: 40,
      emit: (d) => {
        throw new Error(d.seatId);
      },
    });
    coalescer.push("a", "x");
    coalescer.push("b", "y");

    let caught: unknown;
    try {
      coalescer.dispose();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e) => (e as Error).message)).toEqual(["a", "b"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
