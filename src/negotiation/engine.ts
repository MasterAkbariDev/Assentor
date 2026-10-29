import { promises as fs } from "node:fs";
import path from "node:path";
import type { Seat } from "../core/seats.js";
import { sessionPaths } from "../persistence/paths.js";
import type { EngineEventDraft } from "../protocol/events.js";
import { extractJsonCandidate } from "../protocol/parse.js";
import type { JobOutcome, SeatScheduler, Usage } from "../seats/scheduler.js";
import {
  NegotiationCancelledError,
  NegotiationResultSchema,
  STEP_REPLY_SCHEMAS,
  type AskSeatOptions,
  type NegotiationContext,
  type NegotiationEventInput,
  type NegotiationResult,
  type NegotiationStep,
  type NegotiationStrategy,
  type SeatReply,
  type StepReply,
} from "./strategy.js";
import { getStrategy } from "./strategies/index.js";

/**
 * Negotiation engine (task T02-03, engine half).
 *
 * Implements `NegotiationContext` on top of the seat scheduler (T02-02) and
 * runs a strategy end to end:
 * - every `askSeat` runs through `scheduler.run` (caps, rate limits, budgets,
 *   per-ask timeout), then the reply is parsed and validated against the
 *   step's schema;
 * - outcome mapping (the contract's semantics): a seat-scope failure, timeout
 *   or invalid reply → `ok: false`; a session-scope stop (cancel or session
 *   budget) → rejects with `NegotiationCancelledError(reason)`;
 * - seat status events (`thinking` → `done`/`error`) and the strategy's
 *   `negotiation.*` events go to `emit`;
 * - every ask and reply is kept in a transcript; the result and transcript
 *   are persisted to `.assentor/sessions/<id>/negotiations/<runId>.json`
 *   (`transcriptRef` is that path relative to the session dir, set only when
 *   a file is written). An existing file is never overwritten, and nothing is
 *   written when the run is cancelled or the strategy throws.
 *
 * The model call itself is injected as a `SeatStepRunner` (renders the step's
 * prompt, calls the seat's CLI/API, reports usage). This file never spawns.
 */

/** Runs one negotiation step on one seat. Returns the raw reply: an object, or text containing JSON. */
export type SeatStepRunner = (request: {
  seat: Seat;
  step: NegotiationStep;
  vars: Readonly<Record<string, unknown>>;
  readOnly: boolean;
  worktreePath?: string;
  signal: AbortSignal;
  reportUsage: (delta: Partial<Usage>) => void;
}) => Promise<unknown>;

export interface TranscriptEntry {
  /** Order in which the ask started; the transcript is sorted by it before it is returned. */
  index: number;
  seatId: string;
  step: NegotiationStep;
  vars: Readonly<Record<string, unknown>>;
  ok: boolean;
  reply?: unknown;
  error?: string;
  attempts: number;
}

export interface NegotiationRunInput {
  sessionId: string;
  /** Project root; persistence is skipped when omitted (tests). */
  projectPath?: string;
  /** Unique per negotiation in the session, e.g. the stage id. Path-safe. */
  runId: string;
  strategy: string | NegotiationStrategy;
  goal: string;
  seats: readonly Seat[];
  options?: Record<string, unknown>;
  scheduler: SeatScheduler;
  runStep: SeatStepRunner;
  /** Engine events (seat status and negotiation.*); must not throw. */
  emit?: (draft: EngineEventDraft) => void;
  /**
   * Caller cancellation: pass the session's signal. Aborting it calls
   * `scheduler.cancelAll`, which is permanent for that scheduler, so never
   * pass a signal narrower than the scheduler's lifetime.
   */
  signal?: AbortSignal;
  /** Per-ask deadline passed to the scheduler. Default 10 minutes. */
  askTimeoutMs?: number;
}

