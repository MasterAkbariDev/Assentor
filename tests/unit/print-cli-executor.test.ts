import { describe, expect, it, vi } from "vitest";
import {
  buildPrintCliArgs,
  PRINT_CLI_RECIPES,
  PrintCliExecutor,
  createEmptyContract,
} from "../../src/index.js";

describe("print-mode CLI recipes", () => {
  it("builds Antigravity print args with stream-json and attached prompt", () => {
    const recipe = PRINT_CLI_RECIPES.antigravity;
    expect(recipe?.tool).toBe("agy");
    expect(buildPrintCliArgs(recipe!, "Fix the tests")).toEqual([
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "-p=Fix the tests",
    ]);
  });

  it("builds Claude Code print args", () => {
    const recipe = PRINT_CLI_RECIPES["claude-code"];
    expect(buildPrintCliArgs(recipe!, "Implement average", { sessionId: "abc" })).toEqual([
      "--dangerously-skip-permissions",
      "--resume",
      "abc",
      "-p",
      "--output-format",
      "stream-json",
      "Implement average",
    ]);
  });

  it("runs a print CLI executor via spawnFn", async () => {
    const recipe = PRINT_CLI_RECIPES.antigravity!;
    const executor = new PrintCliExecutor({
      recipe,
      binary: "/tmp/agy",
      spawnFn: async (request) => {
        expect(request.command).toBe("/tmp/agy");
        expect(request.args.at(-1)).toBe("-p=Add login");
        expect(request.args).toContain("stream-json");
        return { code: 0, stdout: "done", stderr: "" };
      },
    });
    const result = await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("Add login"),
      prompt: "Add login",
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("done");
  });

  it("emits live status from stream-json stdout", async () => {
    const statuses: string[] = [];
    const recipe = PRINT_CLI_RECIPES.antigravity!;
    const executor = new PrintCliExecutor({
      recipe,
      binary: "/tmp/agy",
      resultGraceMs: 0,
      spawnFn: async (request) => {
        request.onOutput?.(
          `${JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "agy-1",
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "view_file",
              tool_info: {
                name: "view_file",
                parameters: { Path: "src/index.ts" },
              },
            },
          })}\n`,
          "stdout",
        );
        request.onOutput?.(
          `${JSON.stringify({
            event: "result",
            result: {
              conversation_id: "agy-1",
              status: "SUCCESS",
              response: "Updated executors list",
            },
          })}\n`,
          "stdout",
        );
        return { code: 0, stdout: "", stderr: "" };
      },
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
    expect(result.summary).toBe("Updated executors list");
    expect(result.sessionId).toBe("agy-1");
    expect(statuses.some((s) => s.startsWith("reading:"))).toBe(true);
  });

  it("streams plain text lines when output format is text", async () => {
    const statuses: string[] = [];
    const recipe = PRINT_CLI_RECIPES.codex!;
    const executor = new PrintCliExecutor({
      recipe,
      binary: "/tmp/codex",
      spawnFn: async (request) => {
        request.onOutput?.("Running lint\n", "stdout");
        request.onOutput?.("All checks passed\n", "stdout");
        return { code: 0, stdout: "All checks passed", stderr: "" };
      },
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
    expect(statuses.some((s) => s.includes("Running lint"))).toBe(true);
  });
});
