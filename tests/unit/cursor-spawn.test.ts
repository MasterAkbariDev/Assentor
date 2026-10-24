import { describe, expect, it } from "vitest";
import { createEmptyContract } from "../../src/index.js";
import {
  CursorExecutor,
  defaultSpawn,
} from "../../src/providers/executors/cursor/index.js";

async function cursorArgs(options: { model?: string; extraArgs?: string[] }): Promise<string[]> {
  let args: string[] = [];
  const executor = new CursorExecutor({
    binary: "/tmp/cursor",
    outputFormat: "text",
    ...options,
    spawnFn: async (request) => {
      args = request.args;
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  await executor.run({
    taskId: "t1",
    projectPath: process.cwd(),
    contract: createEmptyContract("goal"),
    prompt: "goal",
  });
  return args;
}

describe("CursorExecutor model flag", () => {
  it("passes --model right before the prompt", async () => {
    const args = await cursorArgs({ model: "opus" });
    expect(args.slice(-3)).toEqual(["--model", "opus", "goal"]);
  });

  it("places --model immediately before extraArgs", async () => {
    const args = await cursorArgs({ model: "opus", extraArgs: ["--x"] });
    expect(args.slice(-4)).toEqual(["--model", "opus", "--x", "goal"]);
  });

  it("adds no --model for AUTO or an unset model", async () => {
    expect(await cursorArgs({ model: "AUTO" })).not.toContain("--model");
    expect(await cursorArgs({})).not.toContain("--model");
  });
});

describe("defaultSpawn", () => {
  it("returns after a stream result even if the child ignores SIGTERM", async () => {
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "still alive",
      session_id: "hang-1",
    });
    const script = `
      process.stdout.write(${JSON.stringify(`${resultLine}\n`)});
      process.on("SIGTERM", () => {});
      process.on("SIGINT", () => {});
      setInterval(() => {}, 10000);
    `;
    const started = Date.now();
    const result = await defaultSpawn({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 20_000,
      resultGraceMs: 40,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).not.toBe(true);
    expect(result.stdout).toContain("still alive");
  }, 8_000);

  it("abandon unblocks spawn without waiting for close", async () => {
    const script = `
      process.on("SIGTERM", () => {});
      process.on("SIGINT", () => {});
      setInterval(() => {}, 10000);
    `;
    let abandon: (() => void) | undefined;
    const spawnPromise = defaultSpawn({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 20_000,
      resultGraceMs: 60_000,
      onSpawn: (child) => {
        abandon = child.abandon;
      },
    });
    for (let i = 0; i < 50 && !abandon; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(abandon).toBeTypeOf("function");
    const started = Date.now();
    abandon?.();
    const result = await spawnPromise;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.timedOut).not.toBe(true);
  }, 8_000);
});
