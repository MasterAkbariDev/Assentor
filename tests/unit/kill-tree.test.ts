import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { descendantPids, killProcessTree, setPsTimeoutMsForTests } from "../../packages/engine/src/process/kill-tree.js";
import { trackedProcessCount } from "../../packages/engine/src/process/tracker.js";
import { createEmptyContract, PrintCliExecutor } from "../../packages/engine/src/index.js";

const posix = process.platform !== "win32";
// A loaded machine must not make `ps` time out here; the 500 ms cap is production's.
setPsTimeoutMsForTests(15_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Node script: start a sleeping grandchild, print "<own pid> <grandchild pid>", sleep. */
const PARENT_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'process.stdout.write(`${process.pid} ${g.pid}\\n`);',
  "setInterval(() => {}, 1000);",
].join("\n");

async function expectDead(pids: number[]): Promise<void> {
  try {
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 3_000, interval: 50 });
  } finally {
    for (const pid of pids.filter(alive)) {
      process.kill(pid, "SIGKILL"); // never leak from a failing test
    }
  }
}

describe.skipIf(!posix)("killProcessTree (POSIX)", () => {
  it("kills grandchildren too", async () => {
    const child = spawn(process.execPath, ["-e", PARENT_SCRIPT], { stdio: ["ignore", "pipe", "ignore"] });
    const pids = await new Promise<number[]>((resolve) =>
      child.stdout!.once("data", (chunk) => resolve(String(chunk).trim().split(" ").map(Number))),
    );
    expect(descendantPids(pids[0]!)).toContain(pids[1]);
    killProcessTree(child);
    await expectDead(pids);
  }, 10_000);

  it("interrupting a real print-CLI turn leaves no process and an empty tracker", async () => {
    let output = "";
    const executor = new PrintCliExecutor({
      recipe: {
        id: "fake",
        name: "Fake CLI",
        tool: "claude",
        printArgs: ["-e", PARENT_SCRIPT],
        outputFormat: "text",
        promptStyle: "positional",
        modelFlag: "--model",
      },
      binary: process.execPath,
      timeoutMs: 20_000,
      onOutput: (chunk) => {
        output += chunk;
      },
    });
    const turn = executor.run({
      taskId: "t-1",
      projectPath: process.cwd(),
      contract: createEmptyContract("x"),
      prompt: "x",
    });
    await vi.waitFor(() => expect(output).toMatch(/^\d+ \d+\n/), { timeout: 20_000 });
    const pids = output.trim().split(" ").map(Number);
    expect(trackedProcessCount()).toBe(1);

    await executor.interrupt();
    expect(await turn).toMatchObject({ status: "cancelled", interrupted: true });
    expect(trackedProcessCount()).toBe(0);
    await expectDead(pids);
  }, 30_000);
});
