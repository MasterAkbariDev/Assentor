import { promises as fs } from "node:fs";
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
 * Single writer per session: one EventLog instance in one process. Multiple
 * writers can produce duplicate seq numbers; there is no file lock.
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

    const log = new EventLog(
      sessionId,
      paths.events,
      options.appendFile ?? fs.appendFile,
    );
    await log.recover();
    return log;
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
    return this.enqueue(async () => {
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
