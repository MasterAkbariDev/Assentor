import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEngineEvent, type EngineEvent } from "../../src/protocol/events.js";
import { RunReporter } from "../../src/cli/ui/reporter.js";
import {
  emptyLeadBoardView,
  LEAD_LOG_LIMIT,
  leadColumns,
  plainText,
  reduceLeadEvents,
  type LeadBoardView,
} from "../../src/ui-shared/lead.js";

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
let seq = 0;

function ev(type: string, data: Record<string, unknown>, seatId?: string): EngineEvent {
  seq += 1;
  return parseEngineEvent({
    seq,
    sessionId: "s1",
    ...(seatId ? { seatId } : {}),
    type,
    data,
    at: new Date(T0 + seq * 1000).toISOString(),
  });
}

function fold(events: EngineEvent[], start = emptyLeadBoardView()): LeadBoardView {
  return events.reduce(reduceLeadEvents, start);
}

function ids(view: LeadBoardView, column: keyof ReturnType<typeof leadColumns>) {
  return leadColumns(view)[column].map((task) => task.id);
}

describe("reduceLeadEvents over a scripted run", () => {
  const view = fold([
    ev("mode.selected", { mode: "lead", kind: "dynamic", autonomy: "supervised" }),
    ev("seat.spawned", { displayName: "Opus#1", provider: "claude-code", transport: "cli", model: "opus", role: "engineer", permissions: "edit" }, "seat-1"),
    ev("lead.turn", { turn: 1 }),
    ev("task.created", { taskId: "T1", title: "Login form", replaced: false }),
    ev("task.created", { taskId: "T2", title: "Login API", replaced: false }),
    ev("task.created", { taskId: "T3", title: "Docs", replaced: false }),
    ev("lead.action", { action: "plan_tasks", accepted: true, reason: "3 task(s) planned" }),
    ev("task.assigned", { taskId: "T1", seatId: "seat-1" }),
    ev("task.status", { taskId: "T1", status: "in_progress" }),
    ev("task.status", { taskId: "T1", status: "in_review" }),
    ev("task.accepted", { taskId: "T1" }),
    ev("task.assigned", { taskId: "T3", seatId: "ghost-seat" }),
    ev("task.status", { taskId: "T3", status: "in_progress" }),
    ev("task.created", { taskId: "T2.1", title: "API part one", replaced: false, parentId: "T2" }),
    ev("task.created", { taskId: "T2.2", title: "API part two", replaced: false, parentId: "T2" }),
    ev("task.rejected", { taskId: "T2.1", reason: "tests fail" }),
  ]);

  it("places each task in its column and leaves split parents out", () => {
    expect(ids(view, "backlog")).toEqual(["T2.1", "T2.2"]);
    expect(ids(view, "in_progress")).toEqual(["T3"]);
    expect(ids(view, "in_review")).toEqual([]);
    expect(ids(view, "done")).toEqual(["T1"]);
    expect(view.tasks.find((t) => t.id === "T2")!.state).toBe("split");
  });

  it("names the owner by seat display name, falling back to the seat id", () => {
    expect(view.tasks.find((t) => t.id === "T1")!.owner).toBe("Opus#1");
    expect(view.tasks.find((t) => t.id === "T3")!.owner).toBe("ghost-seat");
    expect(view.tasks.find((t) => t.id === "T2.1")!.owner).toBe("");
  });

  it("keeps the turn and the last lead actions", () => {
    expect(view.turn).toBe(1);
    expect(view.log).toEqual([{ action: "plan_tasks", accepted: true, reason: "3 task(s) planned" }]);
  });

  it("a rejected task sits in backlog in the rejected state", () => {
    expect(view.tasks.find((t) => t.id === "T2.1")!.state).toBe("rejected");
  });

  it("keeps only the last LEAD_LOG_LIMIT lead actions, oldest first", () => {
    const events = Array.from({ length: LEAD_LOG_LIMIT + 2 }, (_, i) =>
      ev("lead.action", { action: `act${i}`, accepted: i % 2 === 0, reason: `r${i}` }),
    );
    const log = fold(events).log;
    expect(log).toHaveLength(LEAD_LOG_LIMIT);
    expect(log[0]!.action).toBe("act2");
    expect(log.at(-1)!.action).toBe(`act${LEAD_LOG_LIMIT + 1}`);
  });
});

