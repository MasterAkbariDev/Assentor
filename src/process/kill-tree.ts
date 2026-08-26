import { spawn, type ChildProcess } from "node:child_process";

export type KillableProcess = {
  pid?: number;
  kill?: (signal?: NodeJS.Signals) => boolean;
};

/**
 * Kill a CLI process and its descendants (Windows cmd.exe / agent trees, shell tools, etc.).
 */
export function killProcessTree(child: KillableProcess | ChildProcess | undefined): void {
  if (!child) {
    return;
  }
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } catch {
        // fall through
      }
    } else {
      try {
        spawn("pkill", ["-9", "-P", String(pid)], {
          stdio: "ignore",
        }).unref();
      } catch {
        // fall through
      }
    }
  }
  try {
    child.kill?.("SIGKILL");
  } catch {
    // already exited
  }
}
