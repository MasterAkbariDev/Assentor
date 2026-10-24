import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPrintCliArgs,
  PRINT_CLI_RECIPES,
  PrintCliExecutor,
  createEmptyContract,
} from "../../src/index.js";
import {
  createExecutor,
  resolveExecutorModel,
} from "../../src/cli/commands.js";

// Captures what the real default spawn would launch, without starting any CLI.
const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);

vi.mock("../../src/executors/cli-locator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/executors/cli-locator.js")>();
  return {
    ...actual,
    locateBinary: () => "/fake/bin",
    spawnCliProcess: (command: string, args: string[]) => {
      spawned.push({ command, args });
      const child = new EventEmitter() as unknown as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  };
});

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

  it("builds Antigravity resume args with --conversation", () => {
    expect(
      buildPrintCliArgs(PRINT_CLI_RECIPES.antigravity!, "Continue work", {
        sessionId: "conv-1",
      }),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--conversation",
      "conv-1",
      "--output-format",
      "stream-json",
      "-p=Continue work",
    ]);
  });

  it("builds Antigravity continue args without a session id", () => {
    expect(
      buildPrintCliArgs(PRINT_CLI_RECIPES.antigravity!, "Continue work", {
        continueRecent: true,
      }),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--continue",
      "--output-format",
      "stream-json",
      "-p=Continue work",
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
    expect(statuses.some((s) => s.includes("#1"))).toBe(true);
  });

  it("continues Antigravity with --conversation when session id is known", async () => {
    const recipe = PRINT_CLI_RECIPES.antigravity!;
    const executor = new PrintCliExecutor({
      recipe,
      binary: "/tmp/agy",
      spawnFn: async (request) => {
        expect(request.args).toContain("--conversation");
        expect(request.args).toContain("agy-1");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await executor.continue({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      sessionId: "agy-1",
      mode: "supervised",
      messages: [],
    });
  });

  it("continues Antigravity with --continue when no session id", async () => {
    const recipe = PRINT_CLI_RECIPES.antigravity!;
    const executor = new PrintCliExecutor({
      recipe,
      binary: "/tmp/agy",
      spawnFn: async (request) => {
        expect(request.args).toContain("--continue");
        expect(request.args).not.toContain("--conversation");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await executor.continue({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      mode: "supervised",
      messages: [],
    });
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

describe("print-mode CLI model selection", () => {
  it("claude-code puts --model before the prompt, which stays last", () => {
    const args = buildPrintCliArgs(PRINT_CLI_RECIPES["claude-code"]!, "Implement average", {
      model: "opus",
    });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "-p",
      "--output-format",
      "stream-json",
      "--model",
      "opus",
      "Implement average",
    ]);
  });

  it("codex builds exec, skip-git-repo-check, -m, then the prompt", () => {
    expect(
      buildPrintCliArgs(PRINT_CLI_RECIPES.codex!, "Do it", { model: "gpt-5" }),
    ).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--skip-git-repo-check",
      "-m",
      "gpt-5",
      "Do it",
    ]);
  });

  it("antigravity puts --model right before the attached -p= prompt", () => {
    const args = buildPrintCliArgs(PRINT_CLI_RECIPES.antigravity!, "Fix the tests", {
      model: "opus",
    });
    expect(args.slice(-4)).toEqual([
      "stream-json",
      "--model",
      "opus",
      "-p=Fix the tests",
    ]);
  });

  it("AUTO, blank, whitespace-only, and undefined add no model flag", () => {
    const recipe = PRINT_CLI_RECIPES["claude-code"]!;
    const plain = buildPrintCliArgs(recipe, "Task");
    for (const model of ["AUTO", "", "   ", undefined]) {
      expect(buildPrintCliArgs(recipe, "Task", { model })).toEqual(plain);
    }
    expect(plain).not.toContain("--model");
  });

  it("passes the model through run() to the spawned args", async () => {
    let captured: string[] = [];
    const executor = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES["claude-code"]!,
      binary: "/tmp/claude",
      model: "opus",
      spawnFn: async (request) => {
        captured = request.args;
        return { code: 0, stdout: "done", stderr: "" };
      },
    });
    await executor.run({
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });
    expect(captured.slice(-3)).toEqual(["--model", "opus", "goal"]);
  });

  it("warns once and leaves args unchanged for a recipe without a model flag", async () => {
    const warnings: string[] = [];
    const argsSeen: string[][] = [];
    const executor = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES.qwen!,
      binary: "/tmp/qwen",
      model: "qwen-max",
      onStatus: (status) => {
        if (status.activity === "warning") {
          warnings.push(status.detail);
        }
      },
      spawnFn: async (request) => {
        argsSeen.push(request.args);
        return { code: 0, stdout: "done", stderr: "" };
      },
    });
    const task = {
      taskId: "t1",
      projectPath: "/tmp/project",
      contract: createEmptyContract("goal"),
      prompt: "goal",
    };
    await executor.run(task);
    await executor.run({ ...task, taskId: "t2" });

    expect(warnings).toEqual([
      "Qwen Code does not support model selection; using CLI default",
    ]);
    expect(argsSeen[0]).toEqual(buildPrintCliArgs(PRINT_CLI_RECIPES.qwen!, "goal"));
    expect(argsSeen[1]).toEqual(argsSeen[0]);
  });
});

describe("executor model through createExecutor", () => {
  let projectDir: string;

  beforeEach(async () => {
    spawned.length = 0;
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-flag-"));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  async function runWithModel(provider: string, model: string | undefined) {
    const executor = await createExecutor(provider, projectDir, { model });
    await executor.run({
      taskId: "t1",
      projectPath: projectDir,
      contract: createEmptyContract("goal"),
      prompt: "goal",
    });
    return spawned.at(-1)!.args;
  }

  it("claude-code gets --model before the prompt", async () => {
    const args = await runWithModel("claude-code", "opus");
    expect(args.slice(-3)).toEqual(["--model", "opus", "goal"]);
  });

  it("codex gets -m before the prompt, after exec", async () => {
    const args = await runWithModel("codex", "gpt-5");
    expect(args.slice(-5)).toEqual(["exec", "--skip-git-repo-check", "-m", "gpt-5", "goal"]);
  });

  it("AUTO and unset add no model flag", async () => {
    for (const model of ["AUTO", undefined]) {
      const args = await runWithModel("claude-code", model);
      expect(args).not.toContain("--model");
      expect(args.at(-1)).toBe("goal");
    }
  });

  it("the --executor-model flag overrides config.executor.model", async () => {
    const model = resolveExecutorModel("opus", "sonnet");
    const args = await runWithModel("claude-code", model);
    expect(args.slice(-3)).toEqual(["--model", "opus", "goal"]);
    expect(args).not.toContain("sonnet");
  });

  it("config.executor.model is used when there is no flag", async () => {
    const model = resolveExecutorModel(undefined, "sonnet");
    const args = await runWithModel("claude-code", model);
    expect(args.slice(-3)).toEqual(["--model", "sonnet", "goal"]);
  });

  it("resolveExecutorModel: flag, then config, then unset; blank flag falls back", () => {
    expect(resolveExecutorModel("opus", "sonnet")).toBe("opus");
    expect(resolveExecutorModel("AUTO", "sonnet")).toBe("AUTO");
    expect(resolveExecutorModel(undefined, "sonnet")).toBe("sonnet");
    expect(resolveExecutorModel("   ", "sonnet")).toBe("sonnet");
    expect(resolveExecutorModel(undefined, undefined)).toBeUndefined();
  });
});
