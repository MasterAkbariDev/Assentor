import { describe, expect, it } from "vitest";
import { expandSeatSpecs, parseAssentorConfig, type EngineEventDraft, type Seat } from "../../src/index.js";
import { SeatScheduler, classifyRateLimit, createSeatScheduler, type JobContext } from "../../src/seats/index.js";

/** Deterministic clock: timers fire only on `advance`, in time order. */
class FakeClock {
  t = 0;
  private timers: Array<{ at: number; id: number; fn: () => void }> = [];
  private nextId = 1;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, id, fn });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A job that waits until released, recording concurrency. */
function gate() {
  let open!: () => void;
  let failWith!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    open = resolve;
    failWith = reject;
  });
  return { done, open: () => open(), fail: (error: Error) => failWith(error) };
}

function setup(overrides: Partial<ConstructorParameters<typeof SeatScheduler>[0]> = {}) {
  const clock = new FakeClock();
  const events: EngineEventDraft[] = [];
  const scheduler = new SeatScheduler({
    sessionId: "s",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5, // jitter factor 1
    emit: (e) => events.push(e),
    ...overrides,
  });
  return { clock, events, scheduler };
}

const claude = (n: number, budget?: Seat["budget"]) =>
  expandSeatSpecs([{ provider: "claude-code", model: "opus", count: n, ...(budget ? { budget } : {}) }]);
const gemini = (n: number) => expandSeatSpecs([{ provider: "gemini", count: n }]);

describe("admission", () => {
  it("respects per-provider and global caps and admits FIFO per provider", async () => {
    const { scheduler } = setup({ globalConcurrency: 5 });
    // count is capped at 8 per spec; two specs give 16 CLI seats.
    const cliSeats = expandSeatSpecs([
      { provider: "claude-code", model: "opus", count: 8 },
      { provider: "claude-code", model: "opus", count: 2 },
    ]);
    const seats = [...cliSeats, ...gemini(8)];
    let live = { cli: 0, api: 0, all: 0 };
    let peak = { cli: 0, api: 0, all: 0 };
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const outcomes = seats.map((seat) =>
      scheduler.run(seat, async () => {
        const kind = seat.provider === "gemini" ? "api" : "cli";
        started.push(seat.id);
        live = { ...live, [kind]: live[kind] + 1, all: live.all + 1 };
        peak = { cli: Math.max(peak.cli, live.cli), api: Math.max(peak.api, live.api), all: Math.max(peak.all, live.all) };
        const g = gate();
        gates.set(seat.id, g);
        await g.done;
        live = { ...live, [kind]: live[kind] - 1, all: live.all - 1 };
        return seat.id;
      }),
    );
    await flush();
    // Release in start order until everything ran.
    while (gates.size > 0) {
      const [id, g] = [...gates.entries()][0]!;
      gates.delete(id);
      g.open();
      await flush();
    }
    const results = await Promise.all(outcomes);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak.cli).toBeLessThanOrEqual(2);
    expect(peak.api).toBeLessThanOrEqual(4);
    expect(peak.all).toBeLessThanOrEqual(5);
    const order = (provider: string) => started.filter((id) => id.startsWith(provider));
    expect(order("opus")).toEqual(cliSeats.map((s) => s.id));
    expect(order("gemini")).toEqual(gemini(8).map((s) => s.id));
    expect(scheduler.runningCount).toBe(0);
    expect(scheduler.queuedCount).toBe(0);
  });

  it("marks waiting seats queued", async () => {
    const { scheduler, events } = setup();
    const g = gate();
    const [a, b, c] = claude(3);
    const runs = [a!, b!, c!].map((seat) => scheduler.run(seat, () => g.done));
    await flush();
    expect(events.filter((e) => e.type === "seat.status").map((e) => e.seatId)).toEqual(["opus-1", "opus-2", "opus-3"]);
    g.open();
    await Promise.all(runs);
  });

  it("uses configured caps from config limits", async () => {
    const config = parseAssentorConfig({ limits: { concurrency: { "claude-code": 1 }, globalConcurrency: 3, session: { maxTokens: 100 } } });
    expect(config.limits.concurrency).toEqual({ "claude-code": 1 });
    const scheduler = createSeatScheduler(config.limits, { sessionId: "s" });
    let live = 0;
    let peak = 0;
    const runs = claude(3).map((seat) =>
      scheduler.run(seat, async () => {
        live += 1;
        peak = Math.max(peak, live);
        await flush();
        live -= 1;
      }),
    );
    await Promise.all(runs);
    expect(peak).toBe(1);
  });
});

