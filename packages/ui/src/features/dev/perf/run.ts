import { createFrameBatcher, type EngineStore } from "../../../store/engineStore.js";
import { createEngineStore } from "../../../store/engineStore.js";
import { mockTransport } from "../../../transport/mock.js";
import { coalescerStats, frameStats, heapStats, longTaskStats, type CoalescerStats, type FrameStats, type LongTaskStats, type PerfCase } from "./stats.js";
import { createEmitter, planStream } from "./fakeEngine.js";

/** Runs one case against the real store, frame batcher and Session board. Browser only. */

export interface CaseResult {
  case: PerfCase;
  planned: number;
  emitted: number;
  /** Events the store ended with, spawns included; `complete` when it equals `planned` + spawns. */
  applied: number;
  complete: boolean;
  maxEmitLagMs: number;
  hidden: boolean;
  frames: FrameStats;
  /** Absent where the engine has no Long Tasks API (WebKit). */
  longTasks: LongTaskStats | null;
  /** Absent where the engine has no `performance.memory` (WebKit, Gecko). */
  heap: ReturnType<typeof heapStats> | null;
  coalescer: CoalescerStats;
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function supports() {
  return {
    longtask: typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("longtask"),
    heap: "memory" in performance,
  };
}

/** `mount` renders the Session board on `store` and resolves once it is in the DOM; `mount(null)` removes it. */
export async function measureCase(
  c: PerfCase,
  opts: { durationMs: number; seed: number },
  mount: (store: EngineStore | null) => Promise<void>,
): Promise<CaseResult> {
  const plan = planStream({ seats: c.seats, rate: c.rate, durationMs: opts.durationMs, seed: opts.seed });
  const store = createEngineStore();
  store.getState().select(plan.sessionId);
  store.getState().setSessions([{ id: plan.sessionId, title: "perf", hasLiveLog: true, lastSeq: 0 }]);
  await mount(store);
  await sleep(300); // let first paint and style recalculation settle so they don't land in the measurement

  // Coalescer: the real batcher; only the schedule is ours (`raf` = the app's default path).
  let pushed = 0;
  const pendingSince: number[] = [];
  const batches: number[] = [];
  const waits: number[] = [];
  // The batcher cancels the pending callback on a manual flush, so these return their cancellers.
  const schedule = (f: () => void) => {
    if (c.coalesce === "raf") {
      const id = requestAnimationFrame(f);
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(f, c.coalesce);
    return () => clearTimeout(id);
  };
  const batcher = createFrameBatcher(store, schedule);
  let lastCount = 0;
  const offApply = store.subscribe((s) => {
    const count = s.session?.eventCount ?? 0;
    if (count === lastCount) return;
    batches.push(count - lastCount);
    waits.push(performance.now() - (pendingSince[lastCount] ?? performance.now()));
    lastCount = count;
  });

  const transport = mockTransport({ sessions: { [plan.sessionId]: plan.spawns } });
  await transport.subscribe(plan.sessionId, 0, {
    onEvent: (event) => {
      pendingSince[pushed++] = performance.now();
      batcher.push(plan.sessionId, event);
    },
  });
  batcher.flush();
  await nextFrame();

  const longTasks: number[] = [];
  const support = supports();
  const observer = support.longtask ? new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration))) : undefined;
  observer?.observe({ type: "longtask", buffered: false });
  const heap: number[] = [];
  const sampleHeap = () => support.heap && heap.push((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize);
  sampleHeap();
  const heapTimer = setInterval(sampleHeap, 500);
  const stamps: number[] = [];
  let measuring = true;
  const frameLoop = (t: number) => {
    stamps.push(t);
    if (measuring) requestAnimationFrame(frameLoop);
  };
  requestAnimationFrame(frameLoop);

  const emitter = createEmitter(plan, (event) => transport.emit(event));
  const t0 = performance.now();
  let maxLag = 0;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const elapsed = performance.now() - t0;
      emitter.tick(elapsed);
      maxLag = Math.max(maxLag, emitter.lagMs(elapsed));
      if (emitter.done) {
        clearInterval(timer);
        resolve();
      }
    }, 4);
  });
  measuring = false;
  const frames = frameStats(stamps);
  sampleHeap();
  clearInterval(heapTimer);
  observer?.takeRecords().forEach((e) => longTasks.push(e.duration));
  observer?.disconnect();
  await sleep(c.coalesce === "raf" ? 100 : c.coalesce + 100);
  batcher.flush();
  offApply();
  const applied = store.getState().session?.eventCount ?? 0;
  await transport.close();
  await mount(null);

  return {
    case: c,
    planned: plan.deltas.length,
    emitted: emitter.emitted,
    applied,
    complete: applied === plan.deltas.length + plan.spawns.length,
    maxEmitLagMs: Math.round(maxLag),
    hidden: document.hidden,
    frames,
    longTasks: support.longtask ? longTaskStats(longTasks) : null,
    heap: support.heap ? heapStats(heap) : null,
    coalescer: coalescerStats(pushed, batches, waits),
  };
}
