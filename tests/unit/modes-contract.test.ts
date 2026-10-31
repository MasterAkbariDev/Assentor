import { describe, expect, it } from "vitest";
import {
  AgentReportSchema,
  BoardOpSchema,
  CONTROLLER_ACTION_NAMES,
  CapabilityProfileSchema,
  ControllerActionSchema,
  ControllerTurnSchema,
  LeadTaskSchema,
  TaskBoardSchema,
  costRank,
  emptyTaskBoard,
} from "../../packages/engine/src/index.js";

describe("Lead task board contract", () => {
  it("fills runtime defaults on a planned task", () => {
    expect(LeadTaskSchema.parse({ id: "T1", title: "Add login" })).toEqual({
      id: "T1",
      title: "Add login",
      description: "",
      acceptance: [],
      ownedPaths: [],
      dependsOn: [],
      status: "backlog",
      reassignCount: 0,
      escalationCount: 0,
    });
    expect(emptyTaskBoard()).toEqual({ tasks: [] });
  });

  it("rejects bad task ids and duplicate ids on a board", () => {
    expect(LeadTaskSchema.safeParse({ id: "../x", title: "t" }).success).toBe(false);
    expect(LeadTaskSchema.safeParse({ id: "T 1", title: "t" }).success).toBe(false);
    expect(LeadTaskSchema.safeParse({ id: "T3.1", title: "t" }).success).toBe(true);
    const dup = TaskBoardSchema.safeParse({
      tasks: [
        { id: "T1", title: "a" },
        { id: "T1", title: "b" },
      ],
    });
    expect(dup.success).toBe(false);
  });

  it("validates board ops", () => {
    expect(BoardOpSchema.parse({ op: "assign", taskId: "T1", seatId: "opus-1" })).toMatchObject({ op: "assign" });
    expect(BoardOpSchema.safeParse({ op: "split", taskId: "T1", tasks: [{ id: "T1.1", title: "x" }] }).success).toBe(
      false,
    );
    expect(BoardOpSchema.safeParse({ op: "status", taskId: "T1", status: "accepted" }).success).toBe(false);
    expect(BoardOpSchema.safeParse({ op: "teleport", taskId: "T1" }).success).toBe(false);
  });
});

describe("agent report contract", () => {
  it("applies defaults and bounds confidence", () => {
    expect(AgentReportSchema.parse({ taskId: "T3", status: "done", summary: "Implemented callback" })).toEqual({
      taskId: "T3",
      status: "done",
      summary: "Implemented callback",
      filesChanged: [],
      testsRun: [],
      confidence: 0.5,
      blockers: [],
      questions: [],
    });
    expect(AgentReportSchema.safeParse({ taskId: "T3", status: "done", summary: "x", confidence: 2 }).success).toBe(
      false,
    );
    expect(AgentReportSchema.safeParse({ taskId: "T3", status: "finished", summary: "x" }).success).toBe(false);
  });
});

describe("roster contract", () => {
  it("accepts provider/model and provider/* keys only", () => {
    expect(CapabilityProfileSchema.parse({ key: "claude-code/opus" })).toEqual({
      key: "claude-code/opus",
      strengths: [],
      speed: "medium",
      cost: "medium",
    });
    expect(CapabilityProfileSchema.safeParse({ key: "codex/*" }).success).toBe(true);
    expect(CapabilityProfileSchema.safeParse({ key: "opus" }).success).toBe(false);
    expect(CapabilityProfileSchema.safeParse({ key: "codex/*", strengths: ["magic"] }).success).toBe(false);
    expect(["low", "medium", "high"].map((c) => costRank(c as "low"))).toEqual([0, 1, 2]);
  });
});

describe("controller action contract", () => {
  it("lists all 14 actions from modes.md §4.2", () => {
    expect([...CONTROLLER_ACTION_NAMES].sort()).toEqual(
      [
        "accept",
        "ask_user",
        "assign",
        "escalate",
        "finish",
        "integrate",
        "message",
        "plan_tasks",
        "reassign",
        "reject",
        "request_report",
        "retire",
        "review",
        "split",
      ].sort(),
    );
  });

  it("validates actions and turns", () => {
    expect(
      ControllerActionSchema.parse({
        action: "assign",
        taskId: "T2",
        seat: { role: "test-writer", provider: "claude-code", model: "haiku", permissions: "edit" },
      }),
    ).toMatchObject({ action: "assign" });
    expect(
      ControllerActionSchema.safeParse({
        action: "assign",
        taskId: "T2",
        seat: { role: "x", provider: "skynet", permissions: "edit" },
      }).success,
    ).toBe(false);
    expect(ControllerActionSchema.safeParse({ action: "rm_rf", path: "/" }).success).toBe(false);
    expect(ControllerTurnSchema.safeParse({ actions: [] }).success).toBe(false);
    expect(
      ControllerTurnSchema.safeParse({ actions: Array.from({ length: 21 }, () => ({ action: "finish", summary: "x" })) })
        .success,
    ).toBe(false);
  });
});

describe("contract hardening (O2 review)", () => {
  it("owned paths are repo-relative, '/'-separated and can't claim or escape the repo", async () => {
    const { OwnedPathSchema } = await import("../../packages/engine/src/index.js");
    for (const ok of ["src/auth", "src/auth/login.ts", "README.md", "a-b/c_d.e"]) {
      expect(OwnedPathSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [".", "./src", "../x", "/abs", "C:/x", "src\\auth", "src/auth/", "src//auth", "", "src/./x", "*", "src/*", "src/[ab]", "a?b"]) {
      expect({ bad, ok: OwnedPathSchema.safeParse(bad).success }).toEqual({ bad, ok: false });
    }
  });

  it("task ids are git-ref-safe and unique case-insensitively", () => {
    for (const bad of ["T3..1", "T3.", "x.lock", "X.LOCK"]) {
      expect({ bad, ok: LeadTaskSchema.safeParse({ id: bad, title: "t" }).success }).toEqual({ bad, ok: false });
    }
    expect(
      TaskBoardSchema.safeParse({
        tasks: [
          { id: "T3", title: "a" },
          { id: "t3", title: "b" },
        ],
      }).success,
    ).toBe(false);
  });

  it("hired seats need a kebab-case role and a safe model id", () => {
    const seat = (over: Record<string, unknown>) => ({
      action: "assign",
      taskId: "T1",
      seat: { role: "engineer", provider: "codex", permissions: "edit", ...over },
    });
    expect(ControllerActionSchema.safeParse(seat({})).success).toBe(true);
    expect(ControllerActionSchema.safeParse(seat({ model: "gpt-5.3-codex" })).success).toBe(true);
    expect(ControllerActionSchema.safeParse(seat({ model: "--dangerously-bypass" })).success).toBe(false);
    expect(ControllerActionSchema.safeParse(seat({ model: "opus; rm -rf /" })).success).toBe(false);
    expect(ControllerActionSchema.safeParse(seat({ role: "Engineer Prime" })).success).toBe(false);
    expect(ControllerActionSchema.safeParse({ action: "escalate", taskId: "T1", model: "-x" }).success).toBe(false);
  });
});
