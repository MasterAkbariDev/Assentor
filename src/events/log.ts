import { randomBytes } from "node:crypto";
import { promises as fs, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAssentorGitignored, sessionPaths } from "../persistence/paths.js";
import {
  parseEngineEvent,
  safeParseEngineEvent,
  type EngineEvent,
  type EngineEventDraft,
} from "../protocol/events.js";

/**
 * Append-only, per-session event log (task T00-05).
 *
 * Each event is one NDJSON line in `.assentor/sessions/<id>/events.ndjson`.
 * The log assigns `seq` (1, 2, 3, …) and `at`, validates every event, and
 * serializes writes so concurrent callers never interleave lines or reuse a
 * sequence number.
 *
 * Single writer per session (gate item 5): `open` takes
 * `.assentor/sessions/<id>/writer.lock` and `close` releases it. A second
 * writer — another process, or a second `open` in this one — gets
 * `EventLogLockedError`. A lock left by a process that is gone (same host,
 * pid not alive) is taken over. Readers use `readSessionEvents`, which never
 * locks and never modifies the file.
 */
export class EventLog {
  private readonly sessionId: string;
  private readonly file: string;
  private readonly appendFileFn: typeof fs.appendFile;
  private lastSeqValue = 0;
  /** Set when an append failed, so the next operation repairs the tail first. */
  private needsTailRepair = false;
  /** Serializes appends and reads on this instance. */
  private queue: Promise<unknown> = Promise.resolve();
  private lock?: HeldLock;
  private closed = false;
  /** Set once the lock is released; queued appends that have not started are dropped. */
  private released = false;

  private constructor(
    sessionId: string,
    file: string,
    appendFileFn: typeof fs.appendFile,
  ) {
    this.sessionId = sessionId;
    this.file = file;
    this.appendFileFn = appendFileFn;
  }

  /**
   * Open (or create) the log for a session and recover `lastSeq` from disk.
   *
   * An unterminated final line is repaired in place: kept (with a newline added)
   * when it is a valid event, otherwise truncated away as a crash remnant. A
   * newline-terminated line that is not a valid event is never removed; open
   * throws instead. Numbering continues after the last valid event.
   *
   * `options.appendFile` is a test hook; it defaults to `fs.appendFile`.
   */
  static async open(
    projectPath: string,
    sessionId: string,
    options: { appendFile?: typeof fs.appendFile } = {},
  ): Promise<EventLog> {
    const paths = sessionPaths(projectPath, sessionId);
    await fs.mkdir(paths.root, { recursive: true });
    await ensureAssentorGitignored(projectPath);

    const lock = await acquireWriterLock(sessionId, path.join(paths.root, WRITER_LOCK));
    await removeOldAsideFiles(paths.root);
    const log = new EventLog(
      sessionId,
      paths.events,
      options.appendFile ?? fs.appendFile,
    );
    log.lock = lock;
    try {
      await log.recover();
    } catch (error) {
      await releaseWriterLock(lock);
      throw error;
    }
    return log;
  }

  /**
   * Wait for queued writes (at most `timeoutMs` when given), then release the
   * writer lock. The lock is released even when writes are stuck. Safe to
   * call twice.
   */
  async close(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await waitAtMost(this.queue, options.timeoutMs);
    // After a timeout, appends still queued must not land once another writer
    // may own the session. (A write already inside appendFile can't be stopped.)
    this.released = true;
    if (this.lock) {
      await releaseWriterLock(this.lock);
      this.lock = undefined;
    }
  }

  /** Sequence number of the last event written or recovered; 0 when empty. */
  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /**
   * Assign `seq` and `at` (when the draft has none), validate, and append one
   * line. Resolves with the complete event. Rejects when the draft's
   * `sessionId` is not this log's session. If the write fails, `lastSeq` is
   * unchanged and the next operation repairs the tail before proceeding.
   */
  append(draft: EngineEventDraft): Promise<EngineEvent> {
    if (this.closed) {
      return Promise.reject(new Error(`Event log for ${this.sessionId} is closed`));
    }
    return this.enqueue(async () => {
      if (this.released) {
        throw new Error(`Event log for ${this.sessionId} is closed`);
      }
      if (draft.sessionId !== this.sessionId) {
        throw new Error(
          `Event sessionId ${draft.sessionId} does not match log ${this.sessionId}`,
        );
      }
      if (this.needsTailRepair) {
        await this.recover();
      }
      const event = parseEngineEvent({
        ...draft,
        seq: this.lastSeqValue + 1,
        at: draft.at ?? new Date().toISOString(),
      });
      try {
        await this.appendFileFn(this.file, `${JSON.stringify(event)}\n`, "utf8");
      } catch (error) {
        this.needsTailRepair = true;
        throw error;
      }
      this.lastSeqValue = event.seq;
      return event;
    });
  }

