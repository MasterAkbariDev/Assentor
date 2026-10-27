import { extractJsonCandidate } from "../../protocol/parse.js";
import {
  AGENT_REPORT_STATUSES,
  AgentReportSchema,
  type AgentReport,
} from "./types.js";

/**
 * Agent report parsing and claim checks (task T02B-03).
 *
 * An agent ends its Lead-mode turn with a JSON report (`AgentReportSchema`).
 * `parseAgentReport` finds it in the agent's text, `repairPrompt` asks for it
 * again when it is malformed, and `verifyReportClaims` checks the report's
 * claims against the diff and the gate runs. Claims are verified, never trusted.
 *
 * Only the last `MAX_REPORT_SCAN_BYTES` of the text are scanned: the report
 * comes at the end, and model output can be very large.
 */

/** Scan limit: the last 64 KB (UTF-8 bytes) of the agent's text. */
export const MAX_REPORT_SCAN_BYTES = 64 * 1024;

export type ParseAgentReportResult =
  | { ok: true; report: AgentReport }
  | { ok: false; error: string; needsRepair: boolean };

/**
 * The report in `text`, for task `taskId`.
 *
 * - The last fenced ```json (or bare ```) block that holds the report is used;
 *   with no fenced block, the bare JSON is read with `extractJsonCandidate`.
 * - A missing `taskId` is filled from `taskId`. A different one (compared
 *   case-insensitively) is refused without asking for a repair.
 * - A schema failure, or no JSON at all, asks for a repair.
 */
export function parseAgentReport(text: string, taskId: string): ParseAgentReportResult {
  const tail = tailBytes(text, MAX_REPORT_SCAN_BYTES);
  const found = findReportJson(tail.text, tail.truncated);
  if (!found.ok) {
    return { ok: false, error: found.error, needsRepair: true };
  }
  const data = found.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "report must be a JSON object", needsRepair: true };
  }

  const reported = (data as Record<string, unknown>).taskId;
  if (reported !== undefined && (typeof reported !== "string" || !sameTask(reported, taskId))) {
    return {
      ok: false,
      error: `report is for task ${String(reported)}, expected ${taskId}`,
      needsRepair: false,
    };
  }

  const parsed = AgentReportSchema.safeParse({ ...(data as object), taskId });
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(report)";
      return `${where}: ${issue.message}`;
    });
    return {
      ok: false,
      error: `report does not match the schema: ${paths.join("; ")}`,
      needsRepair: true,
    };
  }
  return { ok: true, report: parsed.data };
}

/** Longest error text placed in a repair prompt. */
const MAX_REPAIR_ERROR_CHARS = 500;

/**
 * Asks the agent to resend only the JSON report. Includes the error (cut to
 * ${MAX_REPAIR_ERROR_CHARS} characters), the allowed `status` values and a
 * minimal valid example. Under 1,200 characters at the longest error.
 */
export function repairPrompt(error: string): string {
  const shown =
    error.length > MAX_REPAIR_ERROR_CHARS ? `${error.slice(0, MAX_REPAIR_ERROR_CHARS)}…` : error;
  return [
    "Your last reply did not contain a valid task report.",
    `Error: ${shown}`,
    "Reply again with ONLY the JSON report in one ```json block, and no other text.",
    `Allowed "status" values: ${AGENT_REPORT_STATUSES.join(", ")}.`,
    "Minimal valid example:",
    "```json",
    '{"taskId":"T1","status":"done","summary":"What you changed and why."}',
    "```",
  ].join("\n");
}

/** A claim in a report that the evidence does not back up. */
export interface ClaimCheck {
  kind: "file_not_in_diff" | "diff_file_not_reported" | "test_claim_unverified" | "test_claim_contradicted";
  detail: string;
}

export interface ClaimEvidence {
  /** Files the diff changes. */
  diffFiles: string[];
  /** Gate runs. Without them, every `testsRun` claim is unverified. */
  gateRuns?: Array<{ command: string; passed: boolean }>;
}

export interface VerifyClaimsOptions {
  /**
   * Compare file paths case-insensitively. Default false, which suits Linux;
   * pass true on macOS or Windows, whose file systems ignore case.
   */
  ignoreCase?: boolean;
}

/**
 * Checks a report's claims. An empty array means every claim checks out.
 *
 * - `filesChanged` must match the diff, and every diff file must be reported.
 * - A `testsRun` entry is `test_claim_contradicted` when a gate run has the same
 *   trimmed command and the opposite result, and `test_claim_unverified` when no
 *   gate run has that command.
 * - Paths are normalised first: `\` becomes `/`, a leading `./` is dropped, and
 *   repeated `/` collapse.
 */
