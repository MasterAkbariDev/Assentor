import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findOnPath } from "../executors/cli-locator.js";

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
  // Windows PowerShell 5.1 can fail to parse a stale update.ps1;
  // install.ps1 already refreshes a managed ~/.assentor clone.
  if (result.code !== 0 && process.platform === "win32") {
    const fallback = await runScript("install");
    if (fallback.code === 0) {
      result = fallback;
    }
  }
  // Drop stale "local ahead" snapshots after a successful update/rebuild.
  if (result.code === 0) {
    const { clearUpdateCheckCache } = await import("./version.js");
    await clearUpdateCheckCache();
  }
  return result;
}

/** Resolve the launcher users invoke (`assentor` on PATH or package `bin/assentor`). */
export async function resolveAssentorBinary(): Promise<string> {
  const env = process.env;
  if (env.ASSENTOR_BIN) {
    for (const name of assentorBinaryNames()) {
      const candidate = path.join(env.ASSENTOR_BIN, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
  }

  for (const name of assentorBinaryNames()) {
    const onPath = findOnPath(name);
    if (onPath) {
      return onPath;
    }
  }

  return path.join(resolvePackageRoot(), "bin", "assentor");
}

function assentorBinaryNames(): string[] {
  return process.platform === "win32"
    ? ["assentor.cmd", "assentor.bat", "assentor.exe", "assentor"]
    : ["assentor"];
}

export function buildAssentorLaunchCommand(
  binary: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const lower = binary.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return { command: "cmd.exe", args: ["/d", "/s", "/c", binary, ...args] };
    }
    if (lower.endsWith(".ps1")) {
      return lifecycleProcessArgs(binary, args);
    }
  }
  return { command: binary, args };
}

/**
 * Spawn a fresh Assentor process and exit the current one.
 * Use after self-update so the running Node process reloads rebuilt dist/.
 */
export async function relaunchAssentor(
  args: string[] = process.argv.slice(1),
): Promise<never> {
  const binary = await resolveAssentorBinary();
  const launch = buildAssentorLaunchCommand(binary, args);
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
    windowsHide: false,
  });
  child.unref();
  process.exit(0);
}

/** Run a subcommand in a fresh process (used to verify post-update version). */
export async function runAssentorSubcommand(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const binary = await resolveAssentorBinary();
  const launch = buildAssentorLaunchCommand(binary, args);
  const result = spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    env: process.env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function uninstallAssentor(options: {
  purge?: boolean;
} = {}): Promise<{ code: number; output: string }> {
  const args = options.purge ? ["--purge"] : [];
  return runScript("uninstall", args);
}
