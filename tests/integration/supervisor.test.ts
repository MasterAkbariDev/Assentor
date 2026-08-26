import { describe, expect, it } from "vitest";
import {
  createBudgets,
  createEmptyContract,
  createProtocolMessage,
  EvidenceKind,
  MessageType,
  ReviewStatus,
  Severity,
  Supervisor,
  TaskState,
  type Executor,
  type ExecutorContinuation,
  type ExecutorResult,
  type ExecutorTask,
  type Reviewer,
  type ReviewInput,
  type ReviewerTurnResult,
} from "../../src/index.js";

function mockExecutor(
  handler: (input: {
    mode: "run" | "continue";
    task?: ExecutorTask;
    cont?: ExecutorContinuation;
    call: number;
  }) => Promise<ExecutorResult> | ExecutorResult,
): Executor & { calls: number } {
  const state = { calls: 0 };
  return {
    name: "mock-executor",
    get calls() {
      return state.calls;
    },
    capabilities: () => ({
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: true,
      supportsScreenshots: false,
    }),
    async run(task) {
      state.calls += 1;
      return handler({ mode: "run", task, call: state.calls });
    },
    async continue(cont) {
      const isExplanation = (cont.messages ?? []).some((message) => {
        if (message.type !== MessageType.Question) return false;
        const content = message.content as {
          purpose?: string;
          context?: string;
          question?: string;
        };
        return (
          content.purpose === "evidence_pack_explanation" ||
          content.context === "purpose:evidence_pack_explanation" ||
          (typeof content.question === "string" &&
            content.question.includes("architecture summary"))
        );
      });
      if (isExplanation) {
        return {
          status: "completed",
          summary: "explanation",
          sessionId: cont.sessionId ?? "sess-1",
          rawOutput: JSON.stringify({
            architectureSummary: "test architecture",
            whatChanged: "test changes",
            why: "tests",
            assumptions: [],
            unchanged: "n/a",
            risks: [],
            limitations: [],
          }),
        };
      }
      state.calls += 1;
      return handler({ mode: "continue", cont, call: state.calls });
    },
    async cancel() {},
  };
}

function mockReviewer(
  handler: (input: ReviewInput, call: number) => ReviewerTurnResult,
): Reviewer & { calls: number } {
  const state = { calls: 0 };
  return {
    name: "mock-reviewer",
    get calls() {
      return state.calls;
    },
    async review(input) {
      state.calls += 1;
      return handler(input, state.calls);
    },
    async continue(input) {
      state.calls += 1;
      return handler(input, state.calls);
    },
  };
}

