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

describe("descendantPids ps fallback", () => {
  const fail = (code: string) => ({ error: Object.assign(new Error(code), { code }), status: null, stdout: "" });

  it("does not run a second ps after /bin/ps timed out", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { descendantPids } = await import("../../src/process/kill-tree.js");
    await Promise.resolve(); // new burst
    spawnSyncMock.mockReset().mockReturnValue(fail("ETIMEDOUT"));
    expect(descendantPids(4242)).toEqual([]);
    expect(spawnSyncMock.mock.calls.map(([command]) => command)).toEqual(["/bin/ps"]);
    expect(spawnSyncMock.mock.calls[0]![2]).toMatchObject({ timeout: 500 });
  });

  it("falls back to ps on PATH only when /bin/ps does not exist", async () => {
    const { descendantPids } = await import("../../src/process/kill-tree.js");
    await Promise.resolve();
    spawnSyncMock
      .mockReset()
      .mockReturnValueOnce(fail("ENOENT"))
      .mockReturnValueOnce({ status: 0, stdout: "  10 1\n  11 10\n  12 11\n  13 1\n" });
    expect(descendantPids(10)).toEqual([11, 12]);
    expect(spawnSyncMock.mock.calls.map(([command]) => command)).toEqual(["/bin/ps", "ps"]);
  });
});
