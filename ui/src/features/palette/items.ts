import type { SessionSummary } from "@engine/protocol/rpc.js";

/** Why a write action is listed but cannot run: the server has no write RPCs yet. */
export const WRITE_REASON = "needs write access (not in the watch-only preview)";

export type PaletteAction =
  | { kind: "session"; sessionId: string }
  | { kind: "view"; selector: string }
  | { kind: "blocked"; reason: string };

export interface PaletteItem {
  id: string;
  group: "Recent" | "Session" | "View" | "Action";
  label: string;
  /** Short text after the label: a run's status, or what the action does. */
  detail?: string;
  action: PaletteAction;
}

export interface PaletteInput {
  sessions: readonly SessionSummary[];
  recentIds: readonly string[];
  /** The selected run has seats, so the session board is on screen. */
  hasSeats: boolean;
  hasNegotiation: boolean;
  hasLeadBoard: boolean;
}

/** Actions that need write RPCs. Listed disabled so the palette shows what the full UI will do. */
export const WRITE_ACTIONS: ReadonlyArray<{ id: string; label: string; detail: string }> = [
  { id: "model", label: "/model <seat> <model>", detail: "Change a seat's model" },
  { id: "pause", label: "/pause", detail: "Pause the run" },
  { id: "inject", label: "/inject <seat> …", detail: "Send a message to a seat" },
  { id: "approve", label: "/approve", detail: "Approve the integration" },
];

/**
 * Views the UI renders, by the class of their root element. The review view
 * (T04-10p) is not on this branch yet, so it is not listed.
 */
export const VIEW_TARGETS: ReadonlyArray<{ label: string; selector: string; shown: "hasSeats" | "hasNegotiation" | "hasLeadBoard" }> = [
  { label: "Session board", selector: ".seat-board", shown: "hasSeats" },
  { label: "Negotiation", selector: ".negotiation", shown: "hasNegotiation" },
  { label: "Team board", selector: ".lead-board", shown: "hasLeadBoard" },
];

/** Every palette entry, in display order: recent runs, all runs, views, then actions. */
export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const items: PaletteItem[] = [];
  for (const id of input.recentIds) {
    const session = byId.get(id);
    if (session) {
      items.push({ id: `recent:${id}`, group: "Recent", label: session.title, detail: session.status, action: { kind: "session", sessionId: id } });
    }
  }
  for (const session of input.sessions) {
    items.push({ id: `session:${session.id}`, group: "Session", label: session.title, detail: session.status, action: { kind: "session", sessionId: session.id } });
  }
  for (const view of VIEW_TARGETS) {
    if (input[view.shown]) {
      items.push({ id: `view:${view.selector}`, group: "View", label: view.label, action: { kind: "view", selector: view.selector } });
    }
  }
  for (const write of WRITE_ACTIONS) {
    items.push({ id: `write:${write.id}`, group: "Action", label: `${write.label}  ${write.detail}`, detail: WRITE_REASON, action: { kind: "blocked", reason: WRITE_REASON } });
  }
  return items;
}
