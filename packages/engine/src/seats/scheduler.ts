import type { Seat, SeatProvider, SeatStatus } from "#assentor/protocol/seats.js";
import type { EngineEventDraft } from "#assentor/protocol/events.js";

/**
 * Seat scheduler (task T02-02).
 *
 * Runs jobs for many seats safely:
 * - **Admission**: global FIFO order, a per-provider concurrency cap (CLI 2,
 *   API 4 by default, from the seat's transport) and a global cap. A provider
 *   that hit a rate limit admits nothing until its cooldown ends. Waiting
 *   seats show `queued`. Budgets are re-checked at admission, so queued jobs
 *   and retries of an exhausted seat never start.
 * - **Rate limits**: a job that fails with a rate-limit error is retried with
 *   exponential backoff plus jitter (honouring a server `retryAfterMs` up to
 *   `backoffMaxMs`; longer waits fail as `rate_limited`), up to `maxAttempts`.
 *   Its slot is released while it waits; the seat shows `rate_limited`.
 * - **Budgets**: tokens, cost and runtime per seat (`Seat.budget`) and per
 *   session. Runtime is enforced while a job runs (a timer fires at the
 *   remaining budget). A `session.warning` (kind `budget`) at 50% and at 80%,
 *   once each, then `budget.exceeded` and the job is stopped. A seat breach stops all of that seat's jobs; a session
 *   breach stops everything. Session runtime is the sum of seat time (6
 *   parallel seats use it 6× faster than the wall clock). Known limit: each
 *   attempt's runtime timer uses the budget left when it starts, so jobs
 *   running in parallel can overshoot a runtime budget by up to their overlap;
 *   the post-run check then stops everything else.
 * - **Deadlines**: `RunOptions.timeoutMs` stops a job with reason `timeout`.
 * - **Cancellation**: `cancelSeat` / `cancelAll` abort the job's signal. Jobs
 *   must stop on abort (the engine wires the signal to the executor's
 *   `cancel`, which kills the process tree). If a job ignores its abort,
 *   `run` still settles after `abortGraceMs` with the stop outcome; the slot
 *   stays counted until the job really finishes.
 *
 * `run` never throws for an expected outcome; it resolves to a `JobOutcome`.
 * Callers map scope: a "session" stop means the whole session is stopping
 * (cancel or session budget); a "seat" stop affects that seat's job only.
 * Nothing here spawns processes or touches the disk.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Input tokens served from a prompt cache (part of `tokensIn`); passed through to `seat.tokens`, not budgeted. */
  cachedTokens?: number;
  /** Model turns the report covers (a CLI run makes several); passed through to `seat.tokens`. */
  turns?: number;
}

export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
  maxRuntimeMs?: number;
}

export interface JobContext {
  /** Aborted on cancel, timeout, budget stop, or when the caller's signal aborts. */
  signal: AbortSignal;
  /** 1-based attempt number (rate-limit retries increment it). */
  attempt: number;
  /** Report usage as it happens; budgets are checked on every report. */
  reportUsage(delta: Partial<Usage>): void;
}

export type SchedulerJob<T> = (ctx: JobContext) => Promise<T>;

export type RateLimitVerdict = { rateLimited: true; retryAfterMs?: number } | { rateLimited: false };

export type JobFailureReason = "cancelled" | "budget" | "timeout" | "rate_limited" | "error";

export type JobOutcome<T> =
  | { ok: true; value: T; attempts: number; usage: Usage }
  | {
      ok: false;
      reason: JobFailureReason;
      /** Whether the stop applies to this seat only or to the whole session. */
      scope: "seat" | "session";
      error: string;
      attempts: number;
      usage: Usage;
    };