describe("supervisor", () => {
  it("completes when reviewer passes on first review", async () => {
    const executor = mockExecutor(async () => ({
      status: "completed",
      summary: "Implemented average()",
      sessionId: "sess-1",
    }));

    const reviewer = mockReviewer(() => ({
      result: {
        status: ReviewStatus.Pass,
        confidence: 0.95,
        summary: "Looks good",
        issues: [],
        requiredChanges: [],
        optionalChanges: [],
        evidenceRequests: [],
      },
    }));

    const supervisor = new Supervisor({
      projectPath: "/tmp/project",
      contract: createEmptyContract("Implement average()"),
      executor,
      reviewer,
      budgets: createBudgets({ maxRounds: 4, maxMessages: 20 }),
    });

    const result = await supervisor.run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBe(1);
    expect(executor.calls).toBe(1);
    expect(reviewer.calls).toBe(1);
    expect(result.events.some((event) => event.type === "task.completed")).toBe(
      true,
    );
  });

  it("runs a correction round on NEEDS_WORK then passes", async () => {
    const executor = mockExecutor(async ({ mode }) => ({
      status: "completed",
      summary: mode === "run" ? "first impl" : "fixed tests",
      sessionId: "sess-1",
    }));

    const reviewer = mockReviewer((_input, call) => {
      if (call === 1) {
        return {
          result: {
            status: ReviewStatus.NeedsWork,
            confidence: 0.9,
            summary: "Missing tests",
            issues: [
              {
                id: "TEST-1",
                severity: Severity.Major,
                description: "No tests",
                evidence: [],
              },
            ],
            requiredChanges: ["Add unit tests"],
            optionalChanges: [],
            evidenceRequests: [],
          },
        };
      }

      return {
        result: {
          status: ReviewStatus.Pass,
          confidence: 0.96,
          summary: "Tests added",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        },
      };
    });

    const result = await new Supervisor({
      projectPath: "/tmp/project",
      contract: createEmptyContract("Implement average()"),
      executor,
      reviewer,
      budgets: createBudgets({ maxRounds: 5, maxMessages: 40 }),
    }).run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBe(2);
    expect(executor.calls).toBe(2);
    expect(reviewer.calls).toBe(2);
    expect(
      result.history.some((message) => message.type === MessageType.ChangeRequest),
    ).toBe(true);
  });

  it("handles evidence request communication without consuming an extra round", async () => {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "assentor-evidence-"),
    );
    await fs.mkdir(path.join(projectPath, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "src", "avg.ts"),
      "export const avg = () => 0;\n",
      "utf8",
    );

    const executor = mockExecutor(async () => ({
      status: "completed",
      summary: "impl",
      sessionId: "s1",
    }));

    const reviewer = mockReviewer((input, call) => {
      if (call === 1) {
        return {
          result: {
            status: ReviewStatus.NeedsWork,
            confidence: 0.4,
            summary: "Need source file",
            issues: [],
            requiredChanges: [],
            optionalChanges: [],
            evidenceRequests: [
              { kind: EvidenceKind.File, path: "src/avg.ts" },
            ],
          },
        };
      }

      const hasFile = input.artifacts.some(
        (a) => a.path === "src/avg.ts" || a.content?.includes("avg"),
      );
      expect(hasFile || Boolean(input.evidencePack)).toBe(true);

      return {
        result: {
          status: ReviewStatus.Pass,
          confidence: 0.9,
          summary: "Verified",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        },
      };
    });

    const result = await new Supervisor({
      projectPath,
      contract: createEmptyContract("Implement average()"),
      executor,
      reviewer,
      budgets: createBudgets({ maxRounds: 3, maxMessages: 40 }),
    }).run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBe(1);
    expect(executor.calls).toBe(1);
    expect(reviewer.calls).toBe(2);
    expect(
      result.events.some((event) => event.type === "evidence.fulfilled"),
    ).toBe(true);
  });

  it("stops on budget exhaustion", async () => {
    const executor = mockExecutor(async () => ({
      status: "completed",
      summary: "impl",
      sessionId: "s",
    }));

    const reviewer = mockReviewer(() => ({
      result: {
        status: ReviewStatus.NeedsWork,
        confidence: 0.8,
        summary: "Still wrong",
        issues: [
          {
            id: "X",
            severity: Severity.Minor,
            description: "nits",
            evidence: [],
          },
        ],
        // Vary required changes so loop detector does not fire first.
        requiredChanges: [`Fix ${Math.random()}`],
        optionalChanges: [],
        evidenceRequests: [],
      },
    }));

    const result = await new Supervisor({
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      executor,
      reviewer,
      budgets: createBudgets({ maxRounds: 2, maxMessages: 50 }),
    }).run();

    expect(result.status).toBe(TaskState.BudgetExceeded);
    expect(result.round).toBe(2);
  });

  it("escalates when identical change requests repeat", async () => {
    const executor = mockExecutor(async () => ({
      status: "completed",
      summary: "impl",
      sessionId: "s",
    }));

    const reviewer = mockReviewer(() => ({
      result: {
        status: ReviewStatus.NeedsWork,
        confidence: 0.7,
        summary: "Missing tests",
        issues: [
          {
            id: "TEST-1",
            severity: Severity.Major,
            description: "No tests",
            evidence: [],
          },
        ],
        requiredChanges: ["Add unit tests"],
        optionalChanges: [],
        evidenceRequests: [],
      },
    }));

    const result = await new Supervisor({
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      executor,
      reviewer,
      budgets: createBudgets({ maxRounds: 10, maxMessages: 100 }),
    }).run();

    expect(result.status).toBe(TaskState.HumanRequired);
    expect(result.events.some((event) => event.type === "loop.detected")).toBe(
      true,
    );
    expect(result.round).toBe(3);
  });

  it("marks task failed when executor fails", async () => {
    const executor = mockExecutor(async () => ({
      status: "failed",
      summary: "boom",
      error: "boom",
    }));

    const reviewer = mockReviewer(() => {
      throw new Error("reviewer should not be called");
    });

    const result = await new Supervisor({
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      executor,
      reviewer,
    }).run();

    expect(result.status).toBe(TaskState.Failed);
    expect(reviewer.calls).toBe(0);
  });
});
