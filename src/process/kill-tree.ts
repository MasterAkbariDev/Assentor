import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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
      // Snapshot descendants first: once `pid` dies they are re-parented and
      // `pkill -P` no longer finds them (grandchildren used to survive).
      const descendants = descendantPids(pid);
      try {
        // Try killing process group if detached/leader
        process.kill(-pid, "SIGKILL");
      } catch {
        // not process group leader or unsupported
      }
      try {
        spawn("pkill", ["-9", "-P", String(pid)], {
          stdio: "ignore",
        }).unref();
      } catch {
        // fall through
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited or permission denied
      }
      for (const descendant of descendants) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  }
  try {
    child.kill?.("SIGKILL");
  } catch {
    // already exited
  }
}

/**
 * Every descendant of `root` from one `ps` snapshot (no shell). Empty when `ps`
 * is missing or fails; `pkill -P` above still covers direct children then.
 * Exported for tests.
 */
export function descendantPids(root: number): number[] {
  let listing: string;
  try {
    const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    listing = typeof ps.stdout === "string" ? ps.stdout : "";
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid! <= 0) {
      continue;
    }
    const list = children.get(ppid!) ?? [];
    list.push(pid!);
    children.set(ppid!, list);
  }
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}
