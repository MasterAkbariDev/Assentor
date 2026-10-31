import { describe, expect, it } from "vitest";
import {
  applyBoardOp,
  boardColumns,
  emptyTaskBoard,
  readyTasks,
  type BoardOp,
  type LeadTask,
  type LeadTaskPlan,
  type TaskBoard,
} from "../../packages/engine/src/index.js";

/** Recursively freezes an object graph, so any mutation throws in strict (ESM) code. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function planned(id: string, extra: Partial<LeadTaskPlan> = {}): LeadTaskPlan {
  return {
    id,
    title: `title ${id}`,
    description: "",
    acceptance: [],
    ownedPaths: [],
    dependsOn: [],
    ...extra,
  };
}

function planOp(...tasks: LeadTaskPlan[]): BoardOp {
  return { op: "plan", tasks };
}

/** Applies ops in order, failing the test on the first refusal. */
function run(board: TaskBoard, ...ops: BoardOp[]): TaskBoard {
  let current = board;
  for (const op of ops) {
    const result = applyBoardOp(current, op);
    if (result.error) {
      throw new Error(`unexpected error: ${result.error}`);
    }
    current = result.board;
  }
  return current;
}

function taskOf(board: TaskBoard, id: string): LeadTask {
  const task = board.tasks.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (!task) {
    throw new Error(`no task ${id}`);
  }
  return task;
}

/** A board with T1 assigned and in progress. */
function inProgressBoard(): TaskBoard {
  return run(
    emptyTaskBoard(),
    planOp(planned("T1")),
    { op: "assign", taskId: "T1", seatId: "seat-a" },
    { op: "status", taskId: "T1", status: "in_progress" },
  );
}

/** A board with T1 accepted. */
function acceptedBoard(): TaskBoard {
  return run(inProgressBoard(), { op: "status", taskId: "T1", status: "in_review" }, { op: "accept", taskId: "T1" });
}

describe("applyBoardOp: plan", () => {
  it("adds new tasks as backlog with zeroed counters", () => {
    const board = run(emptyTaskBoard(), planOp(planned("T1"), planned("T2", { dependsOn: ["T1"] })));

    expect(board.tasks.map((task) => [task.id, task.status, task.reassignCount, task.escalationCount])).toEqual([
      ["T1", "backlog", 0, 0],
      ["T2", "backlog", 0, 0],
    ]);
    expect(taskOf(board, "T2").dependsOn).toEqual(["T1"]);
  });

  it("replaces a backlog, unassigned task with the same id in place and keeps the others", () => {
    const first = run(emptyTaskBoard(), planOp(planned("T1", { title: "old" }), planned("T2")));
    const board = run(first, planOp(planned("T1", { title: "new" })));

    expect(board.tasks.map((task) => task.id)).toEqual(["T1", "T2"]);
    expect(taskOf(board, "T1").title).toBe("new");
  });

  it("refuses to replace an assigned task", () => {
    const result = applyBoardOp(inProgressBoard(), planOp(planned("T1")));

    expect(result.error).toBe("task T1 is in_progress; a plan can only replace backlog tasks");
  });

  it("refuses a duplicate id inside one plan, ignoring case", () => {
    const result = applyBoardOp(emptyTaskBoard(), planOp(planned("T1"), planned("t1")));

    expect(result.error).toBe("duplicate task id in plan: t1");
  });

  it("refuses a dependency on an unknown task", () => {
    const result = applyBoardOp(emptyTaskBoard(), planOp(planned("T1", { dependsOn: ["T9"] })));

    expect(result.error).toBe("task T1 depends on unknown task T9");
  });

  it("refuses an invalid task id with the schema message", () => {
    const result = applyBoardOp(emptyTaskBoard(), planOp(planned("bad..id")));

    expect(result.error).toMatch(/^invalid board op: /);
  });
});

