import { describe, expect, it } from "vitest";
import {
  createEmptyContract,
  createProtocolMessage,
  MessageType,
  MockReviewer,
  ReviewStatus,
} from "../../src/index.js";

describe("MockReviewer", () => {
  it("defaults to PASS when steps are exhausted", async () => {
    const reviewer = new MockReviewer({ steps: [] });
    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 1,
      artifacts: [],
    });

    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect(reviewer.callCount).toBe(1);
  });

  it("scripts NEEDS_WORK then PASS", async () => {
    const reviewer = new MockReviewer({
      steps: [
        {
          type: "needs_work",
          summary: "Add tests",
          requiredChanges: ["Add tests"],
          issueId: "T-1",
        },
        { type: "pass", summary: "Good" },
      ],
    });

    const first = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 1,
      artifacts: [],
    });
    const second = await reviewer.continue({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 2,
      artifacts: [],
      messages: [],
    });

    expect(first.result?.status).toBe(ReviewStatus.NeedsWork);
    expect(first.result?.requiredChanges).toEqual(["Add tests"]);
    expect(second.result?.status).toBe(ReviewStatus.Pass);
  });

  it("can request evidence", async () => {
    const reviewer = new MockReviewer({
      steps: [{ type: "evidence", path: "src/avg.ts" }],
    });

    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 1,
      artifacts: [],
    });

    expect(result.result?.status).toBe(ReviewStatus.NeedsWork);
    expect(result.result?.evidenceRequests?.[0]).toMatchObject({
      kind: "file",
      path: "src/avg.ts",
    });
  });

  it("auto-passes after evidence when configured", async () => {
    const reviewer = new MockReviewer({
      steps: [],
      passAfterEvidence: true,
    });

    const evidence = createProtocolMessage({
      conversationId: "c",
      round: 1,
      from: "executor",
      to: "reviewer",
      type: MessageType.EvidenceResponse,
      content: {
        artifacts: [{ kind: "file", path: "src/a.ts", content: "ok" }],
      },
    });

    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 1,
      artifacts: [],
      messages: [evidence],
    });

    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect(result.result?.summary).toContain("Evidence received");
  });
});
