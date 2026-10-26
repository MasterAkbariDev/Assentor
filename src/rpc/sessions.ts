import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isId } from "../core/ids.js";
import { assentorRoot, listTaskIds, sessionPaths, taskPaths } from "../persistence/paths.js";
import { TaskSnapshotSchema } from "../persistence/store.js";
import { safeParseEngineEvent, type EngineEvent } from "../protocol/events.js";
import {
  RPC_NOTIFICATIONS,
  RpcErrorCode,
  type EventNotificationParams,
  type ResyncRequiredParams,
  type SessionSummary,
} from "../protocol/rpc.js";
import { RpcError, type RpcConnection } from "./server.js";

/**
 * Read-only session handlers (task T04-02p): `sessions.list` and
 * `events.subscribe`. They read `.assentor/tasks/<id>/state.json` and
 * `.assentor/sessions/<id>/events.ndjson` and never write, lock or repair
 * either (the run's `EventLog` owns the log; see gate item 5 in STATUS.md).
 */

// ---------------------------------------------------------------------------
// sessions.list
// ---------------------------------------------------------------------------

/** Every task or session in the project, most recently updated first. */
export async function listSessions(projectPath: string): Promise<SessionSummary[]> {
  const ids = new Set(await listTaskIds(projectPath));
  for (const id of await listSessionDirs(projectPath)) {
    ids.add(id);
  }

  const summaries: SessionSummary[] = [];
  for (const id of ids) {
    if (!isId(id)) {
      continue;
    }
    const snapshot = await readSnapshot(projectPath, id);
    const log = sessionPaths(projectPath, id).events;
    const logStat = await statFile(log);
    const hasLiveLog = logStat !== undefined;
    const lastSeq = hasLiveLog ? await lastSeqOf(log) : 0;
    const title =
      snapshot?.contract.goal ?? (hasLiveLog ? await createdTitleOf(log) : undefined) ?? id;
    // A session with only a log sorts by the log's last write.
    const updatedAt = snapshot?.updatedAt ?? logStat?.mtime.toISOString();
    summaries.push({
      id,
      title,
      ...(snapshot ? { status: snapshot.status, startedAt: snapshot.startedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      hasLiveLog,
      lastSeq,
    });
  }
  return summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

async function listSessionDirs(projectPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(assentorRoot(projectPath), "sessions"), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readSnapshot(projectPath: string, id: string) {
  try {
    const raw = JSON.parse(await fs.readFile(taskPaths(projectPath, id).stateFile, "utf8"));
    const parsed = TaskSnapshotSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function statFile(file: string) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `seq` of the last complete event, read from the file's tail. The window
 * grows (64 KiB → 8 MiB) when the last line is longer than it.
 */
async function lastSeqOf(file: string): Promise<number> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    for (let tail = 64 * 1024; ; tail *= 4) {
      const start = Math.max(0, size - tail);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      lines.pop(); // the part after the last newline is incomplete (or empty)
      // Without a newline before the window, its first line may be cut.
      const firstWhole = start === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= firstWhole; i -= 1) {
        const event = parseEventLine(lines[i]!);
        if (event) {
          return event.seq;
        }
      }
      if (start === 0 || tail >= 8 * 1024 * 1024) {
        return 0;
      }
    }
  } finally {
    await handle.close();
  }
}

/** Title from the first event when it is `session.created`. */
async function createdTitleOf(file: string): Promise<string | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    const event = parseEventLine(first);
    return event?.type === "session.created" ? event.data.title : undefined;
  } finally {
    await handle.close();
  }
}

function parseEventLine(line: string): EngineEvent | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const result = safeParseEngineEvent(JSON.parse(line));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// events.subscribe
// ---------------------------------------------------------------------------

export interface SubscriptionOptions {
  /** How often to check the log for new lines. Default 200 ms. */
  pollMs?: number;
  /** Bytes read per step. Memory per subscriber stays around this size. Default 64 KiB. */
  chunkBytes?: number;
  /**
   * A single line longer than this stops the subscription with `unreadable_log`,
   * which is terminal (resubscribing would hit the same line). Default 8 MiB.
   */
  maxLineBytes?: number;
}

const MAX_SUBSCRIPTIONS_PER_CONNECTION = 16;
const subscriptionsByConnection = new WeakMap<RpcConnection, Map<string, SessionTail>>();

/**
 * Stream a session's events (`seq > fromSeq`) to the connection, then keep
 * tailing the log. Returns the subscription id at once; events follow as
 * `events.event` notifications.
 */
export function subscribeToSession(
  connection: RpcConnection,
  projectPath: string,
  sessionId: string,
  fromSeq: number,
  options: SubscriptionOptions = {},
): string {
  if (!isId(sessionId)) {
    throw new RpcError(RpcErrorCode.InvalidParams, `Invalid session id: ${sessionId}`);
  }
  let subs = subscriptionsByConnection.get(connection);
  if (!subs) {
    subs = new Map();
    subscriptionsByConnection.set(connection, subs);
    const owned = subs;
    connection.onClose(() => {
      for (const tail of owned.values()) {
        tail.stop();
      }
      owned.clear();
    });
  }
  if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
    throw new RpcError(
      RpcErrorCode.SubscriptionLimit,
      `At most ${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions per connection`,
    );
  }
  const subscriptionId = randomBytes(8).toString("hex");
  const owned = subs;
  const tail = new SessionTail({
    connection,
    file: sessionPaths(projectPath, sessionId).events,
    sessionId,
    subscriptionId,
    fromSeq,
    options,
    onStop: () => owned.delete(subscriptionId),
  });
  subs.set(subscriptionId, tail);
  tail.start();
  return subscriptionId;
}