describe("applyBoardOp: assign and reassign", () => {
  it("assign moves backlog to assigned with the seat", () => {
    const board = run(emptyTaskBoard(), planOp(planned("T1")), { op: "assign", taskId: "T1", seatId: "seat-a" });

    expect(taskOf(board, "T1")).toMatchObject({ status: "assigned", assignee: "seat-a" });
  });

  it("assign from rejected counts a reassignment and clears the rejection reason", () => {
    const rejected = run(inProgressBoard(), { op: "reject", taskId: "T1", reason: "nope" });
    const board = run(rejected, { op: "assign", taskId: "T1", seatId: "seat-b" });

    expect(taskOf(board, "T1")).toMatchObject({ status: "assigned", assignee: "seat-b", reassignCount: 1 });
    expect(taskOf(board, "T1").rejectionReason).toBeUndefined();
  });

  it("assign from backlog does not count a reassignment", () => {
    const board = run(emptyTaskBoard(), planOp(planned("T1")), { op: "assign", taskId: "T1", seatId: "a" });

    expect(taskOf(board, "T1").reassignCount).toBe(0);
  });

  it("reassign clears the rejection reason", () => {
    const rejected = run(inProgressBoard(), { op: "reject", taskId: "T1", reason: "nope" });
    const board = run(rejected, { op: "reassign", taskId: "T1", seatId: "b" });

    expect(taskOf(board, "T1")).toMatchObject({ status: "assigned", reassignCount: 1 });
    expect(taskOf(board, "T1").rejectionReason).toBeUndefined();
  });

  it("assign also works from rejected", () => {
    const rejected = run(inProgressBoard(), { op: "reject", taskId: "T1", reason: "nope" });
    const board = run(rejected, { op: "assign", taskId: "T1", seatId: "seat-b" });

    expect(taskOf(board, "T1")).toMatchObject({ status: "assigned", assignee: "seat-b" });
  });

  it("assign refuses any other status", () => {
    const result = applyBoardOp(inProgressBoard(), { op: "assign", taskId: "T1", seatId: "seat-b" });

    expect(result.error).toBe("task T1 cannot go from in_progress to assigned");
  });

  it("reassign from assigned, in_progress or rejected counts a reassignment", () => {
    const assigned = run(emptyTaskBoard(), planOp(planned("T1")), { op: "assign", taskId: "T1", seatId: "a" });
    const fromAssigned = run(assigned, { op: "reassign", taskId: "T1", seatId: "b" });
    expect(taskOf(fromAssigned, "T1")).toMatchObject({ status: "assigned", assignee: "b", reassignCount: 1 });

    const fromProgress = run(inProgressBoard(), { op: "reassign", taskId: "T1", seatId: "b" });
    expect(taskOf(fromProgress, "T1")).toMatchObject({ status: "assigned", assignee: "b", reassignCount: 1 });

    const rejected = run(inProgressBoard(), { op: "reject", taskId: "T1", reason: "nope" });
    const fromRejected = run(rejected, { op: "reassign", taskId: "T1", seatId: "c" });
    expect(taskOf(fromRejected, "T1")).toMatchObject({ status: "assigned", assignee: "c", reassignCount: 1 });
  });

  it("reassign refuses an accepted task, naming both statuses", () => {
    const result = applyBoardOp(acceptedBoard(), { op: "reassign", taskId: "T1", seatId: "b" });

    expect(result.error).toBe("task T1 cannot go from accepted to assigned");
  });
});

