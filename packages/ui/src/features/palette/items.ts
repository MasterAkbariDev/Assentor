import type { RpcMethodName, SessionSummary } from "#assentor/protocol/rpc.js";
import { parseCommand, type Command } from "./commands.js";

/** Why a write action is disabled when nothing more specific is known. */
export const WRITE_REASON = "needs write access (not in the watch-only preview)";

export type PaletteAction =
  | { kind: "session"; sessionId: string }
  | { kind: "view"; selector: string }
  /** Go to a top-level page: set the location hash (`#/prompts`). */
  | { kind: "route"; hash: string }
  | { kind: "command"; command: Command }
  /** Put `text` in the search box: the command needs arguments. */
  | { kind: "fill"; text: string }
  | { kind: "blocked"; reason: string };

export interface PaletteItem {
  id: string;
  group: "Recent" | "Session" | "View" | "Go to" | "Action";
  /** What the palette matches against: a run's title, a view's name, or a command such as `/pause`. */
  label: string;
  /** Short text after the label: a run's status, or what an action does. */
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
  hasReview: boolean;
  /** Why a write method can't be used now (read-only link, session not live…); undefined when it can. Default: always `WRITE_REASON`. */
  reasonFor?: (method: RpcMethodName) => string | undefined;
  /** The search text; a complete `/command …` adds a "Run" entry at the top. */
  query?: string;
}

/**
 * Write actions. `method` is the RPC behind it (its reason comes from `reasonFor`); `fill` is what
 * selecting it puts in the search box when it needs arguments; `blocked` is a fixed reason (no RPC works yet).
 */
export const WRITE_ACTIONS: ReadonlyArray<{ id: string; label: string; detail: string; method?: RpcMethodName; fill?: string; command?: Command; blocked?: string }> = [
  { id: "model", label: "/model <seat> <model>", detail: "Change a seat's model", method: "seat.setModel", fill: "/model " },
  { id: "pause", label: "/pause", detail: "Pause the session: no new turn starts", method: "session.pause", command: { name: "pause" } },
  { id: "resume", label: "/resume", detail: "Resume a paused session", method: "session.resume", command: { name: "resume" } },
  { id: "inject", label: "/inject <seat> <text>", detail: "Queue a message for a seat's next turn", method: "seat.inject", fill: "/inject " },
  { id: "restart", label: "/restart <seat>", detail: "Kill a seat's turn and run it again", method: "seat.restart", fill: "/restart " },
  { id: "approve", label: "/approve", detail: "Approve the pending approval", method: "session.approve", command: { name: "approve" } },
  { id: "stop", label: "/stop <seat>", detail: "Stop a seat", method: "seat.stop", fill: "/stop " },
  { id: "cancel", label: "/cancel", detail: "Cancel the session", method: "session.cancel", command: { name: "cancel" } },
];

const COMMAND_METHOD: Record<Command["name"], RpcMethodName> = { approve: "session.approve", cancel: "session.cancel", model: "seat.setModel", stop: "seat.stop", pause: "session.pause", resume: "session.resume", inject: "seat.inject", restart: "seat.restart" };

/** Views the UI renders, by the class of their root element. */
export const VIEW_TARGETS: ReadonlyArray<{ label: string; selector: string; shown: "hasSeats" | "hasNegotiation" | "hasLeadBoard" | "hasReview" }> = [
  { label: "Session board", selector: ".seat-board", shown: "hasSeats" },
  { label: "Negotiation", selector: ".negotiation", shown: "hasNegotiation" },
  { label: "Team board", selector: ".lead-board", shown: "hasLeadBoard" },
  { label: "Review", selector: ".review", shown: "hasReview" },
];

/** Pages the palette can open (their hash routes, see `shell/route.ts`). */
export const NAV_TARGETS: ReadonlyArray<{ label: string; hash: string; detail: string }> = [
  { label: "Prompts", hash: "#/prompts", detail: "Prompt library" },
  { label: "Teams", hash: "#/teams", detail: "Team definitions" },
  { label: "Playbooks", hash: "#/playbooks", detail: "Playbooks" },
];

/**
 * Every palette entry, in display order: recent runs, the other runs, views, pages, then
 * actions. A run in Recent is not repeated under Session.
 */
export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const recent = input.recentIds.filter((id) => byId.has(id));
  const recentSet = new Set(recent);
  const items: PaletteItem[] = [];
  for (const id of recent) {
    const session = byId.get(id)!;
    items.push({ id: `recent:${id}`, group: "Recent", label: session.title, detail: session.status, action: { kind: "session", sessionId: id } });
  }
  for (const session of input.sessions) {
    if (recentSet.has(session.id)) continue;
    items.push({ id: `session:${session.id}`, group: "Session", label: session.title, detail: session.status, action: { kind: "session", sessionId: session.id } });
  }
  for (const view of VIEW_TARGETS) {
    if (input[view.shown]) {
      items.push({ id: `view:${view.selector}`, group: "View", label: view.label, action: { kind: "view", selector: view.selector } });
    }
  }
  for (const nav of NAV_TARGETS) {
    items.push({ id: `nav:${nav.hash}`, group: "Go to", label: nav.label, detail: nav.detail, action: { kind: "route", hash: nav.hash } });
  }
  const reasonFor = input.reasonFor ?? (() => WRITE_REASON);
  for (const write of WRITE_ACTIONS) {
    const reason = write.blocked ?? (write.method ? reasonFor(write.method) : WRITE_REASON);
    const action: PaletteAction = reason
      ? { kind: "blocked", reason }
      : write.command
        ? { kind: "command", command: write.command }
        : { kind: "fill", text: write.fill ?? "" };
    items.push({ id: `write:${write.id}`, group: "Action", label: write.label, detail: write.detail, action });
  }
  // A typed command is run from the top of the list; a malformed one says what is wrong.
  const typed = input.query ? parseCommand(input.query) : undefined;
  if (typed) {
    const label = `Run ${input.query!.trim()}`;
    const reason = typed.ok ? reasonFor(COMMAND_METHOD[typed.command.name]) : typed.error;
    items.unshift({ id: "run:typed", group: "Action", label, action: reason ? { kind: "blocked", reason } : { kind: "command", command: (typed as { command: Command }).command } });
  }
  return items;
}
