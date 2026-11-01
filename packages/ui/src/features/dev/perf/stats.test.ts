import { describe, expect, it } from "vitest";
import { spread, coalescerStats, frameStats, heapStats, longTaskStats, parsePerfParams, percentile } from "./stats.js";

describe("percentile", () => {
  it("uses nearest rank", () => {
    const v = [5, 1, 4, 2, 3];
    expect([percentile(v, 50), percentile(v, 95), percentile(v, 100), percentile(v, 0)]).toEqual([3, 5, 5, 1]);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("frameStats", () => {
  it("is 60 fps for steady 16.67 ms frames", () => {
    const stamps = Array.from({ length: 61 }, (_, i) => (i * 1000) / 60);
    const s = frameStats(stamps);
    expect(s.frames).toBe(60);
    expect(s.fps).toBeCloseTo(60, 5);
    expect(s.janky).toBe(0);
  });
  it("counts a long frame as janky and lowers fps", () => {
    const s = frameStats([0, 16, 32, 132, 148]);
    expect(s.janky).toBe(1);
    expect(s.max).toBe(100);
    expect(s.fps).toBeCloseTo(4000 / 148, 5);
  });
  it("is zero with fewer than two timestamps", () => {
    expect(frameStats([5]).fps).toBe(0);
  });
});

describe("other stats", () => {
  it("long tasks, heap, coalescer", () => {
    expect(longTaskStats([50, 120, 70])).toEqual({ count: 3, totalMs: 240, maxMs: 120 });
    expect(longTaskStats([])).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    expect(heapStats([10 * 1048576, 30 * 1048576, 20 * 1048576])).toEqual({ startMb: 10, endMb: 20, peakMb: 30 });
    expect(heapStats([])).toBeUndefined();
    expect(coalescerStats(600, [100, 200, 300], [4, 18.26, 9])).toEqual({ pushed: 600, applies: 3, avgBatch: 200, maxBatch: 300, maxWaitMs: 18.3 });
  });
});

describe("parsePerfParams", () => {
  it("defaults to 6 seats at 50/s, rAF, 10 s", () => {
    expect(parsePerfParams("")).toEqual({ cases: [{ seats: 6, rate: 50, coalesce: "raf" }], repeat: 1, durationMs: 10_000, seed: 1, autorun: false });
  });
  it("builds the cartesian product", () => {
    const p = parsePerfParams("?seats=6,12&rate=50&coalesce=raf,100&duration=3&seed=9&autorun=1");
    expect(p.cases).toEqual([
      { seats: 6, rate: 50, coalesce: "raf" }, { seats: 6, rate: 50, coalesce: 100 },
      { seats: 12, rate: 50, coalesce: "raf" }, { seats: 12, rate: 50, coalesce: 100 },
    ]);
    expect([p.durationMs, p.seed, p.autorun]).toEqual([3000, 9, true]);
  });
  it("rejects junk instead of running the default", () => {
    expect(() => parsePerfParams("?rate=fast")).toThrow(/bad number list/);
    expect(() => parsePerfParams("?seats=0")).toThrow();
  });
});

describe("spread", () => {
  it("is median and range", () => {
    expect(spread([58, 60, 60.04])).toEqual({ median: 60, min: 58, max: 60 });
    expect(spread([3, 1, 2, 10, 4])).toEqual({ median: 3, min: 1, max: 10 });
    expect(spread([])).toEqual({ median: 0, min: 0, max: 0 });
  });
  it("parses repeat", () => {
    expect(parsePerfParams("?repeat=3").repeat).toBe(3);
  });
});
