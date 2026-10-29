import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn(() => ({ unref: vi.fn() }));
const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
});

describe("killProcessTree on Windows", () => {
  it("runs taskkill /T /F on the pid, without a shell, and kills the handle", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const processKill = vi.spyOn(process, "kill");
    const { killProcessTree } = await import("../../src/process/kill-tree.js");
    const kill = vi.fn(() => true);

    killProcessTree({ pid: 4242, kill });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("taskkill", ["/pid", "4242", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    processKill.mockRestore();
  });
});
