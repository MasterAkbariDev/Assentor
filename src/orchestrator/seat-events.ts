import {
  isTerminalSeatStatus,
  type SeatPermissions,
  type SeatStatus,
  type SeatTransport,
} from "../core/seats.js";
import { createDeltaCoalescer, type DeltaCoalescer } from "../events/coalescer.js";
import type { EventLog } from "../events/log.js";
import {
  parseEngineEvent,
  type EngineEvent,
  type EngineEventDraft,
} from "../protocol/events.js";
import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "../providers/reviewers/types.js";
import { redactSecrets } from "../security/redact.js";
import { fromSupervisorEvent, type SupervisorEventContext } from "./engine-events.js";
import type { SupervisorEvent } from "./supervisor.js";

/**
 * Seat-scoped event sink (task T00-07).
 *
 * Turns executor/reviewer activity and legacy supervisor events into
 * `EngineEvent`s, batches output text per seat, persists through `EventLog`
 * (when given) and hands each sequenced event to `onEvent`.
 *
 * Observability must never break a run: no public method throws or rejects.
 * Failures go to `onError` (default: one stderr line per failure kind).
 *
 * A `seat.status` identical to the seat's previous one (same status and
 * detail) is dropped, and so is the tool call `activity` would pair with it.
 * That collapses cursor's started/completed pair into one tool call; two real
 * back-to-back calls with the same summary are counted once.
 */

export interface SeatEventSinkOptions {
  sessionId: string;
  /** Persist events here; it assigns `seq`. Without it, seq is assigned in memory. */
  log?: EventLog;
  /** Receives every sequenced event, in order. Errors thrown here are reported, not propagated. */
  onEvent?: (event: EngineEvent) => void;
  /** Output batching interval per seat. Default 40 ms. */
  coalesceMs?: number;
  /**
   * Output characters kept per seat per sink. Beyond this, output is dropped and
   * one `session.warning` (`output_truncated`) is emitted. Default 2,000,000.
   */
  maxOutputCharsPerSeat?: number;
  /** Redact secrets from every string in event data before it is written. Default true. */
  redactSecrets?: boolean;
  onError?: (error: unknown, context: string) => void;
}

/** What a UI needs to show a seat before it does anything. */
export interface SeatInfo {
  seatId: string;
  displayName: string;
  provider: string;
  transport: SeatTransport;
  model: string;
  role: string;
  permissions: SeatPermissions;
}

/** Legacy terminal events and how they close turns still open at that point. */
const SESSION_END: Partial<Record<SupervisorEvent["type"], { ok: boolean; label: string }>> = {
  "task.completed": { ok: true, label: "completed" },
  "task.blocked": { ok: false, label: "blocked" },
  "task.failed": { ok: false, label: "failed" },
};

/**
 * Map executor activity strings (cursor stream-json, print-CLI parsers) to a
 * seat status. Unknown activities return `undefined`.
 */
export function seatStatusFromActivity(activity: string): SeatStatus | undefined {
  switch (activity.trim().toLowerCase()) {
    case "starting":
      return "starting";
    case "thinking":
    case "planning":
    case "reasoning":
      return "thinking";
    case "writing":
      return "writing";
    case "editing":
      return "editing";
    case "running":
    case "reading":
    case "searching":
    case "exploring":
      return "tool";
    case "waiting":
      return "waiting";
    default:
      return undefined;
  }
}

const TOOL_ACTIVITIES = new Set(["running", "reading", "searching", "exploring", "editing"]);

export class SeatEventSink {
  readonly sessionId: string;
  private readonly log?: EventLog;
  private readonly onEvent?: (event: EngineEvent) => void;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly coalescer: DeltaCoalescer;
  private chain: Promise<void> = Promise.resolve();
  private memorySeq = 0;
  private closed = false;
  private readonly reported = new Set<string>();
  private readonly maxOutputCharsPerSeat: number;
  private readonly outputChars = new Map<string, number>();
  private readonly truncatedSeats = new Set<string>();
  private readonly redact: boolean;
  /** Last `seat.status` per seat, as `status + NUL + detail`. */
  private readonly lastStatus = new Map<string, string>();
  /** Seats whose current turn has started but not reported done or error. */
  private readonly openTurns = new Set<string>();

