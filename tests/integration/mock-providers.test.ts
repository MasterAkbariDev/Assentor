import { describe, expect, it } from "vitest";
import {
  createBudgets,
  createEmptyContract,
  MockExecutor,
  MockReviewer,
  Supervisor,
  TaskState,
} from "../../src/index.js";

describe("supervisor with MockExecutor + MockReviewer", () => {
  it("passes on first round with default mocks", async () => {
    const result = await new Supervisor({
      projectPath: "/tmp/project",
      contract: createEmptyContract("Implement average()"),
      executor: new MockExecutor(),
      reviewer: new MockReviewer({ steps: [{ type: "pass" }] }),
      budgets: createBudgets({ maxRounds: 3, maxMessages: 20 }),
    }).run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBe(1);
  });

  it("corrects then passes using scripted mocks", async () => {
    const executor = new MockExecutor({
      steps: [
        { type: "complete", summary: "initial" },
        { type: "complete", summary: "fixed" },
      ],
      autoRespondToEvidence: false,
    });

    const reviewer = new MockReviewer({
      steps: [
        {
          type: "needs_work",
          summary: "Add tests",
          requiredChanges: ["Add tests"],
          issueId: "T-1",
        },
        { type: "pass" },
      ],
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
    expect(executor.callCount).toBe(2);
    expect(reviewer.callCount).toBe(2);
  });

  it("handles evidence exchange via mocks in one round", async () => {
    const executor = new MockExecutor({ autoRespondToEvidence: true });
    const reviewer = new MockReviewer({
      steps: [{ type: "evidence", path: "src/avg.ts" }],
      passAfterEvidence: true,
    });

    const result = await new Supervisor({
      projectPath: "/tmp/project",
      contract: createEmptyContract("Implement average()"),
      executor,
      reviewer,
      budgets: createBudgets({ maxRounds: 3, maxMessages: 40 }),
    }).run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBe(1);
    // Assentor fulfills file evidence locally; MockExecutor explanations
    // do not increment callCount.
    expect(executor.callCount).toBe(1);
    expect(reviewer.callCount).toBe(2);
  });
});