describe("reduceLeadEvents details", () => {
  it("task ids compare case-insensitively", () => {
    const view = fold([
      ev("task.created", { taskId: "T1", title: "one" }),
      ev("task.assigned", { taskId: "t1", seatId: "s" }),
    ]);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]!.state).toBe("assigned");
  });

  it("a replanned task keeps its state and takes the new title", () => {
    const view = fold([
      ev("task.created", { taskId: "T1", title: "old" }),
      ev("task.assigned", { taskId: "T1", seatId: "s" }),
      ev("task.created", { taskId: "T1", title: "new", replaced: true }),
    ]);
    expect(view.tasks).toEqual([{ id: "T1", title: "new", state: "assigned", owner: "s" }]);
  });

  it("an integrated task is in done; an unknown task status is ignored", () => {
    const view = fold([
      ev("task.created", { taskId: "T1", title: "one" }),
      ev("task.status", { taskId: "T1", status: "integrated", commit: "abc" }),
      ev("task.created", { taskId: "T2", title: "two" }),
      ev("task.status", { taskId: "T2", status: "something_new" }),
    ]);
    expect(ids(view, "done")).toEqual(["T1"]);
    expect(view.tasks[1]!.state).toBe("backlog");
  });

  it("events for unknown tasks and unrelated events leave the same object", () => {
    const before = fold([ev("task.created", { taskId: "T1", title: "one" })]);
    expect(reduceLeadEvents(before, ev("task.accepted", { taskId: "T9" }))).toBe(before);
    expect(reduceLeadEvents(before, ev("gate.started", {}))).toBe(before);
  });

  it("does not mutate the previous view", () => {
    const before = fold([ev("task.created", { taskId: "T1", title: "one" })]);
    const snapshot = JSON.stringify(before);
    fold([ev("task.accepted", { taskId: "T1" }), ev("lead.action", { action: "a", accepted: true })], before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("strips terminal control codes and newlines from model text", () => {
    const view = fold([
      ev("task.created", { taskId: "T1", title: "\x1b[31mRED\x1b[0m\nline two\x07" }),
      ev("lead.action", { action: "reject", accepted: false, reason: "\x1b]0;evil\x07bad\tthing" }),
    ]);
    expect(view.tasks[0]!.title).toBe("RED line two");
    expect(view.log[0]!.reason).toBe("bad thing");
  });

  it("plainText cuts long text to a limit", () => {
    const out = plainText("x".repeat(2000));
    expect(out.length).toBe(500);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("RunReporter team board", () => {
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  let savedAscii: string | undefined;
  let savedColumns: PropertyDescriptor | undefined;

  beforeEach(() => {
    logs = [];
    savedAscii = process.env.ASSENTOR_ASCII;
    process.env.ASSENTOR_ASCII = "1";
    savedColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
    spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    spy.mockRestore();
    if (savedAscii === undefined) delete process.env.ASSENTOR_ASCII;
    else process.env.ASSENTOR_ASCII = savedAscii;
    if (savedColumns) Object.defineProperty(process.stdout, "columns", savedColumns);
    else delete (process.stdout as { columns?: number }).columns;
  });

  const run = () => [
    ev("mode.selected", { mode: "lead", kind: "dynamic", autonomy: "supervised" }),
    ev("lead.turn", { turn: 2 }),
    ev("task.created", { taskId: "T1", title: "Build a very long login form title that will not fit" }),
    ev("task.created", { taskId: "T2", title: "API" }),
    ev("task.assigned", { taskId: "T2", seatId: "seat-1" }),
    ev("lead.action", { action: "reject", accepted: false, reason: "tests are missing from the diff" }),
  ];

  it("prints the board on each lead turn, within the terminal width, with plain marks in ascii", () => {
    const reporter = new RunReporter({ executorName: "executor", reviewerName: "reviewer" });
    for (const event of run()) reporter.onEngineEvent(event);
    const before = logs.length;
    reporter.onEngineEvent(ev("lead.turn", { turn: 3 }));

    const printed = logs.slice(before);
    expect(printed[0]).toContain("Team board");
    expect(printed[0]).toContain("turn 3");
    const text = printed.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("Backlog (1)");
    expect(text).toContain("In progress (1)");
    expect(text).toContain("T2 API");
    expect(text).toContain("seat-1");
    expect(text).toContain("Lead log");
    expect(text).toContain("X reject: tests are");
    for (const line of printed) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(40);
    }
  });

  it("prints nothing outside lead mode", () => {
    const reporter = new RunReporter({ executorName: "executor", reviewerName: "reviewer" });
    reporter.onEngineEvent(ev("lead.turn", { turn: 1 }));
    reporter.onEngineEvent(ev("task.created", { taskId: "T1", title: "x" }));
    expect(logs.some((line) => line.includes("Team board"))).toBe(false);
  });
});
