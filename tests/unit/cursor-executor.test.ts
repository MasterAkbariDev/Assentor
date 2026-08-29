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
      mode: "autopilot",
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
    const prompt = spawnFn.mock.calls[0]?.[0]?.args.at(-1) ?? "";
    expect(prompt).toMatch(/AUTONOMOUS SUPERVISOR DIRECTIVE/);
    expect(prompt).toContain("Add tests");
  });

  it("injects nextPhaseDirective into the continuation prompt", async () => {
    const spawnFn = vi.fn(async (request: CursorSpawnRequest) => {
      expect(request.args.at(-1)).toContain("Proceed immediately to Phase 2");
      expect(request.args.at(-1)).toMatch(/DO NOT pause/i);
      return { code: 0, stdout: "continued", stderr: "" };
    });

    const executor = new CursorExecutor({ spawnFn, binary: "agent" });
    await executor.continue({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      sessionId: "sess-abc",
      mode: "autopilot",
      nextPhaseDirective:
        "Proceed immediately to Phase 2: API. Do NOT ask for confirmation.",
      messages: [
        createProtocolMessage({
          conversationId: "c",
          round: 2,
          from: "reviewer",
          to: "executor",
          type: MessageType.ChangeRequest,
          content: {
            summary: "Phase 1 done",
            requiredChanges: [],
            nextPhaseDirective: "Proceed immediately to Phase 2",
          },
        }),
      ],
    });
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it("supervised continue does not wrap the autonomous banner", async () => {
    const spawnFn = vi.fn(async (request: CursorSpawnRequest) => {
      const prompt = request.args.at(-1) ?? "";
      expect(prompt).not.toMatch(/AUTONOMOUS SUPERVISOR DIRECTIVE/);
      expect(prompt).toContain("Add tests");
      return { code: 0, stdout: "ok", stderr: "" };
    });

    const executor = new CursorExecutor({ spawnFn, binary: "agent" });
    await executor.continue({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      sessionId: "sess-abc",
      mode: "supervised",
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
    expect(spawnFn).toHaveBeenCalledOnce();
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

    const executor = new CursorExecutor({
      spawnFn: async (request) => {
        request.onSpawn?.({ kill });
        started = true;
        return new Promise(() => {
          // never exits — Windows cmd.exe / agent.cmd often never emit "close"
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
    expect(kill).toHaveBeenCalled();

    const result = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cancel hung waiting for spawn")), 1000),
      ),
    ]);
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

  it("kills Cursor after a result event if the process never exits", async () => {
    const kill = vi.fn(() => true);
    const resultLine = `${JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Wrote the hang fix",
      session_id: "stuck-1",
    })}\n`;

    const executor = new CursorExecutor({
      spawnFn: async (request) => {
        request.onSpawn?.({ kill });
        request.onOutput?.(resultLine, "stdout");
        return new Promise((resolve) => {
          // Resolves only if kill() cooperates — production Windows often does not.
          kill.mockImplementation(() => {
            resolve({
              code: null,
              stdout: resultLine,
              stderr: "",
              signal: "SIGTERM",
            });
            return true;
          });
        });
      },
      binary: "agent",
      resultGraceMs: 25,
    });

    const runPromise = executor.run({
      taskId: "t-hang",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    const result = await runPromise;
    expect(kill).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Wrote the hang fix");
    expect(result.sessionId).toBe("stuck-1");
  });

  it("finishes after a result even if kill does not exit the process", async () => {
    const resultLine = `${JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Process still holding stdout",
      session_id: "zombie-1",
    })}\n`;
    const executor = new CursorExecutor({
      spawnFn: async (request) => {
        request.onSpawn?.({ kill: () => true });
        request.onOutput?.(resultLine, "stdout");
        return new Promise(() => {
          // never resolves — the real Windows hang
        });
      },
      binary: "agent",
      resultGraceMs: 20,
    });

    const result = await Promise.race([
      executor.run({
        taskId: "t-zombie",
        projectPath: "/tmp/project",
        contract: createEmptyContract("goal"),
        prompt: "goal",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("still hung after result grace")),
          1000,
        ),
      ),
    ]);

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Process still holding stdout");
    expect(result.sessionId).toBe("zombie-1");
  });

  it("does not kill Cursor when the process exits right after the result", async () => {
    const kill = vi.fn();
    const resultLine = `${JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Exited cleanly",
    })}\n`;
    const executor = new CursorExecutor({
      spawnFn: async (request) => {
        request.onSpawn?.({ kill });
        request.onOutput?.(resultLine, "stdout");
        return { code: 0, stdout: resultLine, stderr: "" };
      },
      binary: "agent",
      resultGraceMs: 200,
    });

    const result = await executor.run({
      taskId: "t-clean",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });

    expect(result.status).toBe("completed");
    expect(kill).not.toHaveBeenCalled();
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