describe("applyBoardOp: status, accept and reject", () => {
  it("status moves assigned to in_progress to in_review", () => {
    const board = run(
      run(emptyTaskBoard(), planOp(planned("T1")), { op: "assign", taskId: "T1", seatId: "a" }),
      { op: "status", taskId: "T1", status: "in_progress" },
      { op: "status", taskId: "T1", status: "in_review" },
    );

    expect(taskOf(board, "T1").status).toBe("in_review");
  });

  it("status refuses a task that is not assigned or in progress", () => {
    const board = run(emptyTaskBoard(), planOp(planned("T1")));
    const result = applyBoardOp(board, { op: "status", taskId: "T1", status: "in_progress" });

    expect(result.error).toBe("task T1 cannot go from backlog to in_progress");
  });

  it("status with escalated true adds one to escalationCount, without it leaves the count alone", () => {
    const escalated = run(inProgressBoard(), { op: "status", taskId: "T1", status: "in_progress", escalated: true });
    expect(taskOf(escalated, "T1").escalationCount).toBe(1);

    const plain = run(inProgressBoard(), { op: "status", taskId: "T1", status: "in_progress" });
    expect(taskOf(plain, "T1").escalationCount).toBe(0);
  });

  it("accept only from in_review", () => {
    const reviewed = run(inProgressBoard(), { op: "status", taskId: "T1", status: "in_review" }, { op: "accept", taskId: "T1" });
    expect(taskOf(reviewed, "T1").status).toBe("accepted");

    const result = applyBoardOp(inProgressBoard(), { op: "accept", taskId: "T1" });
    expect(result.error).toBe("task T1 cannot go from in_progress to accepted");
  });

  it("reject from in_review or in_progress sets the reason", () => {
    const fromProgress = run(inProgressBoard(), { op: "reject", taskId: "T1", reason: "tests fail" });
    expect(taskOf(fromProgress, "T1")).toMatchObject({ status: "rejected", rejectionReason: "tests fail" });

    const fromReview = run(inProgressBoard(), { op: "status", taskId: "T1", status: "in_review" }, { op: "reject", taskId: "T1", reason: "scope" });
    expect(taskOf(fromReview, "T1")).toMatchObject({ status: "rejected", rejectionReason: "scope" });
  });

  it("reject refuses a backlog task", () => {
    const board = run(emptyTaskBoard(), planOp(planned("T1")));
    const result = applyBoardOp(board, { op: "reject", taskId: "T1", reason: "no" });

    expect(result.error).toBe("task T1 cannot go from backlog to rejected");
  });
});

describe("applyBoardOp: split", () => {
  it("parent becomes split, children follow with parentId and inherit the parent's dependencies", () => {
    const base = run(emptyTaskBoard(), planOp(planned("T0"), planned("T1", { dependsOn: ["T0"] })));
    const board = run(base, {
      op: "split",
      taskId: "T1",
      tasks: [planned("T1.1", { dependsOn: ["T0"] }), planned("T1.2")],
    });

    expect(board.tasks.map((task) => [task.id, task.status])).toEqual([
      ["T0", "backlog"],
      ["T1", "split"],
      ["T1.1", "backlog"],
      ["T1.2", "backlog"],
    ]);
    expect(taskOf(board, "T1.1")).toMatchObject({ parentId: "T1", dependsOn: ["T0"] });
    expect(taskOf(board, "T1.2")).toMatchObject({ parentId: "T1", dependsOn: ["T0"] });
  });

  it("a task that depended on the split parent now depends on every child", () => {
    const base = run(
      emptyTaskBoard(),
      planOp(planned("T1"), planned("T2", { dependsOn: ["T1"] })),
    );
    const board = run(base, { op: "split", taskId: "T1", tasks: [planned("T1a"), planned("T1b")] });

    expect(taskOf(board, "T2").dependsOn).toEqual(["T1a", "T1b"]);
  });

  it("refuses a child that depends on its own parent, ignoring case", () => {
    const base = run(emptyTaskBoard(), planOp(planned("T1")));

    const direct = applyBoardOp(base, { op: "split", taskId: "T1", tasks: [planned("T1.1", { dependsOn: ["T1"] }), planned("T1.2")] });
    expect(direct.error).toBe("child T1.1 cannot depend on its parent T1");

    const lowered = applyBoardOp(base, { op: "split", taskId: "T1", tasks: [planned("T1.1"), planned("T1.2", { dependsOn: ["t1"] })] });
    expect(lowered.error).toBe("child T1.2 cannot depend on its parent T1");
  });

  it("refuses a closed task (accepted, rejected or split)", () => {
    const result = applyBoardOp(acceptedBoard(), { op: "split", taskId: "T1", tasks: [planned("A"), planned("B")] });

    expect(result.error).toBe("task T1 cannot be split from accepted");
  });

  it("refuses a child id that is already used, ignoring case", () => {
    const base = run(emptyTaskBoard(), planOp(planned("T1"), planned("T2")));

    const clash = applyBoardOp(base, { op: "split", taskId: "T1", tasks: [planned("t2"), planned("T1c")] });
    expect(clash.error).toBe("task id t2 is already used");

    const duplicate = applyBoardOp(base, { op: "split", taskId: "T1", tasks: [planned("T1a"), planned("t1A")] });
    expect(duplicate.error).toBe("task id t1A is already used");
  });
});