  /** Events with `seq > fromSeq`, in log order. */
  readFrom(fromSeq: number): Promise<EngineEvent[]> {
    return this.enqueue(async () => {
      if (this.needsTailRepair) {
        await this.recover();
      }
      const events = await readLog(this.file);
      return events.filter((event) => event.seq > fromSeq);
    });
  }

  /** Repair the tail, validate the whole file, and set `lastSeq` from it. */
  private async recover(): Promise<void> {
    await repairTail(this.file, this.appendFileFn);
    const events = await readLog(this.file);
    this.lastSeqValue = events.at(-1)?.seq ?? 0;
    this.needsTailRepair = false;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Read-only access
// ---------------------------------------------------------------------------

/**
 * Events with `seq > fromSeq` for a session, without locking or touching the
 * file — safe while a run is writing it. An unterminated final line is an
 * append in progress and is skipped; a missing log is an empty list. Throws
 * on an invalid complete line, like the writer.
 */
export async function readSessionEvents(
  projectPath: string,
  sessionId: string,
  fromSeq = 0,
): Promise<EngineEvent[]> {
  const file = sessionPaths(projectPath, sessionId).events;
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  return parseLog(complete, file).filter((event) => event.seq > fromSeq);
}

// ---------------------------------------------------------------------------
// Writer lock
// ---------------------------------------------------------------------------

const WRITER_LOCK = "writer.lock";
/** A lock file younger than this with no readable owner may still be being written. */
const FRESH_LOCK_MS = 5_000;

export class EventLogLockedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly owner: LockOwner | undefined,
    readonly lockFile: string,
  ) {
    super(
      `${
        owner
          ? `Session ${sessionId} is already being written by process ${owner.pid} on ${owner.host} (since ${owner.startedAt})`
          : `Session ${sessionId} is already being written by another process`
      }. If no Assentor run is active for it, delete ${lockFile}.`,
    );
    this.name = "EventLogLockedError";
  }
}

interface LockOwner {
  pid: number;
  host: string;
  startedAt: string;
  token: string;
}

interface HeldLock {
  file: string;
  token: string;
}

/** Locks this process holds, released synchronously if it exits without close(). */
const heldLocks = new Map<string, HeldLock>();
/** Tokens this process holds or is about to write, so its own live locks are never judged stale. */
const ownTokens = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const lock of heldLocks.values()) {
      try {
        if (readOwnerSync(lock.file)?.token === lock.token) {
          unlinkSync(lock.file);
        }
      } catch {
        // Best effort: a stale lock is taken over by the next writer.
      }
    }
  });
}

async function acquireWriterLock(sessionId: string, file: string): Promise<HeldLock> {
  const owner: LockOwner = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    token: randomBytes(16).toString("hex"),
  };
  ownTokens.add(owner.token);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.writeFile(file, `${JSON.stringify(owner)}\n`, { flag: "wx" });
        const lock = { file, token: owner.token };
        heldLocks.set(file, lock);
        installExitHook();
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      const current = await readOwner(file);
      if (!(await isStaleLock(file, current))) {
        throw new EventLogLockedError(sessionId, current, file);
      }
      if (!(await takeOverStaleLock(file, current))) {
        throw new EventLogLockedError(sessionId, await readOwner(file), file);
      }
    }
    throw new EventLogLockedError(sessionId, await readOwner(file), file);
  } catch (error) {
    ownTokens.delete(owner.token);
    throw error;
  }
}

/**
 * Remove a lock judged stale, atomically: move it aside, then check that what
 * was moved is the lock that was judged stale. If another process replaced it
 * in between, put its lock back and report failure, so two writers can't both
 * take over. Returns true when the stale lock is gone.
 *
 * Remaining window (accepted): while a live lock is moved aside, a third opener
 * could create a fresh lock before it is restored, or its owner could close
 * and miss it. That needs three writers within milliseconds of a stale lock.
 */
