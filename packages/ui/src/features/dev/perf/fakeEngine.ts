import type { EngineEvent } from "#assentor/protocol/events.js";
import { burstFixture } from "../../../test/fixtures.js";

/**
 * Fake engine for the streaming perf harness (T05-02). `planStream` lays out, for a seed,
 * seats x rate events/s over a duration, as real protocol events with the offset (ms) at which
 * each one is due. `createEmitter` releases them against a clock. Nothing here touches the DOM.
 */

export interface StreamConfig {
  seats: number;
  /** Events per second, per seat. */
  rate: number;
  durationMs: number;
  seed: number;
}

export interface PlannedEvent {
  /** Due this many ms after the run starts. */
  tMs: number;
  event: EngineEvent;
}

export interface StreamPlan {
  sessionId: string;
  /** The `seat.spawned` events: applied before the run, not counted in `deltas`. */
  spawns: EngineEvent[];
  deltas: PlannedEvent[];
  counts: Record<"output" | "status" | "usage", number>;
}

const STATUSES = ["thinking", "writing", "tool", "editing", "waiting"] as const;
const WORDS = ["const", "await", "return", "session", "seat", "event", "if (", ") {", "=>", "store", "apply", "}"];

/** Small seeded PRNG (mulberry32): same seed, same sequence, in every engine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per seat, event k is: usage when k%20==19, status when k%10==9, else an output chunk. */
export function planStream(config: StreamConfig): StreamPlan {
  const { seats, rate, durationMs, seed } = config;
  const { id: sessionId, events: spawns } = burstFixture(seats, 0);
  const random = rng(seed);
  const perSeat = Math.round((rate * durationMs) / 1000);
  const gap = 1000 / rate;
  const at = new Date(Date.UTC(2026, 9, 25)).toISOString();
  const counts = { output: 0, status: 0, usage: 0 };
  const draft: Array<{ tMs: number; s: number; make: (seq: number) => EngineEvent }> = [];
  for (let s = 0; s < seats; s += 1) {
    const seatId = `seat-${s}`;
    let tokens = 0;
    for (let k = 0; k < perSeat; k += 1) {
      const tMs = k * gap + (s * gap) / seats; // seats are staggered, not in lockstep
      const base = { sessionId, seatId, at };
      if (k % 20 === 19) {
        counts.usage += 1;
        tokens += 40 + Math.floor(random() * 40);
        const out = tokens;
        draft.push({ tMs, s, make: (seq) => ({ ...base, seq, type: "seat.tokens", data: { tokensIn: 1200, tokensOut: out } }) as EngineEvent });
      } else if (k % 10 === 9) {
        counts.status += 1;
        const status = STATUSES[Math.floor(random() * STATUSES.length)]!;
        draft.push({ tMs, s, make: (seq) => ({ ...base, seq, type: "seat.status", data: { status } }) as EngineEvent });
      } else {
        counts.output += 1;
        const text = Array.from({ length: 2 + Math.floor(random() * 6) }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
        draft.push({ tMs, s, make: (seq) => ({ ...base, seq, type: "seat.output.delta", data: { text: `${text}\n` } }) as EngineEvent });
      }
    }
  }
  draft.sort((a, b) => a.tMs - b.tMs || a.s - b.s);
  let seq = spawns.length;
  return { sessionId, spawns, deltas: draft.map((d) => ({ tMs: d.tMs, event: d.make(++seq) })), counts };
}

/** Releases planned events as the clock advances. `tick(elapsedMs)` emits every event due and returns how many. */
export function createEmitter(plan: StreamPlan, emit: (event: EngineEvent) => void) {
  let next = 0;
  return {
    tick(elapsedMs: number): number {
      const start = next;
      while (next < plan.deltas.length && plan.deltas[next]!.tMs <= elapsedMs) emit(plan.deltas[next++]!.event);
      return next - start;
    },
    /** How far behind the clock the last emitted event was (ms). Grows when the main thread is saturated. */
    lagMs(elapsedMs: number): number {
      return next === 0 ? 0 : Math.max(0, elapsedMs - plan.deltas[next - 1]!.tMs);
    },
    get done() {
      return next >= plan.deltas.length;
    },
    get emitted() {
      return next;
    },
  };
}