describe("applyBoardOp: unknown tasks and case", () => {
  it("names an unknown task", () => {
    const result = applyBoardOp(emptyTaskBoard(), { op: "accept", taskId: "T9" });

    expect(result.error).toBe("unknown task T9");
  });

  it("matches task ids case-insensitively", () => {
    const board = run(emptyTaskBoard(), planOp(planned("T1")), { op: "assign", taskId: "t1", seatId: "a" });
    expect(taskOf(board, "T1").status).toBe("assigned");

    const dependent = run(board, planOp(planned("T2", { dependsOn: ["t1"] })));
    expect(taskOf(dependent, "T2").dependsOn).toEqual(["t1"]);
  });
});

describe("dependency cycles and unknown dependencies", () => {
  it("reports a two-task cycle as a path", () => {
    const result = applyBoardOp(
      emptyTaskBoard(),
      planOp(planned("A", { dependsOn: ["B"] }), planned("B", { dependsOn: ["A"] })),
    );

    expect(result.error).toBe("dependency cycle: A → B → A");
  });

  it("reports a self dependency", () => {
    const result = applyBoardOp(emptyTaskBoard(), planOp(planned("A", { dependsOn: ["A"] })));

    expect(result.error).toBe("dependency cycle: A → A");
  });
});

describe("overlap rules", () => {
  it("parallel tasks owning the same path are refused with the first overlap", () => {
    const result = applyBoardOp(
      emptyTaskBoard(),
      planOp(planned("A", { ownedPaths: ["src/auth"] }), planned("B", { ownedPaths: ["src/auth/x.ts"] })),
    );

    expect(result.error).toBe("tasks A and B both own src/auth");
  });

  it("a path inside another task's path overlaps, but a sibling name like src/authz does not", () => {
    const sibling = applyBoardOp(
      emptyTaskBoard(),
      planOp(planned("A", { ownedPaths: ["src/auth"] }), planned("B", { ownedPaths: ["src/authz"] })),
    );
    expect(sibling.error).toBeUndefined();

    const nested = applyBoardOp(
      emptyTaskBoard(),
      planOp(planned("A", { ownedPaths: ["src/auth/x.ts"] }), planned("B", { ownedPaths: ["src/auth"] })),
    );
    expect(nested.error).toBe("tasks A and B both own src/auth");
  });

  it("compares paths case-insensitively", () => {
    const result = applyBoardOp(
      emptyTaskBoard(),
      planOp(planned("A", { ownedPaths: ["src/auth"] }), planned("B", { ownedPaths: ["SRC/Auth"] })),
    );

    expect(result.error).toBe("tasks A and B both own src/auth");
  });

  it("tasks that depend on each other are not parallel, even through a chain", () => {
    const board = run(
      emptyTaskBoard(),
      planOp(
        planned("A", { ownedPaths: ["src/auth"] }),
        planned("C", { dependsOn: ["A"] }),
        planned("B", { dependsOn: ["C"], ownedPaths: ["src/auth"] }),
      ),
    );

    expect(board.tasks.map((task) => task.id)).toEqual(["A", "C", "B"]);
  });

  it("accepted, rejected and split tasks no longer block a parallel overlap", () => {
    const accepted = run(acceptedBoard(), planOp(planned("T1b", { ownedPaths: ["src/auth"] })));
    expect(taskOf(accepted, "T1b").status).toBe("backlog");

    const base = run(emptyTaskBoard(), planOp(planned("R", { ownedPaths: ["src/auth"] })));
    const rejected = run(
      run(base, { op: "assign", taskId: "R", seatId: "a" }, { op: "status", taskId: "R", status: "in_progress" }),
      { op: "reject", taskId: "R", reason: "no" },
    );
    expect(run(rejected, planOp(planned("S", { ownedPaths: ["src/auth"] }))).tasks).toHaveLength(2);
  });

  it("a split parent's owned paths do not block its children", () => {
    const base = run(emptyTaskBoard(), planOp(planned("P", { ownedPaths: ["src/auth"] })));
    const board = run(base, {
      op: "split",
      taskId: "P",
      tasks: [planned("P1", { ownedPaths: ["src/auth/one.ts"] }), planned("P2", { ownedPaths: ["src/auth/two.ts"] })],
    });

    expect(board.tasks.map((task) => task.status)).toEqual(["split", "backlog", "backlog"]);
  });
});

