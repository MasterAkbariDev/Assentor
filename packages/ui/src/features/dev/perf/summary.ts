import type { CaseResult } from "./run.js";
import { spread, type PerfCase, type Spread } from "./stats.js";

export interface CaseSummary {
  case: PerfCase;
  /** Runs behind these numbers; 1 means no spread to speak of. */
  n: number;
  allComplete: boolean;
  fps: Spread;
  frameP95: Spread;
  maxFrameMs: Spread;
  janky: Spread;
  longTasks: Spread | null;
  heapPeakMb: Spread | null;
  applies: Spread;
  avgBatch: Spread;
  maxBatch: Spread;
  maxWaitMs: Spread;
  emitLagMs: Spread;
}

/** Groups repeated runs of the same case (in order of first appearance) into median + range. */
export function summarizeRuns(results: readonly CaseResult[]): CaseSummary[] {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    const key = `${r.case.seats}/${r.case.rate}/${r.case.coalesce}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const of = (f: (r: CaseResult) => number) => spread(g.map(f));
    return {
      case: g[0]!.case,
      n: g.length,
      allComplete: g.every((r) => r.complete),
      fps: of((r) => r.frames.fps),
      frameP95: of((r) => r.frames.p95),
      maxFrameMs: of((r) => r.frames.max),
      janky: of((r) => r.frames.janky),
      longTasks: g[0]!.longTasks ? of((r) => r.longTasks?.count ?? 0) : null,
      heapPeakMb: g[0]!.heap ? of((r) => r.heap?.peakMb ?? 0) : null,
      applies: of((r) => r.coalescer.applies),
      avgBatch: of((r) => r.coalescer.avgBatch),
      maxBatch: of((r) => r.coalescer.maxBatch),
      maxWaitMs: of((r) => r.coalescer.maxWaitMs),
      emitLagMs: of((r) => r.maxEmitLagMs),
    };
  });
}
