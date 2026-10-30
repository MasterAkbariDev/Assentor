import type { EngineEvent } from "../protocol/events.js";

/**
 * Lead team board view model (T02B-18). Framework-free: no Ink, no React, no
 * I/O, so the web UI (T04-17) can reuse it. Folds the Lead controller's events
 * (`task.*`, `lead.turn`, `lead.action`, `seat.spawned`) into the board and the
 * last few lead actions. Every string from the model is made plain here, so a
 * UI shows it as text and never as terminal control codes.
 */

/** Lead actions kept in the log view. */
export const LEAD_LOG_LIMIT = 5;
/** Longest plain text kept for a title, owner, action or reason. */
const TEXT_LIMIT = 500;

export const LEAD_COLUMNS = ["backlog", "in_progress", "in_review", "done"] as const;
export type LeadColumn = (typeof LEAD_COLUMNS)[number];

export const LEAD_COLUMN_LABELS: Record<LeadColumn, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

/** A task's state as the view knows it: the controller's board statuses, plus `integrated`. */
export type LeadTaskState =
  | "backlog"
  | "assigned"
  | "in_progress"
  | "in_review"
  | "accepted"
  | "rejected"
  | "integrated"
  | "split";

export interface LeadTaskView {
  id: string;
  title: string;
  state: LeadTaskState;
  /** Display name of the seat that owns the task, else the seat id. Empty before assignment. */
  owner: string;
}

export interface LeadLogEntry {
  action: string;
  accepted: boolean;
  reason: string;
}

export interface LeadBoardView {
  /** Turn of the last `lead.turn`; 0 before the first. */
  turn: number;
  /** Tasks in creation order. Split parents stay here but sit in no column. */
  tasks: LeadTaskView[];
  /** Seat display names by seat id, from `seat.spawned`. */
  seatNames: Record<string, string>;
  /** The last `LEAD_LOG_LIMIT` lead actions, oldest first. */
  log: LeadLogEntry[];
}

export function emptyLeadBoardView(): LeadBoardView {
  return { turn: 0, tasks: [], seatNames: {}, log: [] };
}

/** The column a task state sits in. `split` parents have none. */
export function leadColumnOf(state: LeadTaskState): LeadColumn | undefined {
  switch (state) {
    case "backlog":
    case "rejected":
      return "backlog";
    case "assigned":
    case "in_progress":
      return "in_progress";
    case "in_review":
      return "in_review";
    case "accepted":
    case "integrated":
      return "done";
    case "split":
      return undefined;
  }
}

/** Tasks per column, in board order. */
export function leadColumns(view: LeadBoardView): Record<LeadColumn, LeadTaskView[]> {
  const columns: Record<LeadColumn, LeadTaskView[]> = { backlog: [], in_progress: [], in_review: [], done: [] };
  for (const task of view.tasks) {
    const column = leadColumnOf(task.state);
    if (column) columns[column].push(task);
  }
  return columns;
}

// Terminal escape sequences (OSC, CSI, two-byte) and C0/C1 control characters.
const TERMINAL_SEQUENCES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
// Invisible format characters, including bidi overrides that could visually reorder a line.
const FORMAT_CHARS = /\p{Cf}/gu;

/** `value` as one line of plain text: escape codes and control characters removed, whitespace collapsed, cut to a limit. */
export function plainText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(TERMINAL_SEQUENCES, "").replace(CONTROL_CHARS, " ").replace(FORMAT_CHARS, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned); // code points, so a cut never splits a surrogate pair
  return chars.length > TEXT_LIMIT ? `${chars.slice(0, TEXT_LIMIT - 1).join("")}…` : cleaned;
}

/** Folds one engine event into the view. Returns the same object when the event changes nothing. */
export function reduceLeadEvents(view: LeadBoardView, event: EngineEvent): LeadBoardView {
  switch (event.type) {
    case "lead.turn":
      return { ...view, turn: event.data.turn };

    case "lead.action": {
      const entry: LeadLogEntry = {
        action: plainText(event.data.action),
        accepted: event.data.accepted,
        reason: plainText(event.data.reason),
      };
      return { ...view, log: [...view.log, entry].slice(-LEAD_LOG_LIMIT) };
    }

    case "seat.spawned":
      if (!event.seatId) return view;
      return { ...view, seatNames: { ...view.seatNames, [event.seatId]: plainText(event.data.displayName) } };

    case "task.created": {
      const data = event.data as { taskId: string; title?: unknown; parentId?: unknown };
      const id = plainText(data.taskId);
      if (!id) return view;
      const title = plainText(data.title);
      const withParent = typeof data.parentId === "string" ? updateTask(view, data.parentId, { state: "split" }) : view;
      if (findTask(withParent, id)) return updateTask(withParent, id, { title });
      return { ...withParent, tasks: [...withParent.tasks, { id, title, state: "backlog", owner: "" }] };
    }

    case "task.assigned":
      return updateTask(view, event.data.taskId, {
        state: "assigned",
        owner: (Object.hasOwn(view.seatNames, event.data.seatId) && view.seatNames[event.data.seatId]) || plainText(event.data.seatId),
      });

    case "task.status": {
      const state = taskStateOf(event.data.status);
      return state ? updateTask(view, event.data.taskId, { state }) : view;
    }

    case "task.accepted":
      return updateTask(view, event.data.taskId, { state: "accepted" });

    case "task.rejected":
      return updateTask(view, event.data.taskId, { state: "rejected" });

    default:
      return view;
  }
}

/** The task statuses a `task.status` event can carry that move a task on the board. */
function taskStateOf(status: string): LeadTaskState | undefined {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "in_review":
      return "in_review";
    case "integrated":
      return "integrated";
    default:
      return undefined;
  }
}

function findTask(view: LeadBoardView, taskId: string): LeadTaskView | undefined {
  const want = plainText(taskId).toLowerCase();
  return view.tasks.find((task) => task.id.toLowerCase() === want);
}

/** Task ids compare case-insensitively. Unknown ids leave the view as it is. */
function updateTask(view: LeadBoardView, taskId: unknown, change: Partial<Omit<LeadTaskView, "id">>): LeadBoardView {
  const found = findTask(view, plainText(taskId));
  if (!found) return view;
  return {
    ...view,
    tasks: view.tasks.map((task) => (task === found ? { ...task, ...change } : task)),
  };
}