async function takeOverStaleLock(file: string, stale: LockOwner | undefined): Promise<boolean> {
  const aside = `${file}.stale-${randomBytes(8).toString("hex")}`;
  try {
    await fs.rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true; // Someone else removed it; try to create ours.
    }
    throw error;
  }
  const raw = await fs.readFile(aside, "utf8").catch(() => "");
  const moved = parseOwner(raw);
  const sameLock = stale ? moved?.token === stale.token : !moved && (await isOldFile(aside));
  if (sameLock) {
    await fs.rm(aside, { force: true });
    return true;
  }
  // We moved a live lock that replaced the stale one: restore it unless a newer
  // one exists. A hard link keeps the same file, so bytes its owner is still
  // writing land in the restored lock; copying is the fallback where links fail.
  try {
    await fs.link(aside, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      await fs.writeFile(file, raw, { flag: "wx" }).catch((copyError: NodeJS.ErrnoException) => {
        if (copyError.code !== "EEXIST") {
          throw copyError;
        }
      });
    }
  } finally {
    await fs.rm(aside, { force: true });
  }
  return false;
}

/** Delete `writer.lock.stale-*` files a crashed takeover left behind (best effort). */
async function removeOldAsideFiles(dir: string): Promise<void> {
  try {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      if (name.startsWith(`${WRITER_LOCK}.stale-`) && (await isOldFile(file))) {
        await fs.rm(file, { force: true });
      }
    }
  } catch {
    // Tidying only; never block opening the log.
  }
}

async function isOldFile(file: string): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs > FRESH_LOCK_MS;
  } catch {
    return true;
  }
}

async function releaseWriterLock(lock: HeldLock): Promise<void> {
  heldLocks.delete(lock.file);
  try {
    if ((await readOwner(lock.file))?.token === lock.token) {
      await fs.rm(lock.file, { force: true });
    }
  } finally {
    ownTokens.delete(lock.token);
  }
}

async function isStaleLock(file: string, owner: LockOwner | undefined): Promise<boolean> {
  if (!owner) {
    // Unreadable owner: a writer may be mid-write, so only an old file is stale.
    return isOldFile(file);
  }
  if (owner.host !== os.hostname()) {
    return false; // Can't check a pid on another machine.
  }
  if (owner.pid === process.pid) {
    // Ours (held or being written) means a second writer in this process: not stale.
    // Our pid with a token we never issued is an earlier process (pid reuse,
    // containers that always run as pid 1): stale.
    return !ownTokens.has(owner.token);
  }
  return !isProcessAlive(owner.pid);
}

/** Resolve when `work` settles, or after `ms` (no limit when undefined). Never rejects. */
async function waitAtMost(work: Promise<unknown>, ms: number | undefined): Promise<void> {
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  if (ms === undefined) {
    await settled;
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    return typeof value.pid === "number" &&
      typeof value.host === "string" &&
      typeof value.token === "string" &&
      typeof value.startedAt === "string"
      ? (value as LockOwner)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readOwner(file: string): Promise<LockOwner | undefined> {
  try {
    return parseOwner(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readOwnerSync(file: string): LockOwner | undefined {
  try {
    return parseOwner(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Fix an unterminated final line in place. Works on bytes so truncation offsets
 * are correct for multibyte UTF-8 text.
 */
async function repairTail(
  file: string,
  appendFileFn: typeof fs.appendFile,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const tailStart = bytes.lastIndexOf(0x0a) + 1;
  if (tailStart === bytes.length) {
    return;
  }
  const tail = bytes.subarray(tailStart).toString("utf8");
  if (parseLine(tail)) {
    await appendFileFn(file, "\n", "utf8");
  } else {
    await fs.truncate(file, tailStart);
  }
}

/** Read and validate every event. Throws on any invalid non-blank line. */
async function readLog(file: string): Promise<EngineEvent[]> {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return parseLog(raw, file);
}

function parseLog(raw: string, file: string): EngineEvent[] {
  const events: EngineEvent[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      continue;
    }
    const event = parseLine(line);
    if (!event) {
      throw new Error(
        `Corrupt event log ${file}: line ${index + 1} is not a valid event`,
      );
    }
    events.push(event);
  }
  return events;
}

function parseLine(line: string): EngineEvent | undefined {
  try {
    const result = safeParseEngineEvent(JSON.parse(line.trimEnd()));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
