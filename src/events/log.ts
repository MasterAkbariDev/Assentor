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
 */
export class EventLog {
  private readonly sessionId: string;
  private readonly file: string;
  private lastSeqValue: number;
  /** Serializes appends and reads on this instance. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(sessionId: string, file: string, lastSeq: number) {
    this.sessionId = sessionId;
    this.file = file;
    this.lastSeqValue = lastSeq;
  }

  /**
   * Open (or create) the log for a session and recover `lastSeq` from disk.
   *
   * A truncated or corrupt final line, e.g. from a crash mid-write, is dropped
   * and the file is rewritten without it, so the next append starts on a fresh
   * line. Numbering continues after the last valid event.
   */
  static async open(projectPath: string, sessionId: string): Promise<EventLog> {
    const paths = sessionPaths(projectPath, sessionId);
    await fs.mkdir(paths.root, { recursive: true });
    await ensureAssentorGitignored(projectPath);

    const state = await readLog(paths.events);
    if (state.droppedTail || state.unterminated) {
      await rewriteLines(paths.events, state.validLines);
    }
    return new EventLog(sessionId, paths.events, state.events.at(-1)?.seq ?? 0);
  }

  /** Sequence number of the last event written or recovered; 0 when empty. */
  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /**
   * Assign `seq` and `at` (when the draft has none), validate, and append one
   * line. Resolves with the complete event. Rejects when the draft's
   * `sessionId` is not this log's session.
   */
  append(draft: EngineEventDraft): Promise<EngineEvent> {
    return this.enqueue(async () => {
      if (draft.sessionId !== this.sessionId) {
        throw new Error(
          `Event sessionId ${draft.sessionId} does not match log ${this.sessionId}`,
        );
      }
      const event = parseEngineEvent({
        ...draft,
        seq: this.lastSeqValue + 1,
        at: draft.at ?? new Date().toISOString(),
      });
      await fs.appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8");
      this.lastSeqValue = event.seq;
      return event;
    });
  }

  /** Events with `seq > fromSeq`, in log order. */
  readFrom(fromSeq: number): Promise<EngineEvent[]> {
    return this.enqueue(async () => {
      const state = await readLog(this.file);
      return state.events.filter((event) => event.seq > fromSeq);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

interface LogState {
  /** Valid events in file order. */
  events: EngineEvent[];
  /** Raw text of each valid event line, in file order. */
  validLines: string[];
  /** The final non-empty line was invalid and has been left out. */
  droppedTail: boolean;
  /** The file does not end with `\n`. */
  unterminated: boolean;
}

async function readLog(file: string): Promise<LogState> {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const events: EngineEvent[] = [];
  const validLines: string[] = [];
  let droppedTail = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const event = parseLine(line);
    if (event) {
      events.push(event);
      validLines.push(line);
      continue;
    }
    if (index === lines.length - 1) {
      droppedTail = true;
      break;
    }
    throw new Error(
      `Corrupt event log ${file}: line ${index + 1} is not a valid event`,
    );
  }

  return {
    events,
    validLines,
    droppedTail,
    unterminated: raw.length > 0 && !raw.endsWith("\n"),
  };
}

function parseLine(line: string): EngineEvent | undefined {
  try {
    const result = safeParseEngineEvent(JSON.parse(line));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function rewriteLines(file: string, lines: string[]): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, lines.map((line) => `${line}\n`).join(""), "utf8");
  await fs.rename(tmp, file);
}