describe("readyTasks and boardColumns", () => {
  it("readyTasks: backlog, unassigned, every dependency accepted", () => {
    const board = run(
      emptyTaskBoard(),
      planOp(planned("A"), planned("B", { dependsOn: ["A"] }), planned("C")),
    );
    expect(readyTasks(board).map((task) => task.id)).toEqual(["A", "C"]);

    const accepted = run(
      board,
      { op: "assign", taskId: "A", seatId: "s" },
      { op: "status", taskId: "A", status: "in_progress" },
      { op: "status", taskId: "A", status: "in_review" },
      { op: "accept", taskId: "A" },
    );
    expect(readyTasks(accepted).map((task) => task.id)).toEqual(["B", "C"]);
  });

  it("boardColumns groups every task by status, split included", () => {
    const board = run(
      emptyTaskBoard(),
      planOp(planned("A"), planned("B"), planned("C")),
      { op: "assign", taskId: "A", seatId: "s" },
      { op: "status", taskId: "A", status: "in_progress" },
    );
    const columns = boardColumns(board);

    expect(columns.backlog.map((task) => task.id)).toEqual(["B", "C"]);
    expect(columns.inProgress.map((task) => task.id)).toEqual(["A"]);
    expect(columns.assigned).toEqual([]);
    expect(columns.inReview).toEqual([]);
    expect(columns.accepted).toEqual([]);
    expect(columns.rejected).toEqual([]);
    expect(columns.split).toEqual([]);
  });
});

describe("immutability", () => {
  it("never mutates the input board or op, and refused ops return the same board object", () => {
    const board = deepFreeze(run(emptyTaskBoard(), planOp(planned("T1"), planned("T2", { dependsOn: ["T1"] }))));
    const before = JSON.stringify(board);
    const ops: BoardOp[] = deepFreeze([
      { op: "assign", taskId: "T1", seatId: "a" },
      { op: "status", taskId: "T1", status: "in_progress" },
      { op: "accept", taskId: "T1" },
      { op: "reject", taskId: "T1", reason: "x" },
      { op: "reassign", taskId: "T1", seatId: "b" },
      { op: "split", taskId: "T1", tasks: [planned("T1a"), planned("T1b")] },
      planOp(planned("T3", { ownedPaths: ["src/x"] })),
    ]) as BoardOp[];

    for (const op of ops) {
      const result = applyBoardOp(board, op);
      expect(() => JSON.stringify(board)).not.toThrow();
      expect(JSON.stringify(board)).toBe(before);
      if (result.error) {
        expect(result.board).toBe(board);
      } else {
        expect(result.board).not.toBe(board);
      }
    }
  });

  it("a successful op over a frozen board still returns a usable board", () => {
    const board = deepFreeze(inProgressBoard());
    const result = applyBoardOp(board, { op: "status", taskId: "T1", status: "in_review" });

    expect(result.error).toBeUndefined();
    expect(taskOf(result.board, "T1").status).toBe("in_review");
    expect(taskOf(board, "T1").status).toBe("in_progress");
  });
});