export function verifyReportClaims(
  report: AgentReport,
  evidence: ClaimEvidence,
  options: VerifyClaimsOptions = {},
): ClaimCheck[] {
  const fold = (path: string) => (options.ignoreCase ? path.toLowerCase() : path);
  const diff = new Set(evidence.diffFiles.map((file) => fold(normalizePath(file))));
  const reported = new Set(report.filesChanged.map((file) => fold(normalizePath(file))));
  const checks: ClaimCheck[] = [];

  for (const file of uniqueBy(report.filesChanged, (file) => fold(normalizePath(file)))) {
    if (!diff.has(fold(normalizePath(file)))) {
      checks.push({ kind: "file_not_in_diff", detail: `reported file ${file} is not in the diff` });
    }
  }
  for (const file of uniqueBy(evidence.diffFiles, (file) => fold(normalizePath(file)))) {
    if (!reported.has(fold(normalizePath(file)))) {
      checks.push({
        kind: "diff_file_not_reported",
        detail: `the diff changes ${file}, but the report does not list it`,
      });
    }
  }

  const runs = evidence.gateRuns ?? [];
  for (const test of report.testsRun) {
    const command = test.command.trim();
    const matching = runs.filter((run) => run.command.trim() === command);
    if (matching.length === 0) {
      checks.push({
        kind: "test_claim_unverified",
        detail: `no gate run for "${command}"`,
      });
      continue;
    }
    const opposite = matching.find((run) => run.passed !== test.passed);
    if (opposite) {
      checks.push({
        kind: "test_claim_contradicted",
        detail: `"${command}" is reported ${test.passed ? "passed" : "failed"}, but a gate run ${opposite.passed ? "passed" : "failed"}`,
      });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Task ids compare case-insensitively (see `TaskIdSchema`). */
function sameTask(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** "\" to "/", leading "./" removed, repeated "/" collapsed. */
function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/(\/\.)+\//g, "/")
    .replace(/(.)\/$/, "$1");
}

/** Items in first-seen order, one per key. */
function uniqueBy(items: string[], key: (item: string) => string): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

/**
 * The last `max` UTF-8 bytes of `text`. When the text was cut, its first line
 * is cut mid-line too, so it is dropped.
 */
function tailBytes(text: string, max: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) {
    return { text, truncated: false };
  }
  const tail = bytes.subarray(bytes.length - max).toString("utf8");
  const newline = tail.indexOf("\n");
  return { text: newline < 0 ? "" : tail.slice(newline + 1), truncated: true };
}

type FoundJson = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * The report's JSON. The last fenced json block wins, even when it does not
 * parse (an earlier valid block must not stand in for a broken final one).
 * Without a fenced block, bare JSON is read with `extractJsonCandidate`.
 */
function findReportJson(text: string, truncated: boolean): FoundJson {
  const jsonBlocks = fencedBlocks(text, truncated).filter(
    (block) => block.info === "" || block.info === "json" || block.info === "jsonc",
  );
  const last = jsonBlocks.at(-1);
  if (last) {
    try {
      return { ok: true, data: JSON.parse(last.body) as unknown };
    } catch (error) {
      return {
        ok: false,
        error: `report JSON does not parse: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const bare = extractJsonCandidate(text);
  if (bare.ok) {
    return { ok: true, data: bare.data };
  }
  if (text.includes("{")) {
    return {
      ok: false,
      error: `JSON found but it could not be parsed: ${bareParseError(text) ?? bare.error}`,
    };
  }
  return { ok: false, error: "no JSON report found" };
}

/** The JSON.parse message for the span from the first `{` to the last `}`, when there is one. */
function bareParseError(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return "no matching closing brace";
  }
  try {
    JSON.parse(text.slice(start, end + 1));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Fenced code blocks, line by line. The same rules as `findExecutorHandoff`
 * (src/review/pack-builder.ts), whose copy is private: a line of 3+ backticks
 * opens a block, the first word of its info string is the language, and a
 * closing line is backticks at least as long as the opener. An unclosed block
 * is dropped.
 *
 * When the text was cut (`cut`), a bare fence on the first fence line is the
 * closer of a block whose opener was cut off, so it is not an opener.
 */
function fencedBlocks(text: string, cut: boolean): Array<{ info: string; body: string }> {
  const blocks: Array<{ info: string; body: string }> = [];
  let open: { ticks: number; info: string; lines: string[] } | undefined;
  let firstFence = true;
  for (const line of text.split(/\r?\n/)) {
    if (!open) {
      const opener = /^\s*(`{3,})([^`]*)$/.exec(line);
      if (opener) {
        const info = (opener[2] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const orphanCloser = cut && firstFence && info === "";
        firstFence = false;
        if (!orphanCloser) {
          open = { ticks: opener[1]!.length, info, lines: [] };
        }
      }
      continue;
    }
    const closer = /^\s*(`{3,})\s*$/.exec(line);
    if (closer && closer[1]!.length >= open.ticks) {
      blocks.push({ info: open.info, body: open.lines.join("\n") });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  return blocks;
}