describe("rate limits", () => {
  it("backs off with the provider cooled down, then retries", async () => {
    const { scheduler, clock, events } = setup({ backoffBaseMs: 2000 });
    const [seat] = claude(1);
    const [other] = claude(2).slice(1);
    let calls = 0;
    const outcome = scheduler.run(seat!, async (ctx: JobContext) => {
      calls += 1;
      if (ctx.attempt === 1) throw new Error("429 Too Many Requests");
      return "ok";
    });
    await flush();
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "seat.status" && e.data.status === "rate_limited")).toBe(true);

    // Same provider is cooling down: a new job waits too.
    let otherStarted = false;
    const otherRun = scheduler.run(other!, async () => {
      otherStarted = true;
    });
    await clock.advance(1999);
    expect(calls).toBe(1);
    expect(otherStarted).toBe(false);
    await clock.advance(1);
    const result = await outcome;
    expect(result).toMatchObject({ ok: true, value: "ok", attempts: 2 });
    await otherRun;
    expect(otherStarted).toBe(true);
  });

  it("honours retryAfterMs and gives up after maxAttempts", async () => {
    const { scheduler, clock } = setup({ backoffBaseMs: 1000, maxAttempts: 2 });
    const [seat] = claude(1);
    const error = Object.assign(new Error("rate limit"), { retryAfterMs: 30_000 });
    let calls = 0;
    const outcome = scheduler.run(seat!, async () => {
      calls += 1;
      throw error;
    });
    await flush(); // let the first attempt fail before time moves
    await clock.advance(29_999);
    expect(calls).toBe(1);
    await clock.advance(1);
    expect(await outcome).toMatchObject({ ok: false, reason: "rate_limited", scope: "seat", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("does not retry other errors", async () => {
    const { scheduler } = setup();
    const [seat] = claude(1);
    expect(await scheduler.run(seat!, async () => { throw new Error("auth failed"); })).toMatchObject({
      ok: false,
      reason: "error",
      error: "auth failed",
      attempts: 1,
    });
  });

  it("classifies rate-limit wording", () => {
    expect(classifyRateLimit(new Error("HTTP 429"))).toEqual({ rateLimited: true });
    expect(classifyRateLimit(new Error("model overloaded, try later"))).toEqual({ rateLimited: true });
    expect(classifyRateLimit(new Error("timeout"))).toEqual({ rateLimited: false });
  });
});

describe("budgets", () => {
  it("warns at 80%, stops the seat at 100% and leaves others running", async () => {
    const { scheduler, events } = setup();
    const [tight] = claude(1, { maxTokens: 100 });
    const [free] = gemini(1);
    let aborted = false;
    const g = gate();
    const tightRun = scheduler.run(tight!, async (ctx) => {
      ctx.reportUsage({ tokensIn: 85 });
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
        g.fail(new Error("stopped"));
      });
      ctx.reportUsage({ tokensOut: 20 });
      await g.done;
    });
    const freeRun = scheduler.run(free!, async () => "fine");
    expect(await tightRun).toMatchObject({ ok: false, reason: "budget", scope: "seat" });
    expect(aborted).toBe(true);
    expect(await freeRun).toMatchObject({ ok: true });
    const kinds = events.filter((e) => e.type.startsWith("budget.")).map((e) => [e.type, (e.data as { kind: string }).kind]);
    expect(kinds).toEqual([
      ["budget.warning", "seat.tokens"],
      ["budget.exceeded", "seat.tokens"],
    ]);
  });

  it("a session budget stops every seat and refuses new jobs", async () => {
    const { scheduler } = setup({ sessionBudget: { maxCostUsd: 1 } });
    const [a, b] = claude(2);
    const g = gate();
    const runB = scheduler.run(b!, async (ctx) => {
      ctx.signal.addEventListener("abort", () => g.fail(new Error("stopped")));
      await g.done;
    });
    const runA = scheduler.run(a!, async (ctx) => {
      ctx.reportUsage({ costUsd: 1.5 });
    });
    expect(await runA).toMatchObject({ ok: false, reason: "budget", scope: "session" });
    expect(await runB).toMatchObject({ ok: false, reason: "budget", scope: "session" });
    expect(await scheduler.run(a!, async () => "late")).toMatchObject({ ok: false, reason: "budget", scope: "session" });
    expect(scheduler.runningCount).toBe(0);
  });

  it("enforces the runtime budget while a job runs", async () => {
    const { scheduler, clock, events } = setup();
    const [seat] = claude(1, { maxRuntimeMinutes: 1 });
    let aborted = false;
    const run = scheduler.run(seat!, (ctx) => {
      return new Promise<void>((_, reject) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("stopped"));
        });
      });
    });
    await flush();
    await clock.advance(59_999);
    expect(aborted).toBe(false);
    await clock.advance(1);
    expect(await run).toMatchObject({ ok: false, reason: "budget", scope: "seat" });
    expect(aborted).toBe(true);
    expect(events.some((e) => e.type === "budget.exceeded")).toBe(true);
    expect(await scheduler.run(seat!, async () => "again")).toMatchObject({ ok: false, reason: "budget" });
  });

  it("keeps a successful result even when it uses up the session budget", async () => {
    // Timers never fire here, so only the post-run check can see the runtime breach.
    let t = 0;
    const scheduler = new SeatScheduler({
      sessionId: "s",
      now: () => t,
      setTimer: () => 0,
      clearTimer: () => undefined,
      sessionBudget: { maxRuntimeMs: 1_000 },
    });
    const [a, b] = claude(2);
    const other = scheduler.run(b!, (ctx) => {
      return new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("x"))));
    });
    await flush();
    const g = gate();
    const winner = scheduler.run(a!, async () => {
      await g.done;
      return "done";
    });
    await flush();
    t = 2_000;
    g.open();
    expect(await winner).toMatchObject({ ok: true, value: "done" });
    expect(await other).toMatchObject({ ok: false, reason: "budget", scope: "session" });
  });

  it("re-checks budgets at admission so queued jobs of a spent seat never start", async () => {
    const { scheduler } = setup({ defaultCliConcurrency: 1 });
    const [seat] = claude(1, { maxTokens: 10 });
    let secondStarted = false;
    const first = scheduler.run(seat!, async (ctx) => {
      ctx.reportUsage({ tokensIn: 3 });
      await flush();
      ctx.reportUsage({ tokensIn: 3 });
      return "first";
    });
    const second = scheduler.run(seat!, async () => {
      secondStarted = true;
    });
    // The first job ends below the limit; push the seat over it before the second is admitted.
    const firstOutcome = await first;
    expect(firstOutcome).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(secondStarted).toBe(true);

    const third = scheduler.run(seat!, async (ctx) => {
      ctx.reportUsage({ tokensIn: 10 });
      return "over";
    });
    expect(await third).toMatchObject({ ok: false, reason: "budget" });
    let fourthStarted = false;
    expect(await scheduler.run(seat!, async () => { fourthStarted = true; })).toMatchObject({ reason: "budget" });
    expect(fourthStarted).toBe(false);
  });

  it("a seat breach stops all of that seat's jobs", async () => {
    const { scheduler } = setup({ defaultCliConcurrency: 2 });
    const [seat] = claude(1, { maxTokens: 10 });
    const waiter = scheduler.run(seat!, (ctx) => {
      return new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("x"))));
    });
    await flush();
    const spender = scheduler.run(seat!, async (ctx) => {
      ctx.reportUsage({ tokensOut: 11 });
      await flush();
    });
    expect(await spender).toMatchObject({ ok: false, reason: "budget", scope: "seat" });
    expect(await waiter).toMatchObject({ ok: false, reason: "budget", scope: "seat" });
  });
});

