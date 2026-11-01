import type { EngineEvent } from "#assentor/protocol/events.js";

/**
 * Lead team board view model (T02B-18). Framework-free: no Ink, no React, no
 * I/O, so the web UI (T04-17) can reuse it. Folds the Lead controller's events
 * (`task.*`, `lead.turn`, `lead.action`, `seat.spawned`) into the board and the
 * last few lead actions. Every string from the model is made plain here, so a
 * UI shows it as text and never as terminal control codes.
 */

/** Lead actions kept in the terminal log view. */
export const LEAD_LOG_LIMIT = 5;
/** Lead actions kept in the web log view. Older ones are dropped; `actionsTotal` still counts them. */
export const LEAD_ACTION_LIMIT = 500;
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

/** The web board's columns (T04-17), one per stage a task can sit in. */
export const LEAD_STAGES = ["backlog", "assigned", "in_progress", "in_review", "accepted", "rejected"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  backlog: "Backlog",
  assigned: "Assigned",
  in_progress: "In progress",
  in_review: "In review",
  accepted: "Accepted",
  rejected: "Rejected",
};

export interface LeadTaskView {
  id: string;
  title: string;
  state: LeadTaskState;
  /** Display name of the seat that owns the task, else the seat id. Empty before assignment. */
  owner: string;
  /** Controller id of the owner seat (e.g. "seat-1"), empty before assignment. A key for the drawer; never rendered. */
  seatId: string;
  /**
   * Times the task was given out again: assigned after a rejection, or moved to a different seat
   * (the same rule as board.ts reassignCount). A same-seat restart of a task that was not rejected
   * is not counted, because `task.assigned` does not say which controller op ran.
   */
  reassigns: number;
  /** `task.escalated` events seen for the task. */
  escalations: number;
  /** Model the user pinned for the task's next runs (FU-18b `lead.pin`); absent when not pinned. */
  pinnedModel?: string;
}

export interface LeadLogEntry {
  action: string;
  accepted: boolean;
  reason: string;
  /** Set for a user's override, pin, pause or resume (FU-18b); absent for the lead's own actions. */
  by?: "user";
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
  /** The last `LEAD_ACTION_LIMIT` lead actions, oldest first (the web log; `log` is the terminal's short view). */
  actions: LeadLogEntry[];
  /** Every lead action seen in this run, including those dropped from `actions`. */
  actionsTotal: number;
  /** The user paused the lead (FU-18b `lead.pause`) and has not resumed it. */
  paused: boolean;
}

export function emptyLeadBoardView(): LeadBoardView {
  return { turn: 0, tasks: [], seatNames: {}, log: [], actions: [], actionsTotal: 0, paused: false };
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

/** The web board's stage of a task state. `split` parents have none. */
export function leadStageOf(state: LeadTaskState): LeadStage | undefined {
  switch (state) {
    case "backlog":
      return "backlog";
    case "assigned":
      return "assigned";
    case "in_progress":
      return "in_progress";
    case "in_review":
      return "in_review";
    case "accepted":
    case "integrated":
      return "accepted";
    case "rejected":
      return "rejected";
    case "split":
      return undefined;
  }
}

/** Tasks per web stage, in board order. */
export function leadStages(view: LeadBoardView): Record<LeadStage, LeadTaskView[]> {
  const stages: Record<LeadStage, LeadTaskView[]> = { backlog: [], assigned: [], in_progress: [], in_review: [], accepted: [], rejected: [] };
  for (const task of view.tasks) {
    const stage = leadStageOf(task.state);
    if (stage) stages[stage].push(task);
  }
  return stages;
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
      const user = event.data.by === "user";
      const entry: LeadLogEntry = {
        action: plainText(event.data.action),
        accepted: event.data.accepted,
        reason: plainText(event.data.reason),
        ...(user ? { by: "user" as const } : {}),
      };
      return {
        ...userControl(view, event.data, user),
        log: [...view.log, entry].slice(-LEAD_LOG_LIMIT),
        actions: [...view.actions, entry].slice(-LEAD_ACTION_LIMIT),
        actionsTotal: view.actionsTotal + 1,
      };
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
      return { ...withParent, tasks: [...withParent.tasks, { id, title, state: "backlog", owner: "", seatId: "", reassigns: 0, escalations: 0 }] };
    }

    case "task.assigned": {
      const task = findTask(view, plainText(event.data.taskId));
      if (!task) return view;
      const seatId = event.data.seatId;
      return updateTask(view, task.id, {
        state: "assigned",
        owner: (Object.hasOwn(view.seatNames, seatId) && view.seatNames[seatId]) || plainText(seatId),
        seatId,
        // A reassign: a rejected task given out again, or a task that moves to another seat.
        reassigns: task.state === "rejected" || (task.seatId !== "" && task.seatId !== seatId) ? task.reassigns + 1 : task.reassigns,
      });
    }

    case "task.escalated": {
      const task = findTask(view, plainText(event.data.taskId));
      return task ? updateTask(view, task.id, { escalations: task.escalations + 1 }) : view;
    }

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

/** What an accepted user control changes besides the log: the pause flag, a task's pin. */
function userControl(view: LeadBoardView, data: { action: string; accepted: boolean; [key: string]: unknown }, user: boolean): LeadBoardView {
  if (!user || !data.accepted) return view;
  if (data.action === "pause" || data.action === "resume") return { ...view, paused: data.action === "pause" };
  if (data.action !== "pin") return view;
  const model = typeof data.model === "string" ? plainText(data.model) : "";
  const task = findTask(view, plainText(data.taskId));
  if (!task) return view;
  const { pinnedModel: _old, ...rest } = task;
  return { ...view, tasks: view.tasks.map((t) => (t === task ? (model ? { ...rest, pinnedModel: model } : rest) : t)) };
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
