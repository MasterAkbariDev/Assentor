import type { EngineEvent } from "#assentor/protocol/events.js";
import { formatClock } from "./activity.js";

/**
 * Transcript rows for the seat drawer, built from the seat events the store keeps:
 * tool calls, and each seat's final summary or error. Assistant message text is not
 * kept (`seat.output.delta` is too high-volume), so "messages" are only these.
 */

export type TranscriptItem =
  | { kind: "tool"; key: number; at: string; time: string; name: string; args?: string; /** The whole text, set only when `args` was cut. */ fullArgs?: string; file?: string }
  | { kind: "message"; key: number; at: string; time: string; text: string; error: boolean };

/** Longest tool args shown whole. */
const ARGS_MAX = 200;

/** A summary that is only a repo-relative path, such as `src/average.ts`. */
const PATH_ONLY = /^[\w@~./-]+\.\w{1,8}$/;

export function transcriptItems(events: readonly EngineEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const event of events) {
    const base = { key: event.seq, at: event.at, time: formatClock(event.at) };
    if (event.type === "seat.tool_call") {
      const { name, summary, file } = event.data;
      const path = file ?? (summary && PATH_ONLY.test(summary) && !summary.includes("://") ? summary : undefined);
      const cut = summary !== undefined && summary.length > ARGS_MAX;
      items.push({
        kind: "tool",
        ...base,
        name,
        ...(summary ? { args: cut ? `${summary.slice(0, ARGS_MAX)}…` : summary } : {}),
        ...(cut ? { fullArgs: summary } : {}),
        ...(path ? { file: path } : {}),
      });
    } else if (event.type === "seat.done") {
      items.push({ kind: "message", ...base, text: event.data.summary ?? (event.data.ok ? "Done." : "Failed."), error: !event.data.ok });
    } else if (event.type === "seat.error") {
      items.push({ kind: "message", ...base, text: event.data.message, error: true });
    }
  }
  return items;
}

/** Files named by tool calls, first seen first, without repeats. */
export function touchedFiles(items: readonly TranscriptItem[]): string[] {
  const files = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool" && item.file) files.add(item.file);
  }
  return [...files];
}

/** Link to the diff view (opened by `DiffView`) at one file of a seat's worktree. */
export function diffHref(seatId: string, file: string): string {
  return `#/sessions?diff=${encodeURIComponent(file)}&seat=${encodeURIComponent(seatId)}`;
}