  constructor(options: SeatEventSinkOptions) {
    this.sessionId = options.sessionId;
    this.log = options.log;
    this.onEvent = options.onEvent;
    this.maxOutputCharsPerSeat = options.maxOutputCharsPerSeat ?? 2_000_000;
    this.redact = options.redactSecrets ?? true;
    this.onError =
      options.onError ??
      ((error, context) => {
        // One line per failure kind, so a broken disk doesn't flood the terminal.
        if (this.reported.has(context)) {
          return;
        }
        this.reported.add(context);
        console.error(`[assentor] seat events: ${context} failed:`, error);
      });
    this.coalescer = createDeltaCoalescer({
      intervalMs: options.coalesceMs ?? 40,
      emit: ({ seatId, text }) =>
        this.enqueue({
          type: "seat.output.delta",
          sessionId: this.sessionId,
          seatId,
          data: { text },
        }),
      onError: (error) => this.report(error, "output batching"),
    });
  }

  /**
   * Emit any draft. Seat-scoped non-output events flush that seat's buffered
   * output first, preserving order. Returns false when the event was dropped
   * (sink closed, or a repeated status).
   */
  emit(draft: EngineEventDraft): boolean {
    if (this.closed) {
      return false;
    }
    if (draft.seatId && !this.trackStatus(draft)) {
      return false;
    }
    if (draft.seatId && draft.type !== "seat.output.delta") {
      this.flushSeat(draft.seatId);
    }
    this.enqueue(draft);
    return true;
  }

  spawned(seat: SeatInfo): void {
    const { seatId, ...data } = seat;
    this.emit({ type: "seat.spawned", sessionId: this.sessionId, seatId, data });
  }

  status(seatId: string, status: SeatStatus, detail?: string): boolean {
    return this.emit({
      type: "seat.status",
      sessionId: this.sessionId,
      seatId,
      data: { status, ...(detail ? { detail } : {}) },
    });
  }

  /** Executor `onStatus` adapter: status change, plus a tool call for tool-like activities. */
  activity(seatId: string, activity: string, detail?: string): void {
    const status = seatStatusFromActivity(activity);
    const text = detail?.trim() || undefined;
    if (!status) {
      if (text) {
        this.emit({
          type: "session.warning",
          sessionId: this.sessionId,
          seatId,
          data: { kind: activity || "seat_notice", message: text },
        });
      }
      return;
    }
    const changed = this.status(seatId, status, text);
    if (changed && TOOL_ACTIVITIES.has(activity.trim().toLowerCase())) {
      this.emit({
        type: "seat.tool_call",
        sessionId: this.sessionId,
        seatId,
        data: { name: activity.trim().toLowerCase(), ...(text ? { summary: text } : {}) },
      });
    }
  }

  output(seatId: string, text: string): void {
    if (this.closed || text.length === 0) {
      return;
    }
    const used = this.outputChars.get(seatId) ?? 0;
    const room = Math.max(0, this.maxOutputCharsPerSeat - used);
    let kept = text.length > room ? text.slice(0, room) : text;
    // Don't leave half of a surrogate pair at the cut.
    if (kept.length < text.length && /[\uD800-\uDBFF]$/.test(kept)) {
      kept = kept.slice(0, -1);
    }
    if (kept.length > 0) {
      this.outputChars.set(seatId, used + kept.length);
      try {
        this.coalescer.push(seatId, kept);
      } catch (error) {
        this.report(error, "output batching");
      }
    }
    // Warn on the first dropped character, whichever chunk it is in.
    if (kept.length < text.length && !this.truncatedSeats.has(seatId)) {
      this.truncatedSeats.add(seatId);
      this.emit({
        type: "session.warning",
        sessionId: this.sessionId,
        seatId,
        data: {
          kind: "output_truncated",
          message: `Output for ${seatId} exceeded ${this.maxOutputCharsPerSeat} characters; the rest is not recorded.`,
        },
      });
    }
  }

  done(seatId: string, ok: boolean, summary?: string): void {
    this.emit({
      type: "seat.done",
      sessionId: this.sessionId,
      seatId,
      data: { ok, ...(summary ? { summary } : {}) },
    });
  }

  error(seatId: string, message: string): void {
    this.emit({ type: "seat.error", sessionId: this.sessionId, seatId, data: { message } });
  }

