import { describe, expect, it } from "vitest";
import {
  createEmptyContract,
  createProtocolMessage,
  EvidenceKind,
  MessageType,
  MockExecutor,
} from "../../src/index.js";

describe("MockExecutor", () => {
  it("completes by default and tracks calls", async () => {
    const executor = new MockExecutor();
    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    expect(result.status).toBe("completed");
    expect(result.sessionId).toBeTruthy();
    expect(executor.callCount).toBe(1);
    expect(executor.capabilities().canEditFiles).toBe(true);
  });

  it("follows scripted steps", async () => {
    const executor = new MockExecutor({
      steps: [
        { type: "complete", summary: "first" },
        { type: "fail", error: "boom" },
      ],
      autoRespondToEvidence: false,
    });

    const first = await executor.run({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });
    const second = await executor.continue({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      messages: [],
      sessionId: first.sessionId,
    });

    expect(first.summary).toBe("first");
    expect(second.status).toBe("failed");
    expect(second.error).toBe("boom");
  });

  it("auto-responds to evidence requests", async () => {
    const executor = new MockExecutor({ autoRespondToEvidence: true });
    const request = createProtocolMessage({
      conversationId: "c1",
      round: 1,
      from: "reviewer",
      to: "executor",
      type: MessageType.EvidenceRequest,
      content: {
        requests: [{ kind: EvidenceKind.File, path: "src/a.ts" }],
      },
    });

    const result = await executor.continue({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      messages: [request],
      sessionId: "s1",
    });

    expect(result.status).toBe("completed");
    expect(result.messages?.[0]?.type).toBe(MessageType.EvidenceResponse);
  });

  it("honors cancel", async () => {
    const executor = new MockExecutor();
    await executor.cancel("t1");
    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });
    expect(result.status).toBe("cancelled");
  });
});