describe("deadlines and stuck jobs", () => {
  it("stops a job at its timeout", async () => {
    const { scheduler, clock } = setup();
    const [seat] = claude(1);
    const run = scheduler.run(
      seat!,
      (ctx) => new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("x")))),
      { timeoutMs: 10_000 },
    );
    await flush();
    await clock.advance(10_000);
    expect(await run).toMatchObject({ ok: false, reason: "timeout", scope: "seat" });
  });

  it("settles after the grace period when a job ignores its abort, keeping the slot until it ends", async () => {
    const { scheduler, clock } = setup({ abortGraceMs: 5_000, defaultCliConcurrency: 1 });
    const [a, b] = claude(2);
    const stuck = gate();
    const run = scheduler.run(a!, () => stuck.done); // ignores abort
    await flush();
    scheduler.cancelSeat(a!.id);
    await clock.advance(4_999);
    let settled = false;
    void run.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await clock.advance(1);
    expect(await run).toMatchObject({ ok: false, reason: "cancelled" });
    expect(scheduler.runningCount).toBe(1); // slot still held by the stuck job
    let bStarted = false;
    const runB = scheduler.run(b!, async () => {
      bStarted = true;
    });
    await flush();
    expect(bStarted).toBe(false);
    stuck.open();
    await runB;
    expect(bStarted).toBe(true);
    expect(scheduler.runningCount).toBe(0);
  });

  it("fails instead of waiting when retryAfter is longer than the backoff cap", async () => {
    const { scheduler } = setup({ backoffMaxMs: 60_000 });
    const [seat] = claude(1);
    const outcome = await scheduler.run(seat!, async () => {
      throw Object.assign(new Error("quota exceeded"), { retryAfterMs: 3_600_000 });
    });
    expect(outcome).toMatchObject({ ok: false, reason: "rate_limited", attempts: 1 });
    expect(outcome.ok ? "" : outcome.error).toContain("3600 s");
  });
});

