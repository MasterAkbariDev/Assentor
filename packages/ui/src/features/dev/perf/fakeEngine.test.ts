import { describe, expect, it } from "vitest";
import { parseEngineEvent } from "#assentor/protocol/events.js";
import { createEmitter, planStream, rng } from "./fakeEngine.js";

const cfg = { seats: 6, rate: 50, durationMs: 2000, seed: 7 };

describe("planStream", () => {
  it("emits seats x rate x duration events with the usage/status/output mix, deterministically", () => {
    const plan = planStream(cfg);
    expect(plan.spawns).toHaveLength(6);
    expect(plan.deltas).toHaveLength(600);
    // per seat of 100: k%20==19 -> 5 usage, k%10==9 -> 5 more status, 90 output
    expect(plan.counts).toEqual({ output: 540, status: 30, usage: 30 });
    expect(JSON.stringify(planStream(cfg).deltas)).toBe(JSON.stringify(plan.deltas));
    expect(JSON.stringify(planStream({ ...cfg, seed: 8 }).deltas)).not.toBe(JSON.stringify(plan.deltas));
  });

  it("orders events by time with contiguous seq numbers after the spawns", () => {
    const { spawns, deltas } = planStream(cfg);
    expect(deltas.map((d) => d.event.seq)).toEqual(Array.from({ length: 600 }, (_, i) => spawns.length + i + 1));
    expect(deltas.every((d, i) => i === 0 || deltas[i - 1]!.tMs <= d.tMs)).toBe(true);
    expect(deltas.at(-1)!.tMs).toBeLessThan(2000);
  });

  it("produces events the protocol parser accepts", () => {
    for (const d of planStream({ ...cfg, durationMs: 1000 }).deltas) expect(() => parseEngineEvent(d.event)).not.toThrow();
  });

  it("scales with seats and rate", () => {
    expect(planStream({ ...cfg, seats: 12, rate: 100, durationMs: 1000 }).deltas).toHaveLength(1200);
  });
});

describe("createEmitter", () => {
  it("releases only what is due and reports completion", () => {
    const plan = planStream(cfg);
    const got: number[] = [];
    const emitter = createEmitter(plan, (e) => got.push(e.seq));
    expect(emitter.tick(0)).toBe(1); // seat 0's first event is due at t=0
    const first = emitter.tick(100);
    expect(first).toBe(plan.deltas.filter((d) => d.tMs <= 100).length - 1);
    expect(emitter.lagMs(150)).toBeGreaterThan(0);
    expect(emitter.done).toBe(false);
    emitter.tick(10_000);
    expect(emitter.done).toBe(true);
    expect(got).toEqual(plan.deltas.map((d) => d.event.seq)); // in order, none dropped or repeated
    expect(emitter.tick(20_000)).toBe(0);
  });
});

describe("rng", () => {
  it("is repeatable and within [0,1)", () => {
    const a = rng(1), b = rng(1);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
