import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildAssentorLaunchCommand,
  defaultBinDir,
  defaultInstallHome,
  lifecycleProcessArgs,
  lifecycleScriptName,
} from "../../src/self/lifecycle.js";

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
    expect(launch.command).toBe("cmd.exe");
    expect(launch.args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\Users\\sam\\.local\\bin\\assentor.cmd",
      "version",
    ]);
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