export interface RunOptions {
  /** Caller's signal (e.g. the stage's); aborting it cancels this job (scope "seat"). */
  signal?: AbortSignal;
  /** Per-attempt deadline; the job is stopped with reason "timeout" (scope "seat"). */
  timeoutMs?: number;
  /** Overrides the scheduler's default classifier for this job. */
  classify?: (error: unknown) => RateLimitVerdict;
  /** Overrides the scheduler's default max attempts. */
  maxAttempts?: number;
  /** Stage the job belongs to; set on its `seat.tokens` events. */
  stageId?: string;
}

export interface SchedulerOptions {
  sessionId: string;
  /** Per-provider caps; missing providers use the transport default. */
  concurrency?: Partial<Record<SeatProvider, number>>;
  /** Defaults: CLI 2, API 4, global 6. */
  defaultCliConcurrency?: number;
  defaultApiConcurrency?: number;
  globalConcurrency?: number;
  sessionBudget?: BudgetLimits;
  /** Default 3 (first try + 2 retries). */
  maxAttempts?: number;
  /** Backoff: base * 2^(attempt-1), ±jitter, capped. Defaults 2 s, 60 s, 0.2. A server retryAfter above the cap fails instead of waiting. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  backoffJitter?: number;
  /** How long a stopped job may take to honour its abort before `run` settles anyway. Default 5 s. */
  abortGraceMs?: number;
  classify?: (error: unknown) => RateLimitVerdict;
  /** Seat events (queued / rate_limited / budget) go here; must not throw. */
  emit?: (draft: EngineEventDraft) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 0 ≤ x < 1. */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERN = /rate.?limit|\b429\b|too many requests|overloaded|quota exceeded|resource.?exhausted/i;

/** Default classifier: rate-limit wording or HTTP 429 in the error message; `retryAfterMs` if the error carries one. */
export function classifyRateLimit(error: unknown): RateLimitVerdict {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!RATE_LIMIT_PATTERN.test(message)) {
    return { rateLimited: false };
  }
  const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? { rateLimited: true, retryAfterMs }
    : { rateLimited: true };
}

/** Budget fractions that each warn once (TE-01). */
const BUDGET_WARN_AT = [0.5, 0.8] as const;

const zeroUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 });

