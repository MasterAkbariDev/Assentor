import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireRunLock,
  createId,
  isSessionRunLocked,
  readSessionEvents,
  RunLockedError,
  sessionPaths,
} from "../../packages/engine/src/index.js";
import { resumeAssentorTask, runAssentorTask } from "../../packages/cli/src/cli/commands.js";
import { deleteProjectTask } from "../../packages/engine/src/services/app.js";

// FU-15: one task-level run lock per task/session, held for a whole run or resume.

let projectPath: string;
let userDir: string;
const savedUserDir = process.env.ASSENTOR_USER_DIR;

beforeEach(async () => {
  projectPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "run-lock-")));
  userDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-lock-user-"));
  process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
  await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
  await fs.writeFile(
    path.join(projectPath, ".assentor", "config.yaml"),
    "git:\n  checkpoints: false\nexecutor:\n  provider: mock\nreviewers:\n  - provider: mock\n",
    "utf8",
  );
});

afterEach(async () => {
  if (savedUserDir === undefined) delete process.env.ASSENTOR_USER_DIR;
  else process.env.ASSENTOR_USER_DIR = savedUserDir;
  await fs.rm(projectPath, { recursive: true, force: true });
  await fs.rm(userDir, { recursive: true, force: true });
});

const lockFile = (id: string) => path.join(sessionPaths(projectPath, id).root, "run.lock");
const writeOwner = async (id: string, pid: number, startedAt = new Date().toISOString()) => {
  await fs.mkdir(path.dirname(lockFile(id)), { recursive: true });
  await fs.writeFile(lockFile(id), `${JSON.stringify({ pid, host: os.hostname(), startedAt, token: "other" })}\n`);
};

describe("acquireRunLock", () => {
  it("refuses a second holder with an error naming it, and is free again after release", async () => {
    const id = createId();
    const first = await acquireRunLock(projectPath, id);
    const error = await acquireRunLock(projectPath, id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunLockedError);
    expect(String((error as Error).message)).toContain(`already running in process ${process.pid} on ${os.hostname()}`);
    expect(await isSessionRunLocked(projectPath, id)).toBe(true);
    await first.release();
    await first.release(); // twice is fine
    expect(await isSessionRunLocked(projectPath, id)).toBe(false);
    await (await acquireRunLock(projectPath, id)).release();
  });

  it("a live process on this host holds it; a dead pid's lock is taken over", async () => {
    const id = createId();
    await writeOwner(id, process.ppid); // alive, not us
    await expect(acquireRunLock(projectPath, id)).rejects.toThrow(`process ${process.ppid}`);
    await writeOwner(id, 2 ** 22 - 1); // no such pid
    expect(await isSessionRunLocked(projectPath, id)).toBe(false);
    const lock = await acquireRunLock(projectPath, id);
    expect(JSON.parse(await fs.readFile(lockFile(id), "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it.skipIf(process.platform === "win32")("a live pid that started after the lock was taken is a reused pid: stale", async () => {
    const id = createId();
    await writeOwner(id, process.ppid, "2000-01-01T00:00:00.000Z");
    expect(await isSessionRunLocked(projectPath, id)).toBe(false);
    await (await acquireRunLock(projectPath, id)).release();
  });

  it("the error says which file to delete and when that is safe", async () => {
    const id = createId();
    await writeOwner(id, process.ppid);
    await expect(acquireRunLock(projectPath, id)).rejects.toThrow(
      `It is safe to delete ${lockFile(id)} only when process ${process.ppid} on ${os.hostname()} is no longer running an Assentor run or resume of this task`,
    );
  });

  it("an unreadable lock is held during the grace period, then taken over", async () => {
    const id = createId();
    await fs.mkdir(path.dirname(lockFile(id)), { recursive: true });
    await fs.writeFile(lockFile(id), "{\"pid\":"); // an owner still being written
    await expect(acquireRunLock(projectPath, id)).rejects.toThrow(/already running in another process/);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockFile(id), old, old);
    await (await acquireRunLock(projectPath, id)).release();
  });
});

describe("solo run and resume", { timeout: 60_000 }, () => {
  const run = () => runAssentorTask({ projectPath, prompt: "goal", skipPreflight: true, skipGates: true });

  /** Make a finished task resumable again, as if it had failed. */
  async function markFailed(taskId: string): Promise<void> {
    const file = path.join(projectPath, ".assentor", "tasks", taskId, "state.json");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...state, status: "FAILED" }), "utf8");
  }

  it("a run releases its lock; a resume is refused while another holds it and touches nothing", async () => {
    const { result } = await run();
    expect(await isSessionRunLocked(projectPath, result.taskId)).toBe(false);
    await markFailed(result.taskId);
    const stateFile = path.join(projectPath, ".assentor", "tasks", result.taskId, "state.json");
    const stateBefore = await fs.readFile(stateFile, "utf8");
    const eventsBefore = await readSessionEvents(projectPath, result.taskId);

    await writeOwner(result.taskId, process.ppid);
    await expect(resumeAssentorTask({ projectPath, taskId: result.taskId })).rejects.toThrow(
      `Task ${result.taskId} is already running in process ${process.ppid}`,
    );
    // The latest-task form takes the same lock.
    await expect(resumeAssentorTask({ projectPath })).rejects.toThrow(RunLockedError);
    expect(await fs.readFile(stateFile, "utf8")).toBe(stateBefore);
    expect(await readSessionEvents(projectPath, result.taskId)).toEqual(eventsBefore);

    // The holder is gone (dead pid): the next resume takes over and releases at the end.
    await writeOwner(result.taskId, 2 ** 22 - 1);
    await resumeAssentorTask({ projectPath, taskId: result.taskId });
    expect(await isSessionRunLocked(projectPath, result.taskId)).toBe(false);
    await expect(fs.stat(lockFile(result.taskId))).rejects.toThrow();
  });

  it("delete (TUI) is refused while a run holds the task, then removes it and leaves no lock behind", async () => {
    const { result } = await run();
    const taskDir = path.join(projectPath, ".assentor", "tasks", result.taskId);
    await writeOwner(result.taskId, process.ppid);
    await expect(deleteProjectTask(projectPath, result.taskId)).rejects.toThrow(
      `Task ${result.taskId} is already running in process ${process.ppid} on ${os.hostname()}`,
    );
    await expect(fs.stat(taskDir)).resolves.toBeDefined();
    await fs.rm(lockFile(result.taskId));
    await deleteProjectTask(projectPath, result.taskId);
    await expect(fs.stat(taskDir)).rejects.toThrow();
    await expect(fs.stat(lockFile(result.taskId))).rejects.toThrow();

    // A task without a session dir does not get an empty one from the lock.
    const bare = createId();
    await fs.mkdir(path.join(projectPath, ".assentor", "tasks", bare), { recursive: true });
    await deleteProjectTask(projectPath, bare);
    await expect(fs.stat(sessionPaths(projectPath, bare).root)).rejects.toThrow();
  });
});