  /** Mirror a legacy supervisor event. */
  supervisor(event: SupervisorEvent, context: Omit<SupervisorEventContext, "sessionId">): void {
    try {
      const draft = fromSupervisorEvent(event, { ...context, sessionId: this.sessionId });
      // Stream-json executors put their whole protocol transcript here; the
      // seat's own events already carry what a UI needs.
      const data = draft.data as Record<string, unknown>;
      if (typeof data.rawOutput === "string") {
        const { rawOutput, ...rest } = data;
        draft.data = { ...rest, rawOutputChars: rawOutput.length } as typeof draft.data;
      }
      const ending = SESSION_END[event.type];
      if (ending) {
        // A session end closes every turn still open, so no seat is left "running".
        this.closeOpenTurns(ending);
      }
      this.emit(draft);
      // The panel seat gets `starting` from review.started but its verdict is a
      // review.verdict, not a seat event: end the reviewer-scoped turn here.
      if (event.type === "review.completed" && draft.seatId && this.openTurns.has(draft.seatId)) {
        const verdict = (draft.data as { status?: unknown }).status;
        this.done(draft.seatId, true, `verdict: ${String(verdict ?? "UNKNOWN")}`);
      }
    } catch (error) {
      this.report(error, "supervisor event mapping");
    }
  }

  /** Emit buffered output and wait until every queued event is written. Never rejects. */
  async flush(): Promise<void> {
    try {
      this.coalescer.flush();
    } catch (error) {
      this.report(error, "output batching");
    }
    await this.chain;
  }

  /** Flush, then stop accepting events. Never rejects. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.chain;
      return;
    }
    try {
      this.coalescer.dispose();
    } catch (error) {
      this.report(error, "output batching");
    }
    this.closed = true;
    await this.chain;
  }

  private closeOpenTurns(ending: { ok: boolean; label: string }): void {
    for (const seatId of [...this.openTurns]) {
      this.done(seatId, ending.ok, `session ${ending.label} before this seat reported`);
    }
  }

  /** False when this is a repeated `seat.status`. Other lifecycle events reset the seat's last status. */
  private trackStatus(draft: EngineEventDraft): boolean {
    const seatId = draft.seatId!;
    switch (draft.type) {
      case "seat.status": {
        const data = draft.data as { status?: unknown; detail?: unknown };
        const key = `${String(data.status)}\u0000${typeof data.detail === "string" ? data.detail : ""}`;
        if (this.lastStatus.get(seatId) === key) {
          return false;
        }
        this.lastStatus.set(seatId, key);
        if (isTerminalSeatStatus(data.status as SeatStatus)) {
          this.openTurns.delete(seatId);
        } else if (data.status !== "queued") {
          this.openTurns.add(seatId);
        }
        return true;
      }
      case "seat.spawned":
      case "seat.done":
      case "seat.error":
        this.lastStatus.delete(seatId);
        this.openTurns.delete(seatId);
        return true;
      case "seat.retry":
        this.lastStatus.delete(seatId);
        return true;
      default:
        return true;
    }
  }

  private flushSeat(seatId: string): void {
    try {
      this.coalescer.flush(seatId);
    } catch (error) {
      this.report(error, "output batching");
    }
  }

  private enqueue(draft: EngineEventDraft): Promise<void> {
    const next = this.chain.then(async () => {
      let event: EngineEvent;
      try {
        if (this.redact) {
          draft = { ...draft, data: redactStrings(draft.data) } as EngineEventDraft;
        }
        event = this.log
          ? await this.log.append(draft)
          : parseEngineEvent({
              ...draft,
              seq: ++this.memorySeq,
              at: draft.at ?? new Date().toISOString(),
            });
      } catch (error) {
        this.report(error, this.log ? "event log write" : "event validation");
        return;
      }
      try {
        this.onEvent?.(event);
      } catch (error) {
        this.report(error, "event listener");
      }
    });
    this.chain = next;
    return next;
  }

  private report(error: unknown, context: string): void {
    try {
      this.onError(error, context);
    } catch {
      // A broken error handler must not break the run either.
    }
  }
}

/** Copy `value` with secrets redacted from every string in it. */
function redactStrings<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value).text as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStrings(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item)]),
    ) as T;
  }
  return value;
}

/**
 * Wrap a reviewer so each turn reports `starting` → `done`/`error` on its own
 * seat. The reviewer's behaviour and name are unchanged.
 */
export function trackReviewerSeat(
  reviewer: Reviewer,
  seatId: string,
  getSink: () => SeatEventSink | undefined,
): Reviewer {
  const turn = async (
    call: () => Promise<ReviewerTurnResult>,
  ): Promise<ReviewerTurnResult> => {
    getSink()?.status(seatId, "starting");
    try {
      const result = await call();
      const sink = getSink();
      if (result.error) {
        sink?.error(seatId, result.error);
      } else {
        sink?.done(seatId, true, result.result?.summary);
      }
      return result;
    } catch (error) {
      getSink()?.error(seatId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return {
    name: reviewer.name,
    review: (input: ReviewInput) => turn(() => reviewer.review(input)),
    continue: (input: ReviewContinuation) => turn(() => reviewer.continue(input)),
  };
}
