/** One batch of output text for a single seat, ready to become an event. */
export interface CoalescedDelta {
  seatId: string;
  text: string;
}

export interface DeltaCoalescerOptions {
  /** How long a seat's text may wait before it is emitted. Default 40 ms. */
  intervalMs?: number;
  /** A seat's buffer longer than this is emitted immediately. Default 8192. */
  maxChars?: number;
  /**
   * Receives each batch. May return a Promise; a rejection is routed to `onError`.
   */
  emit: (delta: CoalescedDelta) => unknown;
  /**
   * Called when an emit fails on a timer, or when an emit's Promise rejects.
   * Default: one line on stderr. Explicit calls throw synchronously instead.
   */
  onError?: (error: unknown, seatId: string) => void;
  /** Accepted for parity with the other injectable clocks; batching is timer-driven, so it is unused. */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DeltaCoalescer {
  /** Append text for a seat. Text order within a seat is preserved. */
  push(seatId: string, text: string): void;
  /** Emit one seat's buffer now, or every seat's buffer when no id is given. Empty buffers never emit. */
  flush(seatId?: string): void;
  /**
   * Flush every seat and clear all timers, even if an emit throws. Throws the
   * first error (or an AggregateError for several) after everything is flushed.
   * Throws if `push` is called afterwards.
   */
  dispose(): void;
}

interface SeatBuffer {
  text: string;
  timer?: unknown;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * Batches high-frequency `seat.output.delta` text per seat, so a UI receives a
 * few frames per interval instead of one per token. Each seat is batched on
 * its own; different seats never merge.
 */
export function createDeltaCoalescer(options: DeltaCoalescerOptions): DeltaCoalescer {
  const intervalMs = options.intervalMs ?? 40;
  const maxChars = options.maxChars ?? 8_192;
  const emit = options.emit;
  const onError =
    options.onError ??
    ((error: unknown, seatId: string) => {
      console.error(`[assentor] delta coalescer emit failed for ${seatId}:`, error);
    });
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const buffers = new Map<string, SeatBuffer>();
  let disposed = false;

  /** Remove a seat's buffer, clear its timer, and return the text (if any). */
  function take(seatId: string): CoalescedDelta | undefined {
    const buffer = buffers.get(seatId);
    if (!buffer) {
      return undefined;
    }
    if (buffer.timer !== undefined) {
      clearTimer(buffer.timer);
    }
    buffers.delete(seatId);
    return buffer.text.length > 0 ? { seatId, text: buffer.text } : undefined;
  }

  /** Hand a batch to `emit`. Sync errors propagate; a rejected Promise goes to `onError`. */
  function send(delta: CoalescedDelta): void {
    const result = emit(delta);
    if (isThenable(result)) {
      result.then(undefined, (error: unknown) => onError(error, delta.seatId));
    }
  }

  /** Explicit flush of one seat: a synchronous emit error reaches the caller. */
  function flushSeat(seatId: string): void {
    const delta = take(seatId);
    if (delta) {
      send(delta);
    }
  }

  /** Flush every seat even if some emits throw, then throw the collected errors. */
  function flushAll(): void {
    const errors: unknown[] = [];
    for (const id of [...buffers.keys()]) {
      try {
        flushSeat(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} delta emits failed`);
    }
  }

  return {
    push(seatId, text) {
      if (disposed) {
        throw new Error("Delta coalescer is disposed");
      }
      if (text.length === 0) {
        return;
      }
      let buffer = buffers.get(seatId);
      if (!buffer) {
        buffer = { text: "" };
        buffers.set(seatId, buffer);
      }
      buffer.text += text;

      if (buffer.text.length > maxChars) {
        flushSeat(seatId);
        return;
      }
      if (buffer.timer === undefined) {
        buffer.timer = setTimer(() => {
          // Never throw out of a timer callback: an uncaught error would crash the process.
          const delta = take(seatId);
          if (!delta) {
            return;
          }
          try {
            send(delta);
          } catch (error) {
            onError(error, seatId);
          }
        }, intervalMs);
      }
    },

    flush(seatId) {
      if (seatId !== undefined) {
        flushSeat(seatId);
        return;
      }
      flushAll();
    },

    dispose() {
      disposed = true;
      flushAll();
    },
  };
}