function addUsage(into: Usage, delta: Partial<Usage>): void {
  into.tokensIn += Math.max(0, delta.tokensIn ?? 0);
  into.tokensOut += Math.max(0, delta.tokensOut ?? 0);
  into.costUsd += Math.max(0, delta.costUsd ?? 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type StopReason = "cancelled" | "budget" | "timeout";
interface StopInfo {
  reason: StopReason;
  scope: "seat" | "session";
  message: string;
}
type StopFn = (info: StopInfo) => void;

interface Pending {
  seat: Seat;
  /** Fails the job and returns true when it must not start (budget spent). */
  blocked: () => boolean;
  start: () => void;
}

interface Tracker {
  usage: Usage;
  runtimeMs: number;
  warned: Set<string>;
}

type BudgetKind = "tokens" | "cost" | "runtime";
interface Breach {
  scope: "seat" | "session";
  kind: BudgetKind;
  used: number;
  limit: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class SeatScheduler {
  private readonly cfg: {
    defaultCliConcurrency: number;
    defaultApiConcurrency: number;
    globalConcurrency: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    backoffJitter: number;
    abortGraceMs: number;
  };
  private readonly options: SchedulerOptions;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly random: () => number;

  private readonly queue: Pending[] = [];
  private readonly runningByProvider = new Map<SeatProvider, number>();
  private running = 0;
  private readonly cooldownUntil = new Map<SeatProvider, number>();
  private cooldownTimer?: unknown;
  private pumping = false;
  private repump = false;
  /** Stop handles of every unsettled job (queued, running or backing off), by seat. */
  private readonly active = new Map<string, Set<StopFn>>();
  private readonly seatTrackers = new Map<string, Tracker>();
  private readonly session: Tracker = { usage: zeroUsage(), runtimeMs: 0, warned: new Set() };
  private stopped?: { reason: "cancelled" | "budget"; message: string };

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.cfg = {
      defaultCliConcurrency: options.defaultCliConcurrency ?? 2,
      defaultApiConcurrency: options.defaultApiConcurrency ?? 4,
      globalConcurrency: options.globalConcurrency ?? 6,
      maxAttempts: options.maxAttempts ?? 3,
      backoffBaseMs: options.backoffBaseMs ?? 2_000,
      backoffMaxMs: options.backoffMaxMs ?? 60_000,
      backoffJitter: options.backoffJitter ?? 0.2,
      abortGraceMs: options.abortGraceMs ?? 5_000,
    };
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
  }

  /** Total usage across all seats (runtime is summed seat time). */
  get sessionUsage(): Readonly<Usage> & { runtimeMs: number } {
    return { ...this.session.usage, runtimeMs: this.session.runtimeMs };
  }

  seatUsage(seatId: string): Readonly<Usage> & { runtimeMs: number } {
    const tracker = this.seatTrackers.get(seatId);
    return tracker ? { ...tracker.usage, runtimeMs: tracker.runtimeMs } : { ...zeroUsage(), runtimeMs: 0 };
  }

  /** Jobs waiting for a slot (not counting jobs waiting out a backoff). */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Jobs holding a slot (including stopped jobs that haven't finished yet). */
  get runningCount(): number {
    return this.running;
  }

  /** Cancel every queued, running and backing-off job of one seat. */
  cancelSeat(seatId: string, message = "seat cancelled"): void {
    this.stopSeat(seatId, { reason: "cancelled", scope: "seat", message });
  }

  /** Cancel everything; later `run` calls resolve cancelled immediately. */
  cancelAll(message = "session cancelled"): void {
    this.stopAll("cancelled", message);
  }

  run<T>(seat: Seat, job: SchedulerJob<T>, runOptions: RunOptions = {}): Promise<JobOutcome<T>> {
    const tracker = this.trackerFor(seat.id);
    const classify = runOptions.classify ?? this.options.classify ?? classifyRateLimit;
    const maxAttempts = Math.max(1, runOptions.maxAttempts ?? this.cfg.maxAttempts);

    return new Promise<JobOutcome<T>>((resolve) => {
      const usage = zeroUsage();
      let attempts = 0;
      let settled = false;
      let backoffTimer: unknown;
      let pending: Pending | undefined;
      /** Set while an attempt runs: aborts it; the attempt then reports the stop. */
      let abortRunning: StopFn | undefined;

      const finish = (outcome: JobOutcome<T>) => {
        if (settled) {
          return;
        }
        settled = true;
        if (backoffTimer !== undefined) {
          this.clearTimer(backoffTimer);
          backoffTimer = undefined;
        }
        if (pending) {
          this.removeFromQueue(pending);
          pending = undefined;
          this.pump();
        }
        this.unregister(seat.id, stop);
        runOptions.signal?.removeEventListener("abort", onCallerAbort);
        resolve(outcome);
      };

      const fail = (reason: JobFailureReason, scope: "seat" | "session", error: string) =>
        finish({ ok: false, reason, scope, error, attempts, usage: { ...usage } });

      /** One stop handle for the whole job: queued, running or backing off. */
      const stop: StopFn = (info) => {
        if (settled) {
          return;
        }
        if (abortRunning) {
          abortRunning(info);
        } else {
          fail(info.reason, info.scope, info.message);
        }
      };

      const onCallerAbort = () => stop({ reason: "cancelled", scope: "seat", message: "cancelled by caller" });

      const budgetBlocked = (): boolean => {
        const breach = this.findBreach(seat, tracker, false);
        if (!breach) {
          return false;
        }
        this.emitExceeded(seat, breach);
        fail("budget", breach.scope, breach.message);
        return true;
      };

      if (this.stopped) {
        fail(this.stopped.reason, "session", this.stopped.message);
        return;
      }
      if (runOptions.signal?.aborted) {
        fail("cancelled", "seat", "cancelled by caller");
        return;
      }
      if (budgetBlocked()) {
        return;
      }
      runOptions.signal?.addEventListener("abort", onCallerAbort, { once: true });
      this.register(seat.id, stop);

      const enqueue = () => {
        pending = {
          seat,
          blocked: () => {
            if (settled) {
              return true;
            }
            if (budgetBlocked()) {
              pending = undefined;
              return true;
            }
            return false;
          },
          start: () => {
            pending = undefined;
            void attempt();
          },
        };
        this.queue.push(pending);
        this.emitStatus(seat, "queued");
        this.pump();
      };

      const attempt = async () => {
        attempts += 1;
        const controller = new AbortController();
        const provider = seat.provider;
        const startedAt = this.now();
        const timers: unknown[] = [];
        let stopInfo: StopInfo | undefined;
        let jobDone = false;

        abortRunning = (info) => {
          if (stopInfo) {
            return;
          }
          stopInfo = info;
          controller.abort(new Error(info.message));
          // A job that ignores its abort must not hang `run`.
          timers.push(
            this.setTimer(() => {
              if (!jobDone) {
                fail(info.reason, info.scope, `${info.message} (job did not stop within ${this.cfg.abortGraceMs} ms)`);
              }
            }, this.cfg.abortGraceMs),
          );
        };

        if (runOptions.timeoutMs !== undefined && runOptions.timeoutMs > 0) {
          const ms = runOptions.timeoutMs;
          timers.push(
            this.setTimer(() => abortRunning?.({ reason: "timeout", scope: "seat", message: `timed out after ${ms} ms` }), ms),
          );
        }
        // Enforce the runtime budget while the job runs.
        const remaining = this.remainingRuntime(seat, tracker);
        if (remaining) {
          timers.push(
            this.setTimer(() => {
              const elapsed = Math.max(0, this.now() - startedAt);
              const breach: Breach = {
                scope: remaining.scope,
                kind: "runtime",
                used: remaining.used + elapsed,
                limit: remaining.limit,
                message: `${remaining.scope === "session" ? "session" : seat.displayName} runtime budget exhausted`,
              };
              this.emitExceeded(seat, breach);
              this.stopForBreach(seat, breach);
            }, remaining.ms),
          );
        }

        const ctx: JobContext = {
          signal: controller.signal,
          attempt: attempts,
          reportUsage: (delta) => {
            this.emit({
              type: "seat.tokens",
              sessionId: this.options.sessionId,
              seatId: seat.id,
              ...(runOptions.stageId ? { stageId: runOptions.stageId } : {}),
              data: {
                tokensIn: Math.max(0, delta.tokensIn ?? 0),
                tokensOut: Math.max(0, delta.tokensOut ?? 0),
                ...(delta.costUsd !== undefined ? { costUsd: Math.max(0, delta.costUsd) } : {}),
                ...(delta.cachedTokens !== undefined ? { cachedTokens: Math.max(0, delta.cachedTokens) } : {}),
                ...(delta.turns !== undefined && delta.turns >= 1 ? { turns: Math.round(delta.turns) } : {}),
              },
            });
            addUsage(usage, delta);
            addUsage(tracker.usage, delta);
            addUsage(this.session.usage, delta);
            const breach = this.checkBudgets(seat, tracker);
            if (breach) {
              this.stopForBreach(seat, breach);
            }
          },
        };

        let value: T | undefined;
        let thrown: unknown;
        let threw = false;
        try {
          value = await job(ctx);
        } catch (error) {
          threw = true;
          thrown = error;
        }

        jobDone = true;
        for (const timer of timers) {
          this.clearTimer(timer);
        }
        const elapsed = Math.max(0, this.now() - startedAt);
        tracker.runtimeMs += elapsed;
        this.session.runtimeMs += elapsed;
        abortRunning = undefined;
        this.running -= 1;
        this.runningByProvider.set(provider, Math.max(0, (this.runningByProvider.get(provider) ?? 1) - 1));

        const runtimeBreach = stopInfo ? undefined : this.checkBudgets(seat, tracker);

        if (stopInfo) {
          fail(stopInfo.reason, stopInfo.scope, stopInfo.message);
        } else if (!threw) {
          // Keep the result, then stop the rest if this job used up the budget.
          finish({ ok: true, value: value as T, attempts, usage: { ...usage } });
          if (runtimeBreach) {
            this.stopForBreach(seat, runtimeBreach);
          }
        } else if (runtimeBreach) {
          fail("budget", runtimeBreach.scope, runtimeBreach.message);
          this.stopForBreach(seat, runtimeBreach);
        } else {
          const verdict = classify(thrown);
          if (!verdict.rateLimited) {
            fail("error", "seat", errorMessage(thrown));
          } else if (attempts >= maxAttempts) {
            fail("rate_limited", "seat", `rate limited after ${attempts} attempts: ${errorMessage(thrown)}`);
          } else if (verdict.retryAfterMs !== undefined && verdict.retryAfterMs > this.cfg.backoffMaxMs) {
            fail(
              "rate_limited",
              "seat",
              `rate limited; retry after ${Math.round(verdict.retryAfterMs / 1000)} s is longer than the ${Math.round(this.cfg.backoffMaxMs / 1000)} s limit: ${errorMessage(thrown)}`,
            );
          } else if (this.stopped) {
            fail(this.stopped.reason, "session", this.stopped.message);
          } else if (!settled) {
            // Back off without holding a slot; the whole provider cools down.
            const delay = this.backoffMs(attempts, verdict.retryAfterMs);
            const retryAt = this.now() + delay;
            this.cooldownUntil.set(provider, Math.max(this.cooldownUntil.get(provider) ?? 0, retryAt));
            this.emitStatus(seat, "rate_limited", `retry at ${new Date(retryAt).toISOString()}`, {
              retryAt: new Date(retryAt).toISOString(),
            });
            backoffTimer = this.setTimer(() => {
              backoffTimer = undefined;
              if (!settled) {
                enqueue();
              }
            }, delay);
          }
        }
        this.pump();
      };

      enqueue();
    });
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  private capFor(seat: Seat): number {
    const configured = this.options.concurrency?.[seat.provider];
    if (typeof configured === "number" && configured >= 1) {
      return Math.floor(configured);
    }
    return seat.transport === "cli" ? this.cfg.defaultCliConcurrency : this.cfg.defaultApiConcurrency;
  }

  private pump(): void {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        this.pumpOnce();
      } while (this.repump);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    if (this.cooldownTimer !== undefined) {
      this.clearTimer(this.cooldownTimer);
      this.cooldownTimer = undefined;
    }
    const now = this.now();
    let nextCooldown = Infinity;
    for (let index = 0; index < this.queue.length && this.running < this.cfg.globalConcurrency; ) {
      const pending = this.queue[index]!;
      const provider = pending.seat.provider;
      const until = this.cooldownUntil.get(provider) ?? 0;
      if (until > now) {
        nextCooldown = Math.min(nextCooldown, until);
        index += 1;
        continue;
      }
      if ((this.runningByProvider.get(provider) ?? 0) >= this.capFor(pending.seat)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      if (pending.blocked()) {
        continue; // budget spent since it was queued; it already failed
      }
      this.running += 1;
      this.runningByProvider.set(provider, (this.runningByProvider.get(provider) ?? 0) + 1);
      pending.start();
    }
    if (nextCooldown !== Infinity && this.queue.length > 0) {
      this.cooldownTimer = this.setTimer(() => {
        this.cooldownTimer = undefined;
        this.pump();
      }, Math.max(0, nextCooldown - now));
    }
  }

  private removeFromQueue(pending: Pending): void {
    const index = this.queue.indexOf(pending);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private backoffMs(attempt: number, retryAfterMs?: number): number {
    const exponential = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (attempt - 1));
    const jitter = 1 + (this.random() * 2 - 1) * this.cfg.backoffJitter;
    const delay = Math.round(Math.min(this.cfg.backoffMaxMs, exponential * jitter));
    return retryAfterMs !== undefined ? Math.max(delay, Math.round(retryAfterMs)) : delay;
  }

  private register(seatId: string, stop: StopFn): void {
    const stops = this.active.get(seatId) ?? new Set<StopFn>();
    stops.add(stop);
    this.active.set(seatId, stops);
  }

  private unregister(seatId: string, stop: StopFn): void {
    const stops = this.active.get(seatId);
    if (stops) {
      stops.delete(stop);
      if (stops.size === 0) {
        this.active.delete(seatId);
      }
    }
  }

  private stopSeat(seatId: string, info: StopInfo): void {
    for (const stop of [...(this.active.get(seatId) ?? [])]) {
      stop(info);
    }
  }

  private stopAll(reason: "cancelled" | "budget", message: string): void {
    if (this.stopped) {
      return;
    }
    this.stopped = { reason, message };
    for (const stops of [...this.active.values()]) {
      for (const stop of [...stops]) {
        stop({ reason, scope: "session", message });
      }
    }
    if (this.cooldownTimer !== undefined) {
      this.clearTimer(this.cooldownTimer);
      this.cooldownTimer = undefined;
    }
  }

  private stopForBreach(seat: Seat, breach: Breach): void {
    if (breach.scope === "session") {
      this.stopAll("budget", breach.message);
    } else {
      this.stopSeat(seat.id, { reason: "budget", scope: "seat", message: breach.message });
    }
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  private trackerFor(seatId: string): Tracker {
    let tracker = this.seatTrackers.get(seatId);
    if (!tracker) {
      tracker = { usage: zeroUsage(), runtimeMs: 0, warned: new Set() };
      this.seatTrackers.set(seatId, tracker);
    }
    return tracker;
  }

  private seatLimits(seat: Seat): BudgetLimits {
    const budget = seat.budget;
    if (!budget) {
      return {};
    }
    return {
      ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
      ...(budget.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
      ...(budget.maxRuntimeMinutes !== undefined ? { maxRuntimeMs: budget.maxRuntimeMinutes * 60_000 } : {}),
    };
  }

  /** Runtime left before a seat or session limit, whichever is sooner. */
  private remainingRuntime(
    seat: Seat,
    tracker: Tracker,
  ): { ms: number; scope: "seat" | "session"; used: number; limit: number } | undefined {
    const candidates: Array<{ ms: number; scope: "seat" | "session"; used: number; limit: number }> = [];
    const seatLimit = this.seatLimits(seat).maxRuntimeMs;
    if (seatLimit !== undefined && seatLimit > 0) {
      candidates.push({ ms: seatLimit - tracker.runtimeMs, scope: "seat", used: tracker.runtimeMs, limit: seatLimit });
    }
    const sessionLimit = this.options.sessionBudget?.maxRuntimeMs;
    if (sessionLimit !== undefined && sessionLimit > 0) {
      candidates.push({
        ms: sessionLimit - this.session.runtimeMs,
        scope: "session",
        used: this.session.runtimeMs,
        limit: sessionLimit,
      });
    }
    if (candidates.length === 0) {
      return undefined;
    }
    const soonest = candidates.reduce((a, b) => (b.ms < a.ms ? b : a));
    return { ...soonest, ms: Math.max(0, soonest.ms) };
  }

  /** Warn at 50% and 80%, return (and announce) a breach at 100%. */
  private checkBudgets(seat: Seat, tracker: Tracker): Breach | undefined {
    const breach = this.findBreach(seat, tracker, true);
    if (breach) {
      this.emitExceeded(seat, breach);
    }
    return breach;
  }

  private findBreach(seat: Seat, tracker: Tracker, warn: boolean): Breach | undefined {
    const scopes: Array<{ scope: "seat" | "session"; limits: BudgetLimits; tracker: Tracker }> = [
      { scope: "session", limits: this.options.sessionBudget ?? {}, tracker: this.session },
      { scope: "seat", limits: this.seatLimits(seat), tracker },
    ];
    for (const { scope, limits, tracker: t } of scopes) {
      const checks: Array<[BudgetKind, number, number | undefined]> = [
        ["tokens", t.usage.tokensIn + t.usage.tokensOut, limits.maxTokens],
        ["cost", t.usage.costUsd, limits.maxCostUsd],
        ["runtime", t.runtimeMs, limits.maxRuntimeMs],
      ];
      for (const [kind, used, limit] of checks) {
        if (limit === undefined || limit <= 0) {
          continue;
        }
        if (used >= limit) {
          return {
            scope,
            kind,
            used,
            limit,
            message: `${scope === "session" ? "session" : seat.displayName} ${kind} budget exhausted (${round(used)} of ${round(limit)})`,
          };
        }
        for (const threshold of BUDGET_WARN_AT) {
          const key = `${kind}@${threshold}`;
          if (!warn || used < limit * threshold || t.warned.has(key)) {
            continue;
          }
          t.warned.add(key);
          const who = scope === "session" ? "session" : seat.displayName;
          this.emit({
            type: "session.warning",
            sessionId: this.options.sessionId,
            ...(scope === "seat" ? { seatId: seat.id } : {}),
            data: {
              kind: "budget",
              message: `${who} ${kind} budget at ${threshold * 100}% (${round(used)} of ${round(limit)})`,
              budget: `${scope}.${kind}`,
              threshold,
              used: round(used),
              limit: round(limit),
            },
          });
        }
      }
    }
    return undefined;
  }

  private emitExceeded(seat: Seat, breach: Breach): void {
    const key = `exceeded.${breach.kind}`;
    const tracker = breach.scope === "session" ? this.session : this.trackerFor(seat.id);
    if (tracker.warned.has(key)) {
      return;
    }
    tracker.warned.add(key);
    this.emit({
      type: "budget.exceeded",
      sessionId: this.options.sessionId,
      ...(breach.scope === "seat" ? { seatId: seat.id } : {}),
      data: { kind: `${breach.scope}.${breach.kind}`, used: round(breach.used), limit: round(breach.limit) },
    });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private emitStatus(seat: Seat, status: SeatStatus, detail?: string, extra?: Record<string, unknown>): void {
    this.emit({
      type: "seat.status",
      sessionId: this.options.sessionId,
      seatId: seat.id,
      data: { status, ...(detail ? { detail } : {}), ...(extra ?? {}) },
    });
  }

  private emit(draft: EngineEventDraft): void {
    try {
      this.options.emit?.(draft);
    } catch {
      // Observability must never break scheduling.
    }
  }
}

/** Build a scheduler from config `limits` (T02-02). */
export function createSeatScheduler(
  limits: {
    concurrency?: Partial<Record<SeatProvider, number>>;
    globalConcurrency?: number;
    session?: { maxTokens?: number; maxCostUsd?: number; maxRuntimeMinutes?: number };
  },
  options: Omit<SchedulerOptions, "concurrency" | "globalConcurrency" | "sessionBudget">,
): SeatScheduler {
  const session = limits.session ?? {};
  return new SeatScheduler({
    ...options,
    concurrency: limits.concurrency ?? {},
    ...(limits.globalConcurrency ? { globalConcurrency: limits.globalConcurrency } : {}),
    sessionBudget: {
      ...(session.maxTokens !== undefined ? { maxTokens: session.maxTokens } : {}),
      ...(session.maxCostUsd !== undefined ? { maxCostUsd: session.maxCostUsd } : {}),
      ...(session.maxRuntimeMinutes !== undefined ? { maxRuntimeMs: session.maxRuntimeMinutes * 60_000 } : {}),
    },
  });
}