/** Stop a subscription on this connection. Returns false when it is unknown. */
export function unsubscribeFromSession(connection: RpcConnection, subscriptionId: string): boolean {
  const tail = subscriptionsByConnection.get(connection)?.get(subscriptionId);
  if (!tail) {
    return false;
  }
  tail.stop();
  return true;
}

/**
 * One subscription. A single loop reads the log from a byte offset in bounded
 * chunks, sends every complete event, and only reads again once those are
 * sent — so a slow client never makes the server buffer more than one chunk;
 * it just falls behind on a file that already holds everything.
 *
 * The offset only ever moves past complete lines. An unterminated last line
 * (a write in progress, or a crash remnant the next writer repairs) is re-read
 * next time, so a repair can't misalign the reader.
 */
class SessionTail {
  private offset = 0;
  private inode?: number;
  private lastSeq: number;
  private stopped = false;
  private busyCount = 0;
  private resynced = false;
  private timer?: NodeJS.Timeout;
  private wake?: () => void;
  private readonly pollMs: number;
  private readonly chunkBytes: number;
  private readonly maxLineBytes: number;

  constructor(
    private readonly input: {
      connection: RpcConnection;
      file: string;
      sessionId: string;
      subscriptionId: string;
      fromSeq: number;
      options: SubscriptionOptions;
      onStop: () => void;
    },
  ) {
    this.lastSeq = input.fromSeq;
    this.pollMs = input.options.pollMs ?? 200;
    this.chunkBytes = input.options.chunkBytes ?? 64 * 1024;
    this.maxLineBytes = input.options.maxLineBytes ?? 8 * 1024 * 1024;
  }

  start(): void {
    // An unexpected read error must not end the subscription silently.
    void this.run().catch(() => {
      if (!this.stopped) {
        void this.resync("io_error").catch(() => this.stop());
      }
    });
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.wake?.();
    this.input.onStop();
  }

  private async run(): Promise<void> {
    let want = this.chunkBytes;
    while (!this.stopped) {
      const step = await this.readStep(want);
      if (this.stopped) {
        return;
      }
      if (step.kind === "replaced" || step.kind === "unreadable") {
        await this.resync(step.kind === "replaced" ? "log_replaced" : "io_error");
        return;
      }
      if (step.kind === "busy") {
        if (++this.busyCount > 3) {
          await this.resync("io_error");
          return;
        }
        await this.sleep();
        continue;
      }
      this.busyCount = 0;
      if (step.kind === "progress") {
        want = this.chunkBytes; // skipped already-delivered lines: read on at once
        continue;
      }
      if (step.kind === "events") {
        want = this.chunkBytes;
        for (const event of step.events) {
          if (this.stopped) {
            return;
          }
          const params: EventNotificationParams = {
            subscriptionId: this.input.subscriptionId,
            event,
          };
          await this.input.connection.notify(RPC_NOTIFICATIONS.event, params);
          this.lastSeq = event.seq;
        }
        continue;
      }
      if (step.kind === "long_line") {
        if (want >= this.maxLineBytes) {
          await this.resync("unreadable_log");
          return;
        }
        want = Math.min(want * 2, this.maxLineBytes);
        continue;
      }
      await this.sleep(); // "idle": nothing new yet
    }
  }

  private async readStep(
    want: number,
  ): Promise<
    | { kind: "events"; events: EngineEvent[] }
    | { kind: "progress" }
    | { kind: "busy" }
    | { kind: "idle" }
    | { kind: "long_line" }
    | { kind: "replaced" }
    | { kind: "unreadable" }
  > {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.input.file, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // No log yet (or not anymore): wait; if it existed, it was replaced.
        return this.offset > 0 ? { kind: "replaced" } : { kind: "idle" };
      }
      // Windows reports a file being replaced or scanned as EPERM/EBUSY for a moment.
      if (code === "EPERM" || code === "EBUSY") {
        return { kind: "busy" };
      }
      return { kind: "unreadable" };
    }
    try {
      const stat = await handle.stat();
      if (this.inode !== undefined && stat.ino !== this.inode) {
        return { kind: "replaced" };
      }
      this.inode = stat.ino;
      if (stat.size < this.offset) {
        return { kind: "replaced" };
      }
      const available = stat.size - this.offset;
      if (available === 0) {
        return { kind: "idle" };
      }
      const length = Math.min(available, want);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end < 0) {
        // No complete line in this window: a longer line, or a write in progress.
        return bytesRead === want ? { kind: "long_line" } : { kind: "idle" };
      }
      const text = buffer.subarray(0, end).toString("utf8");
      this.offset += end + 1;
      const events: EngineEvent[] = [];
      for (const line of text.split("\n")) {
        const event = parseEventLine(line);
        // Skip invalid lines and anything already delivered (fromSeq, overlap).
        if (event && event.seq > this.lastSeqQueued(events)) {
          events.push(event);
        }
      }
      return events.length > 0 ? { kind: "events", events } : { kind: "progress" };
    } finally {
      await handle.close();
    }
  }

  private lastSeqQueued(queued: EngineEvent[]): number {
    return queued.at(-1)?.seq ?? this.lastSeq;
  }

  private async resync(reason: ResyncRequiredParams["reason"]): Promise<void> {
    if (this.resynced) {
      return;
    }
    this.resynced = true;
    const params: ResyncRequiredParams = {
      subscriptionId: this.input.subscriptionId,
      sessionId: this.input.sessionId,
      lastSeq: this.lastSeq,
      reason,
    };
    this.stop();
    await this.input.connection.notify(RPC_NOTIFICATIONS.resyncRequired, params);
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, this.pollMs);
      this.timer.unref?.();
    });
  }
}
