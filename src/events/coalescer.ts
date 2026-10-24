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
  emit: (delta: CoalescedDelta) => void;
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
  /** Flush everything and clear all timers. Throws if `push` is called afterwards. */
  dispose(): void;
}

interface SeatBuffer {
  text: string;
  timer?: unknown;
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
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const buffers = new Map<string, SeatBuffer>();
  let disposed = false;

  function emitSeat(seatId: string): void {
    const buffer = buffers.get(seatId);
    if (!buffer) {
      return;
    }
    if (buffer.timer !== undefined) {
      clearTimer(buffer.timer);
    }
    buffers.delete(seatId);
    if (buffer.text.length > 0) {
      emit({ seatId, text: buffer.text });
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
        emitSeat(seatId);
        return;
      }
      if (buffer.timer === undefined) {
        buffer.timer = setTimer(() => emitSeat(seatId), intervalMs);
      }
    },

    flush(seatId) {
      if (seatId !== undefined) {
        emitSeat(seatId);
        return;
      }
      for (const id of [...buffers.keys()]) {
        emitSeat(id);
      }
    },

    dispose() {
      for (const id of [...buffers.keys()]) {
        emitSeat(id);
      }
      disposed = true;
    },
  };
}
