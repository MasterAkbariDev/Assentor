import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutor } from "../../packages/cli/src/cli/commands.js";
import { buildExecutorRegistry } from "../../packages/engine/src/executors/adapters.js";
import {
  createBudgets,
  createEmptyContract,
  ReviewStatus,
  Supervisor,
  TaskState,
  trackedProcessCount,
  type Executor,
  type ReviewerTurnResult,
} from "../../packages/engine/src/index.js";

/**
 * The executors `assentor run` really builds (registry adapter wrapped by
 * withAssentorGitignore) must expose setModel / interrupt. A fake agent CLI
 * reports the model it was given; with SLEEP in the prompt it never finishes.
 */
const AGENT_SCRIPT = [
  "const args = process.argv.slice(2);",
  "const prompt = args[args.length - 1];",
  'const i = args.indexOf("--model");',
  'const model = i === -1 ? "AUTO" : args[i + 1];',
  'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: `s-${process.pid}` }) + "\\n");',
  'if (prompt.includes("SLEEP")) { setInterval(() => {}, 1000); }',
  'else { process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: `model=${model}` }) + "\\n"); }',
].join("\n");

const posix = process.platform !== "win32";
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "assentor-registry-switch-"));
  const agent = path.join(dir, "fake-agent");
  // Run by the kernel via the shebang; nothing goes through a shell.
  writeFileSync(agent, `#!${process.execPath}\n${AGENT_SCRIPT}\n`);
  chmodSync(agent, 0o755);
  vi.stubEnv("ASSENTOR_CLAUDE_BINARY", agent);
  vi.stubEnv("ASSENTOR_CURSOR_BINARY", agent);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  expect(trackedProcessCount()).toBe(0);
});

const task = (prompt: string) => ({
  taskId: "t-1",
  projectPath: dir,
  contract: createEmptyContract(prompt),
  prompt,
});

describe("registry adapters forward setModel", () => {
  it("exposes setModel only for CLIs with a model flag; interrupt is false before any turn", () => {
    const registry = buildExecutorRegistry();
    const ids = ["cursor", "claude-code", "antigravity", "codex", "qwen", "opencode"];
    expect(ids.map((id) => typeof registry.get(id)!.setModel)).toEqual([
      "function",
      "function",
      "function",
      "function",
      "undefined",
      "undefined",
    ]);
    for (const id of ids) {
      expect(registry.get(id)!.interrupt!()).toBe(false);
    }
  });
});

describe.skipIf(!posix)("real executors from createExecutor", () => {
  for (const provider of ["claude-code", "cursor"]) {
    it(`${provider}: a switch applies at the next turn, also before the first turn`, async () => {
      const executor = await createExecutor(provider, dir, { model: "opus", timeoutMs: 20_000 });
      executor.setModel!("haiku"); // before the lazy inner executor exists
      expect((await executor.run(task("one"))).summary).toBe("model=haiku");
      executor.setModel!("sonnet");
      expect((await executor.run(task("two"))).summary).toBe("model=sonnet");
    }, 30_000);

    it(`${provider}: interrupt stops the running turn and later turns still run`, async () => {
      let output = "";
      const executor = await createExecutor(provider, dir, {
        model: "opus",
        timeoutMs: 20_000,
        onOutput: (chunk) => {
          output += chunk;
        },
      });
      const turn = executor.run(task("SLEEP"));
      await vi.waitFor(() => expect(output).toContain('"subtype":"init"'), { timeout: 20_000 });
      expect(executor.interrupt!()).toBe(true);
      expect(await turn).toMatchObject({ status: "cancelled", interrupted: true });
      expect(executor.interrupt!()).toBe(false);
      expect((await executor.run(task("after"))).status).toBe("completed");
    }, 30_000);
  }

  it("Supervisor.requestModelChange accepts the real claude executor and applies the switch", async () => {
    const executor: Executor = await createExecutor("claude-code", dir, { model: "opus", timeoutMs: 20_000 });
    const pass = async (): Promise<ReviewerTurnResult> => ({
      result: {
        status: ReviewStatus.Pass,
        confidence: 0.9,
        summary: "ok",
        issues: [],
        requiredChanges: [],
        optionalChanges: [],
        evidenceRequests: [],
      },
    });
    const supervisor = new Supervisor({
      projectPath: dir,
      contract: createEmptyContract("Implement average()"),
      executor,
      reviewer: { name: "r", review: pass, continue: pass },
      budgets: createBudgets({ maxRounds: 2, maxMessages: 20 }),
      skipGates: true,
      maxFailureRetries: 0,
    });
    expect(supervisor.requestModelChange("executor", "sonnet")).toEqual({ ok: true, interrupting: false });
    const result = await supervisor.run();
    expect(result.status).toBe(TaskState.Done);
    const completed = result.events.find((event) => event.type === "executor.completed");
    expect(completed?.data?.summary).toBe("model=sonnet");
  }, 30_000);
});
