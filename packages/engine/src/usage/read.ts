import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { safeParseEngineEvent } from "#assentor/protocol/events.js";
import type { UsageReport } from "#assentor/protocol/rpc.js";
import { sessionPaths } from "../persistence/paths.js";
import { UsageLedger } from "./ledger.js";

/** Lines read before `readSessionUsage` stops (and marks the report `truncated`). */
export const MAX_USAGE_LINES = 1_000_000;

/**
 * The usage ledger of a session's event log (TE-01), streamed line by line.
 * Unlike `readSessionEvents` it tolerates damage: an unreadable line is skipped
 * and counted (`skippedLines`), and reading stops after `maxLines`. A missing
 * log is an all-zero report. Read-only: never locks or repairs the log.
 */
export async function readSessionUsage(projectPath: string, sessionId: string, maxLines = MAX_USAGE_LINES): Promise<UsageReport> {
  const ledger = new UsageLedger(sessionId);
  let skipped = 0;
  let lines = 0;
  let truncated = false;
  const stream = createReadStream(sessionPaths(projectPath, sessionId).events, { encoding: "utf8" });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (++lines > maxLines) {
        truncated = true;
        break;
      }
      if (!line.trim()) continue;
      let parsed: ReturnType<typeof safeParseEngineEvent> | undefined;
      try {
        parsed = safeParseEngineEvent(JSON.parse(line));
      } catch {
        parsed = undefined;
      }
      if (parsed?.success) ledger.add(parsed.data);
      else skipped += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    stream.destroy();
  }
  return { ...ledger.snapshot(), ...(skipped ? { skippedLines: skipped } : {}), ...(truncated ? { truncated } : {}) };
}