describe("cancellation", () => {
  it("cancels queued, running and backing-off jobs of one seat", async () => {
    const { scheduler, clock } = setup({ defaultCliConcurrency: 1 });
    const [a, b] = claude(2);
    const g = gate();
    const running = scheduler.run(a!, async (ctx) => {
      ctx.signal.addEventListener("abort", () => g.fail(new Error("stopped")));
      await g.done;
    });
    const queued = scheduler.run(a!, async () => "never");
    await flush();
    scheduler.cancelSeat(a!.id);
    expect(await running).toMatchObject({ ok: false, reason: "cancelled", scope: "seat" });
    expect(await queued).toMatchObject({ ok: false, reason: "cancelled", scope: "seat", attempts: 0 });

    const backingOff = scheduler.run(b!, async () => {
      throw new Error("429");
    });
    await flush();
    scheduler.cancelSeat(b!.id);
    expect(await backingOff).toMatchObject({ ok: false, reason: "cancelled", attempts: 1 });
    await clock.advance(120_000);
    expect(scheduler.runningCount).toBe(0);
    expect(scheduler.queuedCount).toBe(0);
  });

  it("cancelAll stops everything and later runs resolve cancelled", async () => {
    const { scheduler } = setup();
    const seats = claude(3);
    const runs = seats.map((seat) =>
      scheduler.run(seat, async (ctx) => {
        await new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("x"))));
      }),
    );
    await flush();
    scheduler.cancelAll();
    for (const outcome of await Promise.all(runs)) {
      expect(outcome).toMatchObject({ ok: false, reason: "cancelled", scope: "session" });
    }
    expect(await scheduler.run(seats[0]!, async () => 1)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(scheduler.runningCount).toBe(0);
  });

  it("honours the caller's signal", async () => {
    const { scheduler } = setup();
    const [seat] = claude(1);
    const controller = new AbortController();
    const run = scheduler.run(
      seat!,
      async (ctx) => {
        await new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("x"))));
      },
      { signal: controller.signal },
    );
    await flush();
    controller.abort();
    expect(await run).toMatchObject({ ok: false, reason: "cancelled", scope: "seat" });
    const pre = new AbortController();
    pre.abort();
    expect(await scheduler.run(seat!, async () => 1, { signal: pre.signal })).toMatchObject({ reason: "cancelled" });
  });
});
