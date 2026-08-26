import { describe, expect, it, vi } from "vitest";
import {
  createEmptyContract,
  createProtocolMessage,
  CursorExecutor,
  EvidenceKind,
  MessageType,
  type CursorSpawnRequest,
} from "../../src/index.js";

describe("CursorExecutor", () => {
  it("invokes cursor agent CLI in print/force mode", async () => {
    const spawnFn = vi.fn(async (request: CursorSpawnRequest) => {
      expect(request.command).toContain("cursor");
      expect(request.args[0]).toBe("agent");
      expect(request.args).toContain("-p");
      expect(request.args).toContain("--print");
      expect(request.args).toContain("--force");
      expect(request.args).toContain("--trust");
      expect(request.args).toContain("--workspace");
      expect(request.args).toContain("/tmp/project");
      expect(request.args).toContain("--output-format");
      expect(request.args).toContain("stream-json");
      expect(request.args.at(-1)).toContain("Implement average");
      return {
        code: 0,
        stdout: "Implemented average() successfully",
        stderr: "",
      };
    });

    const executor = new CursorExecutor({
      spawnFn,
      timeoutMs: 1000,
      binary: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    });
    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("Implement average()"),
      prompt: "Implement average()",
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Implemented average");
    expect(executor.callCount).toBe(1);
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it("passes resume session id on continue", async () => {
    const spawnFn = vi.fn(async (request: CursorSpawnRequest) => {
      expect(request.args).toContain("--resume");
      expect(request.args).toContain("sess-abc");
      return { code: 0, stdout: '{"result":"fixed","sessionId":"sess-abc"}', stderr: "" };
    });

    const executor = new CursorExecutor({
      spawnFn,
      binary: "agent",
    });
    const result = await executor.continue({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      sessionId: "sess-abc",
      messages: [
        createProtocolMessage({
          conversationId: "c",
          round: 2,
          from: "reviewer",
          to: "executor",
          type: MessageType.ChangeRequest,
          content: {
            summary: "Add tests",
            requiredChanges: ["Add tests"],
          },
        }),
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("sess-abc");
    expect(result.summary).toContain("fixed");
  });

  it("maps non-zero exit to failed", async () => {
    const executor = new CursorExecutor({
      spawnFn: async () => ({
        code: 2,
        stdout: "",
        stderr: "auth required",
      }),
    });

    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("auth required");
  });

  it("maps timed out spawns to timeout even if output mentions auth", async () => {
    const executor = new CursorExecutor({
      spawnFn: async () => ({
        code: null,
        stdout: "partial",
        stderr: "Authentication required",
        timedOut: true,
      }),
    });

    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    expect(result.status).toBe("timeout");
    expect(result.error).toMatch(/timed out|stopped it|Resume/i);
  });

  it("honors cancel before spawn returns", async () => {
    const executor = new CursorExecutor({
      spawnFn: async () => {
        await executor.cancel("t1");
        return { code: 0, stdout: "late", stderr: "" };
      },
    });

    await executor.cancel("t1");
    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    expect(result.status).toBe("cancelled");
  });

  it("SIGTERMs the live child on cancel", async () => {
    const kill = vi.fn();
    let started = false;
    let finish!: (result: {
      code: number | null;
      stdout: string;
      stderr: string;
    }) => void;

    const executor = new CursorExecutor({
      spawnFn: async (request) => {
        request.onSpawn?.({ kill });
        started = true;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      binary: "agent",
    });

    const runPromise = executor.run({
      taskId: "t-cancel",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    for (let i = 0; i < 50 && !started; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(started).toBe(true);

    await executor.cancel("t-cancel");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    finish({ code: 1, stdout: "", stderr: "killed" });

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
  });

  it("acks evidence requests with a protocol response", async () => {
    const executor = new CursorExecutor({
      spawnFn: async () => ({
        code: 0,
        stdout: "looked at the file",
        stderr: "",
      }),
    });

    const result = await executor.continue({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      sessionId: "s1",
      messages: [
        createProtocolMessage({
          conversationId: "c",
          round: 1,
          from: "reviewer",
          to: "executor",
          type: MessageType.EvidenceRequest,
          content: {
            requests: [{ kind: EvidenceKind.File, path: "src/a.ts" }],
          },
        }),
      ],
    });

    expect(result.messages?.[0]?.type).toBe(MessageType.EvidenceResponse);
  });

  it("emits live status from stream-json stdout", async () => {
    const statuses: string[] = [];
    const spawnFn = vi.fn(async (request: CursorSpawnRequest) => {
      request.onOutput?.(
        `${JSON.stringify({
          type: "tool_call",
          subtype: "started",
          tool_call: { readToolCall: { args: { path: "app.js" } } },
          session_id: "live-1",
        })}\n`,
        "stdout",
      );
      request.onOutput?.(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Checked app.js",
          session_id: "live-1",
        })}\n`,
        "stdout",
      );
      return {
        code: 0,
        stdout: "",
        stderr: "",
      };
    });

    const executor = new CursorExecutor({
      spawnFn,
      binary: "agent",
      onStatus: (status) => {
        statuses.push(`${status.activity}:${status.detail}`);
      },
    });

    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Checked app.js");
    expect(result.sessionId).toBe("live-1");
    expect(statuses.some((s) => s.startsWith("reading:"))).toBe(true);
  });

  it("sets CURSOR_API_KEY when provided", async () => {
    const spawnFn = vi.fn(async (request: CursorSpawnRequest) => {
      expect(request.env.CURSOR_API_KEY).toBe("test-key");
      return { code: 0, stdout: "ok", stderr: "" };
    });

    const executor = new CursorExecutor({
      spawnFn,
      apiKey: "test-key",
      outputFormat: "text",
    });

    await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });
  });
});
