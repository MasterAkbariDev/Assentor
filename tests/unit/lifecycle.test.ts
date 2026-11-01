import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: () => {} })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const {
  buildAssentorLaunchCommand,
  defaultBinDir,
  defaultInstallHome,
  lifecycleProcessArgs,
  lifecycleScriptName,
  relaunchAssentor,
} = await import("../../packages/engine/src/self/lifecycle.js");

describe("lifecycle scripts", () => {
  it("runs PowerShell scripts on Windows instead of bash", () => {
    expect(lifecycleScriptName("update", "win32")).toBe("update.ps1");
    expect(lifecycleScriptName("uninstall", "win32")).toBe("uninstall.ps1");
    expect(lifecycleScriptName("install", "win32")).toBe("install.ps1");

    const { command, args } = lifecycleProcessArgs(
      "C:\\Users\\sam\\.assentor\\scripts\\update.ps1",
      [],
      { platform: "win32", powerShell: "powershell.exe" },
    );
    expect(command).toBe("powershell.exe");
    expect(command).not.toBe("bash");
    expect(args).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Users\\sam\\.assentor\\scripts\\update.ps1",
    ]);
  });

  it("runs bash scripts on Unix", () => {
    expect(lifecycleScriptName("update", "darwin")).toBe("update.sh");
    const { command, args } = lifecycleProcessArgs(
      "/Users/sam/.assentor/scripts/update.sh",
      ["--purge"],
      { platform: "darwin" },
    );
    expect(command).toBe("bash");
    expect(args).toEqual(["/Users/sam/.assentor/scripts/update.sh", "--purge"]);
  });
});

describe("assentor relaunch", () => {
  it("builds cmd.exe launch for Windows shim", () => {
    const launch = buildAssentorLaunchCommand(
      "C:\\Users\\sam\\.local\\bin\\assentor.cmd",
      ["version"],
      "win32",
    );
    expect(launch).toEqual({
      command: "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", '"C:\\Users\\sam\\.local\\bin\\assentor.cmd version"'],
      windowsVerbatimArguments: true,
    });
  });

  it("quotes cmd specials and refuses % / quotes / newlines for a Windows shim", () => {
    const bin = "C:\\Users\\R&D\\assentor.cmd";
    expect(buildAssentorLaunchCommand(bin, ["ui", "-p", "C:\\w\\a^b (1)"], "win32").args[4]).toBe(
      '""C:\\Users\\R&D\\assentor.cmd" ui -p "C:\\w\\a^b (1)""',
    );
    for (const bad of ["%PATH%", 'a"b', "a\nb", "C:\\w\\"]) {
      expect(() => buildAssentorLaunchCommand(bin, ["ui", "-p", bad], "win32")).toThrow(/cmd\.exe would/);
    }
  });

  describe("relaunchAssentor spawn options", () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const realBin = process.env.ASSENTOR_BIN;
    let dir = "";
    afterEach(() => {
      Object.defineProperty(process, "platform", realPlatform);
      if (realBin === undefined) delete process.env.ASSENTOR_BIN;
      else process.env.ASSENTOR_BIN = realBin;
      rmSync(dir, { recursive: true, force: true });
      spawnMock.mockClear();
      vi.restoreAllMocks();
    });

    it("relaunches a .cmd shim detached, inherited stdio, verbatim cmd line", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "assentor-relaunch-"));
      writeFileSync(path.join(dir, "assentor.cmd"), "");
      process.env.ASSENTOR_BIN = dir;
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);

      await expect(relaunchAssentor(["ui", "-p", "R&D"])).rejects.toThrow("exit");
      const bin = path.join(dir, "assentor.cmd");
      expect(spawnMock).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/v:off", "/s", "/c", `"${bin} ui -p "R&D""`],
        {
          detached: true,
          stdio: "inherit",
          env: process.env,
          cwd: process.cwd(),
          windowsHide: false,
          windowsVerbatimArguments: true,
        },
      );
    });
  });

  it("builds bash launch on Unix", () => {
    const launch = buildAssentorLaunchCommand(
      "/Users/sam/.local/bin/assentor",
      ["ui", "-p", "."],
    );
    expect(launch).toEqual({
      command: "/Users/sam/.local/bin/assentor",
      args: ["ui", "-p", "."],
    });
  });
});

describe("default install paths", () => {
  it("uses USERPROFILE on Windows when HOME is unset", () => {
    const env = { USERPROFILE: "C:\\Users\\sam" } as NodeJS.ProcessEnv;
    expect(defaultBinDir({ env })).toBe(
      path.join("C:\\Users\\sam", ".local", "bin"),
    );
    expect(defaultInstallHome({ env })).toBe(
      path.join("C:\\Users\\sam", ".assentor"),
    );
  });

  it("honors ASSENTOR_BIN and ASSENTOR_HOME", () => {
    const env = {
      USERPROFILE: "C:\\Users\\sam",
      ASSENTOR_BIN: "D:\\tools\\bin",
      ASSENTOR_HOME: "D:\\assentor",
    } as NodeJS.ProcessEnv;
    expect(defaultBinDir({ env })).toBe("D:\\tools\\bin");
    expect(defaultInstallHome({ env })).toBe("D:\\assentor");
  });
});
