/** Pure math for the perf harness (T05-02). Times are ms. */

/** Nearest-rank percentile of `values` (`p` in 0..100). 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface FrameStats {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames that took longer than 2 refresh intervals (~33 ms at 60 Hz). */
  janky: number;
}

/** From requestAnimationFrame timestamps, ascending. fps = frames over the first-to-last span. */
export function frameStats(timestamps: readonly number[], jankMs = 33.4): FrameStats {
  const deltas = timestamps.slice(1).map((t, i) => t - timestamps[i]!);
  const span = deltas.reduce((a, b) => a + b, 0);
  return {
    frames: deltas.length,
    fps: span > 0 ? (deltas.length * 1000) / span : 0,
    p50: percentile(deltas, 50),
    p95: percentile(deltas, 95),
    p99: percentile(deltas, 99),
    max: deltas.length ? Math.max(...deltas) : 0,
    janky: deltas.filter((d) => d > jankMs).length,
  };
}

export interface LongTaskStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

export function longTaskStats(durations: readonly number[]): LongTaskStats {
  return { count: durations.length, totalMs: durations.reduce((a, b) => a + b, 0), maxMs: durations.length ? Math.max(...durations) : 0 };
}

/** Heap samples in bytes -> MB at start, end and peak. */
export function heapStats(samples: readonly number[]) {
  const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
  return samples.length === 0
    ? undefined
    : { startMb: mb(samples[0]!), endMb: mb(samples.at(-1)!), peakMb: mb(Math.max(...samples)) };
}

export interface CoalescerStats {
  pushed: number;
  applies: number;
  avgBatch: number;
  maxBatch: number;
  /** Longest an event waited between push and apply (ms). */
  maxWaitMs: number;
}

/** `batches`: events per apply; `waits`: oldest-event wait per apply. */
export function coalescerStats(pushed: number, batches: readonly number[], waits: readonly number[]): CoalescerStats {
  return {
    pushed,
    applies: batches.length,
    avgBatch: batches.length ? Math.round((batches.reduce((a, b) => a + b, 0) / batches.length) * 10) / 10 : 0,
    maxBatch: batches.length ? Math.max(...batches) : 0,
    maxWaitMs: waits.length ? Math.round(Math.max(...waits) * 10) / 10 : 0,
  };
}

export type CoalesceMode = "raf" | number;

export interface PerfCase {
  seats: number;
  rate: number;
  coalesce: CoalesceMode;
}

export interface PerfParams {
  /** Each case, `repeat` times in a row. */
  cases: PerfCase[];
  repeat: number;
  durationMs: number;
  seed: number;
  autorun: boolean;
}

/** Comma list of positive numbers, or `fallback` when absent. Throws on junk, so a typo can't silently run the default. */
function list(raw: string | null, fallback: number[]): number[] {
  if (raw === null || raw === "") return fallback;
  const out = raw.split(",").map((s) => Number(s));
  if (out.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error(`bad number list "${raw}"`);
  return out;
}

/** `?seats=6,24&rate=50,200&coalesce=raf,100&duration=5&seed=1&autorun=1` -> the cartesian product of cases. */
export function parsePerfParams(search: string): PerfParams {
  const q = new URLSearchParams(search);
  const coalesceRaw = q.get("coalesce");
  const coalesce: CoalesceMode[] = coalesceRaw
    ? coalesceRaw.split(",").map((s) => (s === "raf" ? "raf" : list(s, [])[0]!))
    : ["raf"];
  const cases: PerfCase[] = [];
  for (const seats of list(q.get("seats"), [6]))
    for (const rate of list(q.get("rate"), [50]))
      for (const c of coalesce) cases.push({ seats, rate, coalesce: c });
  return { cases, repeat: list(q.get("repeat"), [1])[0]!, durationMs: list(q.get("duration"), [10])[0]! * 1000, seed: list(q.get("seed"), [1])[0]!, autorun: q.get("autorun") === "1" };
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export interface Spread {
  median: number;
  min: number;
  max: number;
}

/** Median and range of one metric over repeated runs of the same case. `n` is shown next to it so n=1 is visible. */
export function spread(values: readonly number[]): Spread {
  const r = (n: number) => Math.round(n * 10) / 10;
  return values.length === 0 ? { median: 0, min: 0, max: 0 } : { median: r(median(values)), min: r(Math.min(...values)), max: r(Math.max(...values)) };
}
