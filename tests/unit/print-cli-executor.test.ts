import { describe, expect, it } from "vitest";
import {
  buildPrintCliArgs,
  PRINT_CLI_RECIPES,
  PrintCliExecutor,
  createEmptyContract,
} from "../../src/index.js";

describe("print-mode CLI recipes", () => {
  it("builds Antigravity print args with agy -p", () => {
    const recipe = PRINT_CLI_RECIPES.antigravity;
    expect(recipe?.tool).toBe("agy");
    expect(buildPrintCliArgs(recipe!, "Fix the tests")).toEqual([
      "--dangerously-skip-permissions",
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
      "text",
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
        expect(request.args.some((arg) => arg.startsWith("-p="))).toBe(true);
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
});
