import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LifecycleScript = "update" | "uninstall" | "install";

export type LifecycleHost = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolve the Assentor package root (repo or ~/.assentor install).
 * Works for both `dist/self/lifecycle.js` and source via build output.
 */
export function resolvePackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/self → repo root
  return path.resolve(here, "../..");
}

function hostHome(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE || env.HOME || os.homedir();
}

export function defaultBinDir(host: LifecycleHost = {}): string {
  const env = host.env ?? process.env;
  if (env.ASSENTOR_BIN) {
    return env.ASSENTOR_BIN;
  }
  return path.join(hostHome(env), ".local", "bin");
}

export function defaultInstallHome(host: LifecycleHost = {}): string {
  const env = host.env ?? process.env;
  if (env.ASSENTOR_HOME) {
    return env.ASSENTOR_HOME;
  }
  return path.join(hostHome(env), ".assentor");
}

export function lifecycleScriptName(
  script: LifecycleScript,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `${script}.ps1` : `${script}.sh`;
}

export function lifecycleProcessArgs(
  scriptPath: string,
  extraArgs: string[] = [],
  options: { platform?: NodeJS.Platform; powerShell?: string } = {},
): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const shell = options.powerShell ?? "powershell.exe";
    return {
      command: shell,
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...extraArgs,
      ],
    };
  }
  return { command: "bash", args: [scriptPath, ...extraArgs] };
}

export async function runScript(
  script: LifecycleScript,
  args: string[] = [],
): Promise<{ code: number; output: string }> {
  const root = resolvePackageRoot();
  const scriptPath = path.join(root, "scripts", lifecycleScriptName(script));
  try {
    await fs.access(scriptPath);
  } catch {
    return {
      code: 1,
      output: `Script not found: ${scriptPath}`,
    };
  }

  const { command, args: spawnArgs } = lifecycleProcessArgs(scriptPath, args);

  return new Promise((resolve) => {
    const child = spawn(command, spawnArgs, {
      cwd: root,
      env: process.env,
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: 1, output: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
}

export async function updateAssentor(): Promise<{ code: number; output: string }> {
  const root = resolvePackageRoot();
  const updateScript = path.join(root, "scripts", lifecycleScriptName("update"));
  let result: { code: number; output: string };
  try {
    await fs.access(updateScript);
    result = await runScript("update");
  } catch {
    result = await runScript("install");
  }
  // Drop stale "local ahead" snapshots after a successful update/rebuild.
  if (result.code === 0) {
    const { clearUpdateCheckCache } = await import("./version.js");
    await clearUpdateCheckCache();
  }
  return result;
}

export async function uninstallAssentor(options: {
  purge?: boolean;
} = {}): Promise<{ code: number; output: string }> {
  const args = options.purge ? ["--purge"] : [];
  return runScript("uninstall", args);
}
