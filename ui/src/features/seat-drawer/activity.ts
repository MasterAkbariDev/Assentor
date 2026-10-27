import { STATUS_META } from "@engine/ui-shared/status.js";
import type { EngineEvent } from "@engine/protocol/events.js";

/**
 * Activity rows for the seat drawer. Only the events that say something about
 * a seat's progress get a row; everything else is skipped. Pure, so the text
 * is easy to test. The text is plain: React renders it as text.
 */

export interface ActivityRow {
  /** The event's `seq`, unique within a session. */
  key: number;
  /** ISO-8601 time of the event. */
  at: string;
  /** Local `HH:MM:SS`. */
  time: string;
  text: string;
}

/** One row per relevant event, in the order given. */
export function activityRows(events: readonly EngineEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const event of events) {
    const text = activityText(event);
    if (text !== undefined) {
      rows.push({ key: event.seq, at: event.at, time: formatClock(event.at), text });
    }
  }
  return rows;
}

/** The row text for one event, or `undefined` when the drawer does not list it. */
export function activityText(event: EngineEvent): string | undefined {
  switch (event.type) {
    case "seat.status":
      return withDetail(STATUS_META[event.data.status].label, event.data.detail);
    case "seat.tool_call":
      return withDetail(`tool ${event.data.name}`, event.data.summary ?? event.data.file);
    case "seat.done":
      return withDetail(event.data.ok ? "done" : "failed", event.data.summary);
    case "seat.error":
      return `error: ${event.data.message}`;
    case "seat.retry": {
      const seconds = Math.ceil(event.data.delayMs / 1000);
      return withDetail(`retry ${event.data.attempt} of ${event.data.maxAttempts} in ${seconds} s`, event.data.reason);
    }
    case "seat.model.changed": {
      const change = event.data.from ? `model ${event.data.from} → ${event.data.to}` : `model ${event.data.to}`;
      return event.data.pending ? `${change} (from next turn)` : change;
    }
    case "review.verdict":
      return withDetail(`verdict ${event.data.status}`, event.data.summary);
    default:
      return undefined;
  }
}

function withDetail(head: string, detail: string | undefined): string {
  return detail ? `${head}: ${detail}` : head;
}

/** Local `HH:MM:SS` for an ISO-8601 time, or an empty string when it does not parse. */
export function formatClock(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
