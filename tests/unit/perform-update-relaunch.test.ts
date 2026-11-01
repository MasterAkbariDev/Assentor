import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCmdSafeArgs } from "../../packages/engine/src/executors/cli-locator.js";

const relaunch = vi.hoisted(() => vi.fn());
vi.mock("../../packages/engine/src/self/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/engine/src/self/index.js")>()),
  updateAssentor: async () => ({ code: 0, output: "updated" }),
  getLocalVersionSync: () => "1.2.3",
  relaunchAssentor: relaunch,
}));

const { performUpdate } = await import("../../packages/engine/src/services/app.js");

afterEach(() => {
  relaunch.mockReset();
  vi.restoreAllMocks();
});

describe("performUpdate relaunch", () => {
  it("a relaunch refused for cmd.exe-unsafe args is a note, not an error", async () => {
    relaunch.mockImplementation(async (args: string[]) => assertCmdSafeArgs(args));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await performUpdate({ relaunchArgs: ["ui", "-p", "100%"] });
    const note =
      "Updated to v1.2.3. Restart assentor manually; your arguments contain characters that can't pass through cmd.exe safely.";
    expect(result).toEqual({ code: 0, output: `updated\n${note}`, localVersion: "1.2.3", relaunched: false });
    expect(stderr).toHaveBeenCalledWith(`${note}\n`);
  });

  it("other relaunch errors still propagate", async () => {
    relaunch.mockRejectedValue(new Error("boom"));
    await expect(performUpdate({ relaunchArgs: ["ui"] })).rejects.toThrow("boom");
  });
});
