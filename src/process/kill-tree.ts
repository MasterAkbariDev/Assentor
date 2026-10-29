import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type KillableProcess = {
  pid?: number;
  kill?: (signal?: NodeJS.Signals) => boolean;
};

/** Caps how long one kill blocks the event loop. Under very heavy load `ps` can exceed it; then only `pkill -P` runs. */
let psTimeoutMs = 500;

/** Test seam: real-process tests raise it so a loaded machine doesn't turn them flaky. */
export function setPsTimeoutMsForTests(ms: number): void {
  psTimeoutMs = ms;
}

/**
 * Per synchronous burst (cleared on the next microtask): the pids already
 * killed, and one `ps` listing shared by every call. Kill paths re-enter this
 * helper (abandon → kill → handle.kill → kill) and the exit path loops over
 * every tracked process; without this each call blocked on its own `ps`.
 */
let burst: { handled: Set<number>; children?: Map<number, number[]> } | undefined;

function currentBurst(): NonNullable<typeof burst> {
  if (!burst) {
    burst = { handled: new Set() };
    queueMicrotask(() => {
      burst = undefined;
    });
  }
  return burst;
}

/**
 * Kill a CLI process and its descendants (Windows cmd.exe / agent trees, shell tools, etc.).
 */
export function killProcessTree(child: KillableProcess | ChildProcess | undefined): void {
  if (!child) {
    return;
  }
  const pid = child.pid;
  const state = currentBurst();
  if (typeof pid === "number" && pid > 0 && !state.handled.has(pid)) {
    state.handled.add(pid);
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
        state.handled.add(descendant);
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
 * One `ps` listing as parent → children, or undefined when `ps` fails. No shell.
 * PATH's `ps` is tried only when `/bin/ps` does not exist, never after a timeout.
 */
function listChildren(): Map<number, number[]> | undefined {
  for (const command of ["/bin/ps", "ps"]) {
    let listing: string | undefined;
    let missing = false;
    try {
      const ps = spawnSync(command, ["-A", "-o", "pid=,ppid="], {
        encoding: "utf8",
        timeout: psTimeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
      });
      missing = (ps.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      listing = !ps.error && ps.status === 0 && typeof ps.stdout === "string" ? ps.stdout : undefined;
    } catch {
      listing = undefined;
    }
    if (listing === undefined) {
      if (missing) {
        continue;
      }
      return undefined;
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
    return children;
  }
  return undefined;
}

/**
 * Every descendant of `root`, from the burst's single `ps` snapshot. Empty when
 * `ps` is missing or fails; `pkill -P` still covers direct children then.
 * Exported for tests.
 */
export function descendantPids(root: number): number[] {
  const state = currentBurst();
  state.children ??= listChildren() ?? new Map();
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of state.children.get(queue.shift()!) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}