export interface NegotiationRunOutput {
  result: NegotiationResult;
  transcript: TranscriptEntry[];
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;

/**
 * Build the engine-side context. Exposed for the stage runner (T02-09) and
 * tests. Call `dispose()` when the negotiation ends: it detaches the listener
 * on `input.signal` (one per run, so a long-lived session signal would
 * otherwise keep every run's context alive).
 */
export function createNegotiationContext(
  input: Omit<NegotiationRunInput, "strategy" | "runId" | "projectPath"> & { transcript?: TranscriptEntry[] },
): {
  ctx: NegotiationContext;
  transcript: TranscriptEntry[];
  abort: (reason?: "cancelled" | "budget") => void;
  dispose: () => void;
} {
  const transcript = input.transcript ?? [];
  let nextIndex = 0;
  const seatsById = new Map(input.seats.map((seat) => [seat.id, seat]));
  const controller = new AbortController();
  let stopReason: "cancelled" | "budget" = "cancelled";
  const abort = (reason: "cancelled" | "budget" = "cancelled") => {
    if (!controller.signal.aborted) {
      stopReason = reason;
      controller.abort(new NegotiationCancelledError(reason));
      if (reason === "cancelled") {
        input.scheduler.cancelAll("negotiation cancelled");
      }
    }
  };
  const onCallerAbort = () => abort("cancelled");
  if (input.signal?.aborted) {
    abort("cancelled");
  } else {
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  // Ending the run stops asks still in flight (seat-scope: no cancelAll, the scheduler lives on).
  const dispose = () => {
    input.signal?.removeEventListener("abort", onCallerAbort);
    if (!controller.signal.aborted) {
      controller.abort(new NegotiationCancelledError("cancelled"));
    }
  };

  const emit = (draft: EngineEventDraft) => {
    try {
      input.emit?.(draft);
    } catch {
      // Observability must never break a negotiation.
    }
  };

  const ctx: NegotiationContext = {
    sessionId: input.sessionId,
    goal: input.goal,
    seats: input.seats,
    options: input.options ?? {},
    signal: controller.signal,

    async askSeat<S extends NegotiationStep>(
      seatId: string,
      step: S,
      vars: Readonly<Record<string, unknown>>,
      options: AskSeatOptions,
    ): Promise<SeatReply<S>> {
      const seat = seatsById.get(seatId);
      if (!seat) {
        // A programmer error, the one exception to "rejects only on cancel".
        throw new Error(`negotiation: unknown seat ${seatId}`);
      }
      if (controller.signal.aborted) {
        throw new NegotiationCancelledError(stopReason);
      }
      const index = nextIndex++;
      /** Close the seat's `queued`/`thinking`/`editing` status when the run stops under it (one `seat.done` per ask). */
      const stopped = (reason: "cancelled" | "budget") =>
        emit({
          type: "seat.done",
          sessionId: input.sessionId,
          seatId,
          data: { ok: false, summary: reason === "budget" ? "budget exceeded" : "cancelled" },
        });

      const outcome: JobOutcome<unknown> = await input.scheduler.run(
        seat,
        async (job) => {
          emit({
            type: "seat.status",
            sessionId: input.sessionId,
            seatId,
            data: { status: options.readOnly ? "thinking" : "editing", detail: step },
          });
          return input.runStep({
            seat,
            step,
            vars,
            readOnly: options.readOnly,
            ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
            signal: job.signal,
            reportUsage: job.reportUsage,
          });
        },
        { signal: controller.signal, timeoutMs: input.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS },
      );

      if (!outcome.ok && outcome.scope === "session") {
        const reason = outcome.reason === "budget" ? "budget" : "cancelled";
        abort(reason);
        transcript.push({ index, seatId, step, vars, ok: false, error: outcome.error, attempts: outcome.attempts });
        stopped(reason);
        throw new NegotiationCancelledError(reason, outcome.error);
      }
      if (!outcome.ok && controller.signal.aborted) {
        // The negotiation itself was cancelled while this ask ran.
        transcript.push({ index, seatId, step, vars, ok: false, error: outcome.error, attempts: outcome.attempts });
        stopped(stopReason);
        throw new NegotiationCancelledError(stopReason);
      }

      let reply: SeatReply<S>;
      if (!outcome.ok) {
        reply = { ok: false, seatId, error: `${outcome.reason}: ${outcome.error}` };
      } else {
        // Objects pass through; text must contain JSON (fenced or bare).
        const parsed = extractJsonCandidate(outcome.value);
        if (!parsed.ok) {
          reply = { ok: false, seatId, error: `invalid ${step} reply: no JSON found` };
        } else {
          const validated = STEP_REPLY_SCHEMAS[step].safeParse(parsed.data);
          reply = validated.success
            ? { ok: true, seatId, data: validated.data as StepReply<S> }
            : {
                ok: false,
                seatId,
                error: `invalid ${step} reply: ${validated.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`,
              };
        }
      }

      transcript.push({
        index,
        seatId,
        step,
        vars,
        ok: reply.ok,
        ...(reply.ok ? { reply: reply.data } : { error: reply.error }),
        attempts: outcome.attempts,
      });
      emit(
        reply.ok
          ? { type: "seat.done", sessionId: input.sessionId, seatId, data: { ok: true, summary: step } }
          : { type: "seat.error", sessionId: input.sessionId, seatId, data: { message: reply.error } },
      );
      return reply;
    },

    emit(event: NegotiationEventInput): void {
      emit({ ...event, sessionId: input.sessionId } as EngineEventDraft);
    },
  };

  return { ctx, transcript, abort, dispose };
}

/**
 * Run one negotiation: validate, run the strategy, validate and persist the
 * result. Rejects with `NegotiationCancelledError` when the session is
 * cancelled or out of budget; any other strategy error propagates.
 */
export async function runNegotiation(input: NegotiationRunInput): Promise<NegotiationRunOutput> {
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error(`invalid negotiation run id: ${input.runId}`);
  }
  const strategy = typeof input.strategy === "string" ? getStrategy(input.strategy) : input.strategy;
  if (!strategy) {
    throw new Error(`unknown negotiation strategy: ${String(input.strategy)}`);
  }
  const problem = strategy.validate(input.seats, input.options ?? {});
  if (problem) {
    throw new Error(`${strategy.id}: ${problem}`);
  }

  // Resolve and check the output path before any model call, so a bad session id or a reused run id fails for free.
  const relative = path.posix.join("negotiations", `${input.runId}.json`);
  const file = input.projectPath ? path.join(sessionPaths(input.projectPath, input.sessionId).root, relative) : undefined;
  if (file && (await fs.stat(file).catch(() => undefined))) {
    throw new Error(`negotiation ${input.runId} already exists in session ${input.sessionId}`);
  }

  const { ctx, transcript, dispose } = createNegotiationContext(input);
  let raw: NegotiationResult;
  try {
    raw = await strategy.run(ctx);
  } finally {
    dispose();
  }
  transcript.sort((a, b) => a.index - b.index);
  const result = NegotiationResultSchema.parse(file ? { ...raw, transcriptRef: relative } : raw);

  if (file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Exclusive: EEXIST (a concurrent run with this id) rejects here, before we own the file.
    const handle = await fs.open(file, "wx");
    try {
      await handle.writeFile(`${JSON.stringify({ result, transcript }, null, 2)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      // A failed write must not leave a partial file that blocks a rerun of this runId.
      await handle.close().catch(() => undefined);
      await fs.unlink(file).catch(() => undefined);
      throw error;
    }
    // shortcut: not crash-safe (a process crash mid-write still leaves a partial file); use tmp + link if that bites.
  }
  return { result, transcript };
}
