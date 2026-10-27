import { BoardOpSchema, type BoardOp, type LeadTask, type LeadTaskPlan, type LeadTaskStatus, type TaskBoard } from "./types.js";

/**
 * Lead task board (task T02B-05). Pure: `applyBoardOp` never mutates its input.
 * Every operation returns a new board, or the original board object with an
 * `error` when the operation is refused.
 *
 * Task ids compare case-insensitively everywhere (lookup, `dependsOn`, duplicate
 * checks). Owned paths compare case-insensitively on `/` segments.
 *
 * Rules, all checked on the whole board after each operation:
 * - every `dependsOn` names an existing task; the dependency graph has no cycle;
 * - two tasks that are parallel (neither depends on the other, directly or
 *   transitively) and both still open (not `accepted`, `rejected` or `split`)
 *   may not own overlapping paths. Paths overlap when one is a segment prefix of
 *   the other (`src/auth` overlaps `src/auth/x.ts`, not `src/authz`).
 *
 * Decisions (not spelled out in the card):
 * - `plan` replaces a backlog, unassigned task with the same id and keeps every
 *   other existing task, so a planned id that clashes with an assigned or closed
 *   task is an error.
 * - `split` makes the parent `split` and its children `backlog` with
 *   `parentId`. Each child's `dependsOn` is the parent's plus its own. A task
 *   that depended on the parent now depends on all children, since the parent
 *   never reaches `accepted`.
 * - `assign` does not check `dependsOn`; `readyTasks` is where readiness lives.
 */

export interface ApplyBoardOpResult {
  board: TaskBoard;
  /** Set when the operation is refused. `board` is then the input, unchanged. */
  error?: string;
}

/** Statuses after which a task no longer takes part in overlap checks. */
const CLOSED_STATUSES: ReadonlySet<LeadTaskStatus> = new Set<LeadTaskStatus>([
  "accepted",
  "rejected",
  "split",
]);

class BoardError extends Error {}

/** Apply one board operation. Returns the new board, or the input board with `error`. */
export function applyBoardOp(board: TaskBoard, op: BoardOp): ApplyBoardOpResult {
  const parsed = BoardOpSchema.safeParse(op);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { board, error: `invalid board op: ${where}${issue?.message ?? "malformed op"}` };
  }
  try {
    const next = runOp(board, parsed.data);
    validateBoard(next);
    return { board: next };
  } catch (error) {
    if (error instanceof BoardError) {
      return { board, error: error.message };
    }
    throw error;
  }
}

/** Tasks in each status group, in board order. `split` is included so no task is missing. */
export interface BoardColumns {
  backlog: LeadTask[];
  assigned: LeadTask[];
  inProgress: LeadTask[];
  inReview: LeadTask[];
  accepted: LeadTask[];
  rejected: LeadTask[];
  split: LeadTask[];
}

export function boardColumns(board: TaskBoard): BoardColumns {
  const columns: BoardColumns = {
    backlog: [],
    assigned: [],
    inProgress: [],
    inReview: [],
    accepted: [],
    rejected: [],
    split: [],
  };
  for (const task of board.tasks) {
    switch (task.status) {
      case "backlog":
        columns.backlog.push(task);
        break;
      case "assigned":
        columns.assigned.push(task);
        break;
      case "in_progress":
        columns.inProgress.push(task);
        break;
      case "in_review":
        columns.inReview.push(task);
        break;
      case "accepted":
        columns.accepted.push(task);
        break;
      case "rejected":
        columns.rejected.push(task);
        break;
      case "split":
        columns.split.push(task);
        break;
    }
  }
  return columns;
}

