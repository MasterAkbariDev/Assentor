import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Count `ps` runs: one interrupt must take one process-table snapshot.
const psCalls: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawnSync: ((command: string, ...rest: unknown[]) => {
      if (/(^|\/)ps$/.test(command)) {
        psCalls.push(command);
      }
      return (real.spawnSync as (...args: unknown[]) => unknown)(command, ...rest);
    }) as typeof real.spawnSync,
  };
});

const { setPsTimeoutMsForTests } = await import("../../src/process/kill-tree.js");
const {
  CursorExecutor,
  PrintCliExecutor,
  createEmptyContract,
  killAllTrackedProcesses,
  trackChildProcess,
  trackedProcessCount,
} = await import("../../src/index.js");

const posix = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fake agent CLI: prints its pid as a stream-json init event, starts a grandchild, sleeps. */
const AGENT_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: `${process.pid}-${g.pid}` }) + "\\n");',
  "setInterval(() => {}, 1000);",
].join("\n");

let dir = "";
let agent = "";
let bystander: ChildProcess | undefined;

beforeAll(() => {
  setPsTimeoutMsForTests(15_000); // a loaded CI machine must not make `ps` time out here
  dir = mkdtempSync(path.join(os.tmpdir(), "assentor-interrupt-"));
  agent = path.join(dir, "fake-agent");
  // Run by the kernel via the shebang; nothing goes through a shell.
  writeFileSync(agent, `#!${process.execPath}\n${AGENT_SCRIPT}\n`);
  chmodSync(agent, 0o755);
});

afterEach(() => {
  bystander?.kill("SIGKILL");
  bystander = undefined;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function startBystander(): ChildProcess {
  bystander = trackChildProcess(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  return bystander;
}

async function pidsFromOutput(read: () => string): Promise<number[]> {
  await vi.waitFor(() => expect(read()).toMatch(/"session_id":"\d+-\d+"/), { timeout: 20_000 });
  return read().match(/"session_id":"(\d+)-(\d+)"/)!.slice(1).map(Number);
}

async function expectDead(pids: number[]): Promise<void> {
  try {
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 3_000, interval: 50 });
  } finally {
    for (const pid of pids.filter(alive)) {
      process.kill(pid, "SIGKILL");
    }
  }
}

const task = { taskId: "t-1", projectPath: os.tmpdir(), contract: createEmptyContract("x"), prompt: "x" };

describe.skipIf(!posix)("interrupt through the real spawn path", () => {
  it("cursor interrupt kills its own tree with one ps snapshot and spares other tracked processes", async () => {
    const other = startBystander();
    let output = "";
    const executor = new CursorExecutor({ binary: agent, resultGraceMs: 0, onOutput: (chunk) => { output += chunk; } });
    const turn = executor.run(task);
    const pids = await pidsFromOutput(() => output);

    psCalls.length = 0;
    expect(executor.interrupt()).toBe(true);
    expect(psCalls).toHaveLength(1);
    expect(await turn).toMatchObject({ status: "cancelled", interrupted: true });
    await expectDead(pids);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    expect(trackedProcessCount()).toBe(1); // only the bystander
  }, 30_000);

  it("cursor cancel also kills only its own tree", async () => {
    const other = startBystander();
    let output = "";
    const executor = new CursorExecutor({ binary: agent, resultGraceMs: 0, onOutput: (chunk) => { output += chunk; } });
    const turn = executor.run(task);
    const pids = await pidsFromOutput(() => output);

    await executor.cancel(task.taskId);
    expect((await turn).status).toBe("cancelled");
    await expectDead(pids);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(other.signalCode).toBeNull();
  }, 30_000);

  it("killing every tracked process (exit path) takes one ps snapshot", async () => {
    const sleepers = [1, 2, 3].map(() =>
      trackChildProcess(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })),
    );
    await vi.waitFor(() => expect(sleepers.every((child) => child.pid)).toBe(true));
    psCalls.length = 0;
    killAllTrackedProcesses();
    expect(psCalls).toHaveLength(1);
    expect(trackedProcessCount()).toBe(0);
    await expectDead(sleepers.map((child) => child.pid!));
  }, 30_000);

  it("print-CLI interrupt takes one ps snapshot", async () => {
    let output = "";
    const executor = new PrintCliExecutor({
      recipe: { id: "fake", name: "Fake", tool: "claude", printArgs: [], outputFormat: "text", promptStyle: "positional" },
      binary: agent,
      onOutput: (chunk) => {
        output += chunk;
      },
    });
    const turn = executor.run(task);
    const pids = await pidsFromOutput(() => output);

    psCalls.length = 0;
    expect(executor.interrupt()).toBe(true);
    expect(psCalls).toHaveLength(1);
    expect(await turn).toMatchObject({ status: "cancelled", interrupted: true });
    await expectDead(pids);
  }, 30_000);
});
