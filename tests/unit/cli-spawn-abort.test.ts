import { describe, expect, it, vi } from "vitest";
import { defaultCliSpawn } from "../../packages/engine/src/providers/reviewers/cli/index.js";
import { trackedProcessCount } from "../../packages/engine/src/process/tracker.js";

// The abort path of the read-only CLI spawn used for seat asks (mode routing).

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("defaultCliSpawn abort", { timeout: 30_000 }, () => {
  it("kills the running process on abort, resolves without timedOut and removes its listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let pid = 0;
    const running = defaultCliSpawn({
      command: process.execPath,
      args: ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 60_000,
      signal: controller.signal,
      onOutput: (chunk) => {
        pid ||= Number(chunk.trim());
      },
    });
    await vi.waitFor(() => expect(pid).toBeGreaterThan(0), { timeout: 20_000 });
    expect(trackedProcessCount()).toBeGreaterThan(0);
    controller.abort();
    const result = await running;
    expect(result.code).toBeNull();
    expect(result.timedOut).toBeUndefined();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  });

  it("spawns nothing when the signal is already aborted", async () => {
    const onOutput = vi.fn();
    const result = await defaultCliSpawn({
      command: process.execPath,
      args: ["-e", "console.log('ran')"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      signal: AbortSignal.abort(),
      onOutput,
    });
    expect(result).toMatchObject({ code: null, stdout: "" });
    expect(onOutput).not.toHaveBeenCalled();
  });
});
