import type { SeatStatus } from "../core/seats.js";
import type { EngineEvent } from "../protocol/events.js";

/**
 * Shared seat status presentation and state (T01-06). Framework-free: no Ink,
 * no React, no I/O, so the web UI can reuse it later.
 *
 * Icons follow plan §4.6. `asciiIcon` is the fallback for terminals that
 * cannot draw them (ASSENTOR_ASCII=1, legacy Windows console).
 */

export type StatusTone = "muted" | "info" | "active" | "warn" | "ok" | "error";

export interface StatusMeta {
  icon: string;
  asciiIcon: string;
  label: string;
  tone: StatusTone;
}

export const STATUS_META: Record<SeatStatus, StatusMeta> = {
  queued: { icon: "◌", asciiIcon: ".", label: "queued", tone: "muted" },
  starting: { icon: "⟳", asciiIcon: "~", label: "starting", tone: "info" },
  thinking: { icon: "✦", asciiIcon: "*", label: "thinking", tone: "active" },
  writing: { icon: "✎", asciiIcon: ">", label: "writing", tone: "active" },
  tool: { icon: "🛠", asciiIcon: "T", label: "tool", tone: "active" },
  editing: { icon: "±", asciiIcon: "+-", label: "editing", tone: "active" },
  waiting: { icon: "⏸", asciiIcon: "||", label: "waiting", tone: "warn" },
  rate_limited: { icon: "⏳", asciiIcon: "...", label: "rate limited", tone: "warn" },
  done: { icon: "✓", asciiIcon: "OK", label: "done", tone: "ok" },
  failed: { icon: "✗", asciiIcon: "X", label: "failed", tone: "error" },
  dissent: { icon: "⚑", asciiIcon: "!", label: "dissent", tone: "warn" },
};

/** Most output text kept per seat. Older text is dropped. */
export const OUTPUT_TAIL_CHARS = 1_000;
/** Longest `lastLine` kept. */
export const LAST_LINE_CHARS = 120;

/** Everything a UI shows for one seat. Built by `reduceSeatEvents`. */
export interface SeatState {
  seatId: string;
  displayName: string;
  model: string;
  role: string;
  status: SeatStatus;
  detail?: string;
  /** Last non-empty line of `outputTail`, trimmed. */
  lastLine?: string;
  /** The last `OUTPUT_TAIL_CHARS` characters of seat output. */
  outputTail: string;
  /** ISO-8601. Set when the seat starts; kept across later status changes. */
  startedAt?: string;
  /** ISO-8601. Set when the seat is done or failed. */
  endedAt?: string;
  tokensIn: number;
  tokensOut: number;
}

export interface SeatLineModel {
  icon: string;
  label: string;
  name: string;
  model: string;
  role: string;
  /** `detail`, else `lastLine`, else empty. */
  detail: string;
  /** `m:ss`, or empty when the seat has not started. */
  elapsed: string;
}

/** One row of text for a seat. `now` is in ms, so the result is pure. */
export function seatLineModel(
  seat: SeatState,
  now: number,
  ascii = false,
): SeatLineModel {
  const meta = STATUS_META[seat.status];
  return {
    icon: ascii ? meta.asciiIcon : meta.icon,
    label: meta.label,
    name: seat.displayName,
    model: seat.model,
    role: seat.role,
    detail: seat.detail ?? seat.lastLine ?? "",
    elapsed: formatElapsed(seat, now),
  };
}

/** `m:ss` from `startedAt` to `endedAt` (or `now`). Empty when not started. */
function formatElapsed(seat: SeatState, now: number): string {
  if (!seat.startedAt) {
    return "";
  }
  const start = Date.parse(seat.startedAt);
  const end = seat.endedAt ? Date.parse(seat.endedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  const totalSeconds = Math.floor(Math.max(0, end - start) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Apply one engine event to the seat map. Returns a new map and new seat
 * objects; the input is never mutated. Events without a `seatId` are ignored.
 * An event for an unknown seat first creates a placeholder seat.
 */
export function reduceSeatEvents(
  state: Record<string, SeatState>,
  event: EngineEvent,
): Record<string, SeatState> {
  const seatId = event.seatId;
  if (!seatId) {
    return state;
  }

  const prev = state[seatId] ?? placeholderSeat(seatId);
  const next = applyEvent(prev, event);
  return { ...state, [seatId]: next };
}

function applyEvent(prev: SeatState, event: EngineEvent): SeatState {
  switch (event.type) {
    case "seat.spawned": {
      // Resume spawns the seat again: keep its tokens and output, reset the turn.
      const { displayName, model, role } = event.data;
      return {
        ...prev,
        displayName,
        model,
        role,
        status: "queued",
        detail: undefined,
        endedAt: undefined,
      };
    }

    case "seat.status": {
      const { status, detail } = event.data;
      const terminal = status === "done" || status === "failed";
      return {
        ...prev,
        status,
        detail,
        startedAt:
          status === "starting" || prev.startedAt === undefined
            ? event.at
            : prev.startedAt,
        endedAt: terminal ? event.at : undefined,
      };
    }

    case "seat.output.delta": {
      const outputTail = (prev.outputTail + event.data.text).slice(-OUTPUT_TAIL_CHARS);
      return { ...prev, outputTail, lastLine: lastLineOf(outputTail) };
    }

    case "seat.tool_call":
      return { ...prev, detail: event.data.summary ?? event.data.name };

    case "seat.tokens":
      return {
        ...prev,
        tokensIn: prev.tokensIn + event.data.tokensIn,
        tokensOut: prev.tokensOut + event.data.tokensOut,
      };

    case "seat.model.changed":
      return { ...prev, model: event.data.to };

    case "seat.error":
      return {
        ...prev,
        status: "failed",
        detail: event.data.message,
        endedAt: event.at,
      };

    case "seat.done":
      return {
        ...prev,
        status: event.data.ok ? "done" : "failed",
        detail: event.data.summary ?? prev.detail,
        endedAt: event.at,
      };

    case "seat.retry":
      return { ...prev, detail: "retrying" };

    default:
      return prev;
  }
}

function placeholderSeat(seatId: string): SeatState {
  return {
    seatId,
    displayName: seatId,
    model: "AUTO",
    role: "",
    status: "queued",
    outputTail: "",
    tokensIn: 0,
    tokensOut: 0,
  };
}

/** Last non-empty line of `text`, trimmed and cut to `LAST_LINE_CHARS`. */
function lastLineOf(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line.length > 0) {
      return line.slice(0, LAST_LINE_CHARS);
    }
  }
  return undefined;
}