/** Backlog tasks, unassigned, whose dependencies are all accepted. Board order. */
export function readyTasks(board: TaskBoard): LeadTask[] {
  const accepted = new Set(
    board.tasks.filter((task) => task.status === "accepted").map((task) => key(task.id)),
  );
  return board.tasks.filter(
    (task) =>
      task.status === "backlog" &&
      task.assignee === undefined &&
      task.dependsOn.every((dep) => accepted.has(key(dep))),
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function runOp(board: TaskBoard, op: BoardOp): TaskBoard {
  switch (op.op) {
    case "plan":
      return planTasks(board, op.tasks);

    case "assign": {
      const { index, task } = requireTask(board, op.taskId);
      if (task.status !== "backlog" && task.status !== "rejected") {
        throw transitionError(task, "assigned");
      }
      return replaceAt(board, index, { ...task, status: "assigned", assignee: op.seatId });
    }

    case "status": {
      const { index, task } = requireTask(board, op.taskId);
      if (task.status !== "assigned" && task.status !== "in_progress") {
        throw transitionError(task, op.status);
      }
      return replaceAt(board, index, {
        ...task,
        status: op.status,
        escalationCount: task.escalationCount + (op.escalated === true ? 1 : 0),
      });
    }

    case "accept": {
      const { index, task } = requireTask(board, op.taskId);
      if (task.status !== "in_review") {
        throw transitionError(task, "accepted");
      }
      return replaceAt(board, index, { ...task, status: "accepted" });
    }

    case "reject": {
      const { index, task } = requireTask(board, op.taskId);
      if (task.status !== "in_review" && task.status !== "in_progress") {
        throw transitionError(task, "rejected");
      }
      return replaceAt(board, index, {
        ...task,
        status: "rejected",
        rejectionReason: op.reason,
      });
    }

    case "reassign": {
      const { index, task } = requireTask(board, op.taskId);
      if (task.status !== "assigned" && task.status !== "in_progress" && task.status !== "rejected") {
        throw transitionError(task, "assigned");
      }
      return replaceAt(board, index, {
        ...task,
        status: "assigned",
        assignee: op.seatId,
        reassignCount: task.reassignCount + 1,
      });
    }

    case "split":
      return splitTask(board, op.taskId, op.tasks);
  }
}

/** Adds planned tasks and replaces backlog, unassigned tasks with the same id. */
function planTasks(board: TaskBoard, planned: LeadTaskPlan[]): TaskBoard {
  const plannedKeys = new Set<string>();
  for (const plan of planned) {
    const id = key(plan.id);
    if (plannedKeys.has(id)) {
      throw new BoardError(`duplicate task id in plan: ${plan.id}`);
    }
    plannedKeys.add(id);

    const existing = findTask(board, plan.id);
    if (existing && (existing.status !== "backlog" || existing.assignee !== undefined)) {
      throw new BoardError(
        `task ${existing.id} is ${existing.status}; a plan can only replace backlog tasks`,
      );
    }
  }

  const replaced = board.tasks.map((task) => {
    const plan = planned.find((candidate) => key(candidate.id) === key(task.id));
    return plan && task.status === "backlog" && task.assignee === undefined ? freshTask(plan) : task;
  });
  const added = planned
    .filter((plan) => findTask(board, plan.id) === undefined)
    .map((plan) => freshTask(plan));
  return { tasks: [...replaced, ...added] };
}

/** Parent becomes `split`; children follow it in board order. */
function splitTask(board: TaskBoard, taskId: string, children: LeadTaskPlan[]): TaskBoard {
  const { index, task: parent } = requireTask(board, taskId);
  if (CLOSED_STATUSES.has(parent.status)) {
    throw new BoardError(`task ${parent.id} cannot be split from ${parent.status}`);
  }

  const childIds = new Set<string>();
  for (const child of children) {
    const id = key(child.id);
    if (childIds.has(id) || findTask(board, child.id) !== undefined) {
      throw new BoardError(`task id ${child.id} is already used`);
    }
    childIds.add(id);
  }

  const newChildren: LeadTask[] = children.map((child) => ({
    ...freshTask(child),
    parentId: parent.id,
    dependsOn: uniqueIds([...parent.dependsOn, ...child.dependsOn]),
  }));
  const newChildIds = newChildren.map((child) => child.id);

  const tasks: LeadTask[] = [];
  board.tasks.forEach((task, position) => {
    if (position === index) {
      tasks.push({ ...task, status: "split" }, ...newChildren);
      return;
    }
    // Dependents of the parent now depend on every child instead.
    tasks.push(
      task.dependsOn.some((dep) => key(dep) === key(parent.id))
        ? {
            ...task,
            dependsOn: uniqueIds(
              task.dependsOn.flatMap((dep) => (key(dep) === key(parent.id) ? newChildIds : [dep])),
            ),
          }
        : task,
    );
  });
  return { tasks };
}

// ---------------------------------------------------------------------------
// Whole-board validation
// ---------------------------------------------------------------------------

function validateBoard(board: TaskBoard): void {
  for (const task of board.tasks) {
    for (const dep of task.dependsOn) {
      if (findTask(board, dep) === undefined) {
        throw new BoardError(`task ${task.id} depends on unknown task ${dep}`);
      }
    }
  }

  const cycle = findCycle(board);
  if (cycle) {
    throw new BoardError(`dependency cycle: ${cycle.join(" → ")}`);
  }

  const overlap = findOverlap(board);
  if (overlap) {
    throw new BoardError(
      `tasks ${overlap.first} and ${overlap.second} both own ${overlap.path}`,
    );
  }
}

/** The first dependency cycle as a path ending where it started, e.g. ["A", "B", "A"]. */
function findCycle(board: TaskBoard): string[] | undefined {
  const byKey = new Map(board.tasks.map((task) => [key(task.id), task]));
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];

  const visit = (task: LeadTask): string[] | undefined => {
    state.set(key(task.id), "active");
    stack.push(task.id);
    for (const dep of task.dependsOn) {
      const next = byKey.get(key(dep));
      if (!next) {
        continue; // unknown dependencies are reported separately
      }
      const nextState = state.get(key(next.id));
      if (nextState === "active") {
        const start = stack.findIndex((id) => key(id) === key(next.id));
        return [...stack.slice(start), next.id];
      }
      if (nextState === undefined) {
        const cycle = visit(next);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.pop();
    state.set(key(task.id), "done");
    return undefined;
  };

  for (const task of board.tasks) {
    if (!state.has(key(task.id))) {
      const cycle = visit(task);
      if (cycle) {
        return cycle;
      }
    }
  }
  return undefined;
}

/** The first pair of open, parallel tasks that own overlapping paths, in board order. */
function findOverlap(
  board: TaskBoard,
): { first: string; second: string; path: string } | undefined {
  const reach = transitiveDependencies(board);
  const open = board.tasks.filter((task) => !CLOSED_STATUSES.has(task.status) && task.ownedPaths.length > 0);

  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const a = open[i]!;
      const b = open[j]!;
      if (reach.get(key(a.id))?.has(key(b.id)) || reach.get(key(b.id))?.has(key(a.id))) {
        continue; // one depends on the other, so they are not parallel
      }
      for (const pathA of a.ownedPaths) {
        for (const pathB of b.ownedPaths) {
          const shared = sharedPrefix(pathA, pathB);
          if (shared !== undefined) {
            return { first: a.id, second: b.id, path: shared };
          }
        }
      }
    }
  }
  return undefined;
}

/** For each task, the keys of every task it depends on, directly or transitively. */
function transitiveDependencies(board: TaskBoard): Map<string, Set<string>> {
  const direct = new Map(board.tasks.map((task) => [key(task.id), task.dependsOn.map(key)]));
  const reach = new Map<string, Set<string>>();
  const collect = (id: string): Set<string> => {
    const known = reach.get(id);
    if (known) {
      return known;
    }
    const all = new Set<string>();
    reach.set(id, all);
    for (const dep of direct.get(id) ?? []) {
      all.add(dep);
      for (const deeper of collect(dep)) {
        all.add(deeper);
      }
    }
    return all;
  };
  for (const id of direct.keys()) {
    collect(id);
  }
  return reach;
}

/** The shorter path when one is a segment prefix of the other (case-insensitive), else undefined. */
function sharedPrefix(a: string, b: string): string | undefined {
  const segmentsA = a.toLowerCase().split("/");
  const segmentsB = b.toLowerCase().split("/");
  const shorter = segmentsA.length <= segmentsB.length ? segmentsA : segmentsB;
  const longer = shorter === segmentsA ? segmentsB : segmentsA;
  const isPrefix = shorter.every((segment, index) => segment === longer[index]);
  return isPrefix ? (shorter === segmentsA ? a : b) : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(id: string): string {
  return id.toLowerCase();
}

function findTask(board: TaskBoard, id: string): LeadTask | undefined {
  return board.tasks.find((task) => key(task.id) === key(id));
}

function requireTask(board: TaskBoard, id: string): { index: number; task: LeadTask } {
  const index = board.tasks.findIndex((task) => key(task.id) === key(id));
  const task = board.tasks[index];
  if (index < 0 || !task) {
    throw new BoardError(`unknown task ${id}`);
  }
  return { index, task };
}

function replaceAt(board: TaskBoard, index: number, task: LeadTask): TaskBoard {
  return { tasks: board.tasks.map((current, position) => (position === index ? task : current)) };
}

function transitionError(task: LeadTask, target: string): BoardError {
  return new BoardError(`task ${task.id} cannot go from ${task.status} to ${target}`);
}

function freshTask(plan: LeadTaskPlan): LeadTask {
  return {
    id: plan.id,
    title: plan.title,
    description: plan.description,
    acceptance: plan.acceptance,
    ownedPaths: plan.ownedPaths,
    dependsOn: plan.dependsOn,
    ...(plan.role !== undefined ? { role: plan.role } : {}),
    status: "backlog",
    reassignCount: 0,
    escalationCount: 0,
  };
}

/** Removes repeats, keeping the first spelling of each id. */
function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(key(id))) {
      seen.add(key(id));
      out.push(id);
    }
  }
  return out;
}
