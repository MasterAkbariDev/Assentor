import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { killProcessTree } from "../../src/process/kill-tree.js";
import {
  killAllTrackedProcesses,
  trackChildProcess,
  trackedProcessCount,
} from "../../src/process/tracker.js";

describe("process tracker", () => {
  it("tracks and kills shell children", async () => {
    const child = trackChildProcess(
      spawn(process.execPath, [
        "-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
      ]),
    );
    for (let i = 0; i < 50 && !child.pid; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(trackedProcessCount()).toBeGreaterThan(0);
    killAllTrackedProcesses();
    expect(trackedProcessCount()).toBe(0);
  }, 8_000);

  it("killProcessTree is safe on missing pid", () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
  });
});
