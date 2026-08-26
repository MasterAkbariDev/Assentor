import { spawn } from "node:child_process";
import { trackChildProcess, untrackChildProcess } from "./tracker.js";
import { killProcessTree } from "./kill-tree.js";

export async function runShellCommand(
  command: string,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = trackChildProcess(
      spawn(command, {
        cwd,
        shell: true,
        env: process.env,
        windowsHide: true,
      }),
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      untrackChildProcess(child);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({
        stdout,
        stderr: `${stderr}\n(timed out)`.trim(),
        code: 124,
      });
    }, options.timeoutMs ?? 5 * 60_000);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ stdout, stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code: code ?? 1 });
    });
  });
}
