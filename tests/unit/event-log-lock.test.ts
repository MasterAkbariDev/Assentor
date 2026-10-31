import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createId,
  EventLog,
  EventLogLockedError,
  readSessionEvents,
  sessionPaths,
} from "../../packages/engine/src/index.js";
import { runAssentorTask } from "../../packages/cli/src/cli/commands.js";

const dirs: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

async function project(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-log-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const draft = (sessionId: string) => ({
  type: "session.created" as const,
  sessionId,
  data: { title: "t" },
});

function lockFile(projectPath: string, sessionId: string): string {
  return path.join(sessionPaths(projectPath, sessionId).root, "writer.lock");
}

async function writeLock(file: string, owner: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(owner), "utf8");
}

/** A pid that existed and has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

function livePid(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  return child.pid!;
}

describe("EventLog writer lock", () => {
  it("allows one writer at a time, including within one process", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);

    const second = EventLog.open(projectPath, sessionId);
    await expect(second).rejects.toBeInstanceOf(EventLogLockedError);
    await expect(second).rejects.toThrow(`process ${process.pid}`);

    await log.append(draft(sessionId));
    await log.close();
    await expect(fs.stat(lockFile(projectPath, sessionId))).rejects.toThrow();
    await expect(log.append(draft(sessionId))).rejects.toThrow(/closed/);

    const reopened = await EventLog.open(projectPath, sessionId);
    expect(reopened.lastSeq).toBe(1);
    await reopened.close();
    await reopened.close();
  });

  it("refuses a lock held by another live process", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const pid = livePid();
    await writeLock(lockFile(projectPath, sessionId), {
      pid,
      host: os.hostname(),
      startedAt: "2026-10-25T00:00:00.000Z",
      token: "other",
    });
    await expect(EventLog.open(projectPath, sessionId)).rejects.toThrow(`process ${pid}`);
  });

  it("takes over a lock left by a process that has exited", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const file = lockFile(projectPath, sessionId);
    await writeLock(file, {
      pid: await deadPid(),
      host: os.hostname(),
      startedAt: "2026-10-25T00:00:00.000Z",
      token: "gone",
    });
    const log = await EventLog.open(projectPath, sessionId);
    expect(JSON.parse(await fs.readFile(file, "utf8")).pid).toBe(process.pid);
    await log.close();
  });

  it("never takes over a lock from another host", async () => {
    const projectPath = await project();
    const sessionId = createId();
    await writeLock(lockFile(projectPath, sessionId), {
      pid: await deadPid(),
      host: `${os.hostname()}-elsewhere`,
      startedAt: "2026-10-25T00:00:00.000Z",
      token: "remote",
    });
    await expect(EventLog.open(projectPath, sessionId)).rejects.toBeInstanceOf(EventLogLockedError);
  });

  it("treats an unreadable lock as held while fresh and stale once old", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const file = lockFile(projectPath, sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "", "utf8");
    await expect(EventLog.open(projectPath, sessionId)).rejects.toBeInstanceOf(EventLogLockedError);

    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    const log = await EventLog.open(projectPath, sessionId);
    await log.close();
  });

  it("does not remove a lock that another writer has since taken", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const file = lockFile(projectPath, sessionId);
    const log = await EventLog.open(projectPath, sessionId);
    const foreign = { pid: livePid(), host: os.hostname(), startedAt: "x", token: "theirs" };
    await fs.writeFile(file, JSON.stringify(foreign), "utf8");
    await log.close();
    expect(JSON.parse(await fs.readFile(file, "utf8")).token).toBe("theirs");
  });

  it("releases the lock when a run finishes", async () => {
    const projectPath = await project();
    const userDir = await project();
    const saved = process.env.ASSENTOR_USER_DIR;
    process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
    try {
      await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
      await fs.writeFile(
        path.join(projectPath, ".assentor", "config.yaml"),
        "git:\n  checkpoints: false\nexecutor:\n  provider: mock\nreviewers:\n  - provider: mock\n",
        "utf8",
      );
      const { result } = await runAssentorTask({
        projectPath,
        prompt: "goal",
        skipPreflight: true,
        skipGates: true,
      });
      await expect(fs.stat(lockFile(projectPath, result.taskId))).rejects.toThrow();
      const log = await EventLog.open(projectPath, result.taskId);
      await log.close();
    } finally {
      if (saved === undefined) {
        delete process.env.ASSENTOR_USER_DIR;
      } else {
        process.env.ASSENTOR_USER_DIR = saved;
      }
    }
  });
});

describe("readSessionEvents", () => {
  it("reads while a writer is open, skips an in-progress line and never modifies the file", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId));
    await log.append(draft(sessionId));
    const file = sessionPaths(projectPath, sessionId).events;
    await fs.appendFile(file, '{"seq":3,"sessionId":"', "utf8");
    const before = await fs.readFile(file);

    expect((await readSessionEvents(projectPath, sessionId)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await readSessionEvents(projectPath, sessionId, 1)).map((e) => e.seq)).toEqual([2]);
    expect(await fs.readFile(file)).toEqual(before);
    await log.close();
  });

  it("returns nothing for a session without a log and rejects invalid ids", async () => {
    const projectPath = await project();
    expect(await readSessionEvents(projectPath, createId())).toEqual([]);
    await expect(readSessionEvents(projectPath, "../escape")).rejects.toThrow(/Invalid session id/);
  });
});

describe("EventLog lock takeover races and timeouts", () => {
  it("never lets two writers take over the same stale lock", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const file = lockFile(projectPath, sessionId);
    const stale = { pid: await deadPid(), host: os.hostname(), startedAt: "x", token: "dead" };
    await writeLock(file, stale);

    // Simulate the race: between our staleness check and the takeover, another
    // process takes over first and writes its own fresh lock.
    const winner = { pid: livePid(), host: os.hostname(), startedAt: "y", token: "winner" };
    const realRename = fs.rename.bind(fs);
    let raced = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!raced && String(from) === file) {
        raced = true;
        await fs.rm(file, { force: true });
        await fs.writeFile(file, JSON.stringify(winner), "utf8");
      }
      return realRename(from, to);
    });
    try {
      await expect(EventLog.open(projectPath, sessionId)).rejects.toBeInstanceOf(EventLogLockedError);
    } finally {
      spy.mockRestore();
    }
    // The winner's lock is back in place, and no stray files are left.
    expect(JSON.parse(await fs.readFile(file, "utf8")).token).toBe("winner");
    const names = await fs.readdir(path.dirname(file));
    expect(names.filter((name) => name.includes(".stale-"))).toEqual([]);
  });

  it("reclaims a stale lock that carries this process's pid but not its token", async () => {
    const projectPath = await project();
    const sessionId = createId();
    await writeLock(lockFile(projectPath, sessionId), {
      pid: process.pid,
      host: os.hostname(),
      startedAt: "earlier container",
      token: "not-ours",
    });
    const log = await EventLog.open(projectPath, sessionId);
    await log.close();
  });

  it("names the lock file in the error so a user can clear it", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const file = lockFile(projectPath, sessionId);
    await writeLock(file, { pid: 1, host: "other-host", startedAt: "x", token: "t" });
    await expect(EventLog.open(projectPath, sessionId)).rejects.toThrow(
      `If no Assentor run is active for it, delete ${file}.`,
    );
  });

  it("drops appends still queued after a timed-out close and tidies old aside files", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const dir = sessionPaths(projectPath, sessionId).root;
    await fs.mkdir(dir, { recursive: true });
    const leftover = path.join(dir, "writer.lock.stale-deadbeef");
    await fs.writeFile(leftover, "{}", "utf8");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(leftover, old, old);

    let release: () => void = () => undefined;
    let calls = 0;
    const slow = ((..._args: unknown[]) => {
      calls += 1;
      return calls === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    }) as unknown as typeof fs.appendFile;
    const log = await EventLog.open(projectPath, sessionId, { appendFile: slow });
    await expect(fs.stat(leftover)).rejects.toThrow();

    const first = log.append(draft(sessionId));
    const queued = log.append(draft(sessionId));
    await log.close({ timeoutMs: 20 });
    release();
    await first;
    await expect(queued).rejects.toThrow(/closed/);
    expect(calls).toBe(1);
  });

  it("releases the lock on close even when a write never finishes", async () => {
    const projectPath = await project();
    const sessionId = createId();
    const stuck = (() => new Promise<void>(() => undefined)) as unknown as typeof fs.appendFile;
    const log = await EventLog.open(projectPath, sessionId, { appendFile: stuck });
    void log.append(draft(sessionId));
    const started = Date.now();
    await log.close({ timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(fs.stat(lockFile(projectPath, sessionId))).rejects.toThrow();
  });
});
