import type { Seat } from "#assentor/protocol/seats.js";
import {
  NegotiationCancelledError,
  STEP_REPLY_SCHEMAS,
  type AskSeatOptions,
  type NegotiationContext,
  type NegotiationEventInput,
  type NegotiationStep,
  type SeatReply,
  type StepReply,
} from "../strategy.js";

/**
 * Scripted `NegotiationContext` for strategy tests (T02-03a). Deterministic:
 * the script decides every reply; nothing spawns or touches the disk.
 */

export interface MockAsk {
  seatId: string;
  step: NegotiationStep;
  vars: Readonly<Record<string, unknown>>;
  options: AskSeatOptions;
  /** 1-based count of calls to this seat for this step. */
  call: number;
}

/**
 * Return the raw reply (validated against the step schema like the real
 * engine does), `{ fail: "message" }` for an operational failure, or throw to
 * simulate a crash (the mock turns a throw into `ok: false`, as the engine does).
 */
export type MockScript = (ask: MockAsk) => unknown;

export interface MockNegotiationOptions {
  seats: readonly Seat[];
  script: MockScript;
  goal?: string;
  sessionId?: string;
  options?: Record<string, unknown>;
  /** Abort to simulate cancellation; asks after abort reject with NegotiationCancelledError. */
  signal?: AbortSignal;
}

export interface MockNegotiationContext {
  ctx: NegotiationContext;
  asks: MockAsk[];
  events: NegotiationEventInput[];
}

export function createMockNegotiationContext(input: MockNegotiationOptions): MockNegotiationContext {
  const asks: MockAsk[] = [];
  const events: NegotiationEventInput[] = [];
  const calls = new Map<string, number>();
  const signal = input.signal ?? new AbortController().signal;
  const seatIds = new Set(input.seats.map((seat) => seat.id));

  const ctx: NegotiationContext = {
    sessionId: input.sessionId ?? "00000000-0000-4000-8000-000000000000",
    goal: input.goal ?? "Test goal",
    seats: input.seats,
    options: input.options ?? {},
    signal,
    async askSeat<S extends NegotiationStep>(
      seatId: string,
      step: S,
      vars: Readonly<Record<string, unknown>>,
      options: AskSeatOptions,
    ): Promise<SeatReply<S>> {
      if (signal.aborted) {
        throw new NegotiationCancelledError();
      }
      if (!seatIds.has(seatId)) {
        throw new Error(`mock: unknown seat ${seatId}`);
      }
      const key = `${seatId}\u0000${step}`;
      const call = (calls.get(key) ?? 0) + 1;
      calls.set(key, call);
      const ask: MockAsk = { seatId, step, vars, options, call };
      asks.push(ask);

      let raw: unknown;
      try {
        raw = input.script(ask);
      } catch (error) {
        return { ok: false, seatId, error: error instanceof Error ? error.message : String(error) };
      }
      if (raw && typeof raw === "object" && "fail" in raw && typeof (raw as { fail: unknown }).fail === "string") {
        return { ok: false, seatId, error: (raw as { fail: string }).fail };
      }
      const parsed = STEP_REPLY_SCHEMAS[step].safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          seatId,
          error: `invalid ${step} reply: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`,
        };
      }
      return { ok: true, seatId, data: parsed.data as StepReply<S> };
    },
    emit(event: NegotiationEventInput): void {
      events.push(event);
    },
  };

  return { ctx, asks, events };
}
