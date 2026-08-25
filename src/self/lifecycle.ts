import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the Assentor package root (repo or ~/.assentor install).
 * Works for both `dist/self/lifecycle.js` and source via build output.
 */
export function resolvePackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/self → repo root
  return path.resolve(here, "../..");
}

export function defaultBinDir(): string {
  return process.env.ASSENTOR_BIN || path.join(process.env.HOME ?? "", ".local", "bin");
}

export function defaultInstallHome(): string {
  return process.env.ASSENTOR_HOME || path.join(process.env.HOME ?? "", ".assentor");
}

export async function runScript(
  scriptName: "update.sh" | "uninstall.sh" | "install.sh",
  args: string[] = [],
): Promise<{ code: number; output: string }> {
  const root = resolvePackageRoot();
  const script = path.join(root, "scripts", scriptName);
  try {
    await fs.access(script);
  } catch {
    return {
      code: 1,
      output: `Script not found: ${script}`,
    };
  }

  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], {
      cwd: root,
      env: process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
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
  const updateScript = path.join(root, "scripts", "update.sh");
  try {
    await fs.access(updateScript);
    return runScript("update.sh");
  } catch {
    // Fall back to install.sh (self-updates when ASSENTOR_HOME is set)
    return runScript("install.sh");
  }
}

export async function uninstallAssentor(options: {
  purge?: boolean;
} = {}): Promise<{ code: number; output: string }> {
  const args = options.purge ? ["--purge"] : [];
  return runScript("uninstall.sh", args);
}
