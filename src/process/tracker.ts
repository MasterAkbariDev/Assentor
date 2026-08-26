import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "./kill-tree.js";

const tracked = new Map<number, ChildProcess>();

export function trackChildProcess(child: ChildProcess): ChildProcess {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    tracked.set(pid, child);
    const untrack = () => {
      tracked.delete(pid);
    };
    child.once("exit", untrack);
    child.once("error", untrack);
  }
  return child;
}

export function untrackChildProcess(child: ChildProcess | undefined): void {
  const pid = child?.pid;
  if (typeof pid === "number") {
    tracked.delete(pid);
  }
}

export function killAllTrackedProcesses(): void {
  for (const child of tracked.values()) {
    killProcessTree(child);
  }
  tracked.clear();
}

export function trackedProcessCount(): number {
  return tracked.size;
}
