import { spawn } from "node:child_process";
import { trackChildProcess, untrackChildProcess } from "./tracker.js";
import { killProcessTree } from "./kill-tree.js";

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

export async function runShellCommand(
  command: string,
  cwd: string,
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
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

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const str = chunk.toString();
      if (stdout.length < maxBuffer) {
        stdout += str.slice(0, maxBuffer - stdout.length);
      } else if (!stdoutTruncated) {
        stdoutTruncated = true;
        stdout += "\n... (output truncated at buffer limit)";
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const str = chunk.toString();
      if (stderr.length < maxBuffer) {
        stderr += str.slice(0, maxBuffer - stderr.length);
      } else if (!stderrTruncated) {
        stderrTruncated = true;
        stderr += "\n... (stderr truncated at buffer limit)";
      }
    });
    child.on("error", (error) => {
      finish({ stdout, stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code: code ?? 1 });
    });
  });
}
