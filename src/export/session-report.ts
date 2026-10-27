import { promises as fs } from "node:fs";
import type { EngineEvent } from "../protocol/events.js";
import { redactSecrets } from "../security/redact.js";
import { reduceSeatEvents, type SeatState } from "../ui-shared/status.js";

/**
 * Markdown report of one session, rendered from its event log (T06-02).
 *
 * `renderSessionReport` is pure: no I/O and no clock. Every time shown comes
 * from an event's `at`. It never prints output text: seat output appears only
 * as a character count.
 *
 * Escaping: every string that came from event data (model text, seat names,
 * messages, ids) is written through `code()`. It is redacted for secrets, has
 * backticks swapped for ʼ (U+02BC) and newlines turned into spaces, then wrapped
 * in a code span. Inside a code span Markdown and HTML are not interpreted, so
 * `<script>` stays literal and a `# heading` cannot start a line. Table cells
 * also escape `|`.
 */

export interface SessionReportOptions {
  /** Timeline lines before the "… N more events" cut-off. Default 200. */
  maxTimelineLines?: number;
}

const DEFAULT_MAX_TIMELINE_LINES = 200;

/** Renders event-derived text as a safe inline code span. */
function code(value: string | undefined): string {
  const safe = redactSecrets(value ?? "")
    .text.replace(/`/g, "ʼ")
    .replace(/\r\n|\r|\n/g, " ")
    .trim();
  return safe.length > 0 ? `\`${safe}\`` : "-";
}

/** A table cell: a code span with `|` escaped so it cannot split the row. */
function cell(value: string | undefined): string {
  return code(value).replace(/\|/g, "\\|");
}

function formatDuration(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

interface SpawnInfo {
  provider: string;
  permissions: string;
}

interface Verdict {
  seq: number;
  round?: number;
  seatId?: string;
  status: string;
}

interface Gate {
  seq: number;
  passed: boolean;
  stageId?: string;
}

interface Issue {
  seq: number;
  text: string;
}

/** Everything the sections need, gathered in one pass over the events. */
interface Fold {
  title?: string;
  outcome: string;
  seats: Record<string, SeatState>;
  spawns: Map<string, SpawnInfo>;
  outputChars: Map<string, number>;
  round?: number;
  verdicts: Verdict[];
  gates: Gate[];
  issues: Issue[];
}

function fold(events: EngineEvent[]): Fold {
  const result: Fold = {
    outcome: "in progress or interrupted",
    seats: {},
    spawns: new Map(),
    outputChars: new Map(),
    verdicts: [],
    gates: [],
    issues: [],
  };

  for (const event of events) {
    result.seats = reduceSeatEvents(result.seats, event);

    switch (event.type) {
      case "session.created":
        result.title ??= event.data.title;
        break;
      case "session.completed":
        result.outcome = "completed";
        break;
      case "session.blocked":
        result.outcome = "blocked";
        break;
      case "session.failed":
        result.outcome = "failed";
        break;
      case "session.warning":
        result.issues.push({
          seq: event.seq,
          text: `${event.data.kind}${event.data.message ? `: ${event.data.message}` : ""}`,
        });
        break;
      case "seat.error":
        result.issues.push({
          seq: event.seq,
          text: `${event.seatId ?? "seat"}: ${event.data.message}`,
        });
        break;
      case "seat.spawned":
        if (event.seatId) {
          result.spawns.set(event.seatId, {
            provider: event.data.provider,
            permissions: event.data.permissions,
          });
        }
        break;
      case "seat.output.delta":
        if (event.seatId) {
          const previous = result.outputChars.get(event.seatId) ?? 0;
          result.outputChars.set(event.seatId, previous + event.data.text.length);
        }
        break;
      case "round.started":
      case "round.completed":
        result.round = event.data.round;
        break;
      case "review.verdict":
        result.verdicts.push({
          seq: event.seq,
          ...(result.round !== undefined ? { round: result.round } : {}),
          ...(event.seatId ? { seatId: event.seatId } : {}),
          status: event.data.status,
        });
        break;
      case "gate.result":
        result.gates.push({
          seq: event.seq,
          passed: event.data.passed,
          ...(event.stageId ? { stageId: event.stageId } : {}),
        });
        break;
      default:
        break;
    }
  }

  return result;
}

function seatsSection(data: Fold): string[] {
  const seats = Object.values(data.seats);
  if (seats.length === 0) {
    return ["_No seats._"];
  }
  const lines = [
    "| Seat | Provider | Model | Role | Permissions | Final status | Tokens in/out | Output chars |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const seat of seats) {
    const spawn = data.spawns.get(seat.seatId);
    const values = [
      cell(seat.displayName),
      cell(spawn?.provider),
      cell(seat.model),
      cell(seat.role),
      cell(spawn?.permissions),
      cell(seat.status),
      cell(`${seat.tokensIn} / ${seat.tokensOut}`),
      cell(String(data.outputChars.get(seat.seatId) ?? 0)),
    ];
    lines.push(`| ${values.join(" | ")} |`);
  }
  return lines;
}

function verdictsSection(data: Fold): string[] {
  if (data.verdicts.length === 0) {
    return ["_None._"];
  }
  return data.verdicts.map((verdict) => {
    const round = verdict.round !== undefined ? `round ${verdict.round}` : "round unknown";
    const seat = verdict.seatId ? `seat ${code(verdict.seatId)}` : "no seat";
    return `- ${round}, ${seat}: ${code(verdict.status)}`;
  });
}

function gatesSection(data: Fold): string[] {
  if (data.gates.length === 0) {
    return ["_None._"];
  }
  return data.gates.map((gate) => {
    const stage = gate.stageId ? ` ${code(gate.stageId)}` : "";
    return `- gate${stage}: ${gate.passed ? "passed" : "failed"}`;
  });
}

function issuesSection(data: Fold): string[] {
  if (data.issues.length === 0) {
    return ["_None._"];
  }
  return data.issues.map((issue) => `- ${code(issue.text)}`);
}

/** One line per event: sequence, time, type, and the few fields that explain it. */
function timelineLine(event: EngineEvent): string {
  const parts = [`\`${event.seq}\``, code(event.at), `\`${event.type}\``];
  if (event.seatId) {
    parts.push(`seat ${code(event.seatId)}`);
  }
  if (event.stageId) {
    parts.push(`stage ${code(event.stageId)}`);
  }
  switch (event.type) {
    case "seat.status":
      parts.push(code(event.data.status));
      break;
    case "seat.tool_call":
      parts.push(code(event.data.name));
      break;
    case "seat.error":
      parts.push(code(event.data.message));
      break;
    case "session.warning":
      parts.push(code(event.data.kind));
      break;
    case "review.verdict":
      parts.push(code(event.data.status));
      break;
    case "gate.result":
      parts.push(event.data.passed ? "passed" : "failed");
      break;
    default:
      break;
  }
  return `- ${parts.join(" ")}`;
}

function timelineSection(events: EngineEvent[], maxLines: number): string[] {
  const timeline = events.filter((event) => event.type !== "seat.output.delta");
  if (timeline.length === 0) {
    return ["_No events._"];
  }
  const shown = timeline.slice(0, maxLines).map(timelineLine);
  const more = timeline.length - shown.length;
  if (more > 0) {
    shown.push("", `… ${more} more events`);
  }
  return shown;
}

/** The Markdown report for one session's events, in log order. Throws on an empty list. */
export function renderSessionReport(
  events: EngineEvent[],
  options: SessionReportOptions = {},
): string {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) {
    throw new Error("Cannot render a session report without events");
  }

  const maxTimeline = Math.max(0, Math.floor(options.maxTimelineLines ?? DEFAULT_MAX_TIMELINE_LINES));
  const data = fold(events);
  const sessionId = first.sessionId;
  const title = data.title ?? `Assentor session ${sessionId}`;

  const lines: string[] = [
    `# ${code(title)}`,
    "",
    `- Session: ${code(sessionId)}`,
    `- Started: ${code(first.at)}`,
    `- Ended: ${code(last.at)}`,
    `- Duration: ${formatDuration(first.at, last.at)}`,
    "",
    "## Outcome",
    "",
    data.outcome,
    "",
    "## Seats",
    "",
    ...seatsSection(data),
    "",
    "## Review verdicts",
    "",
    ...verdictsSection(data),
    "",
    "## Gates",
    "",
    ...gatesSection(data),
    "",
    "## Warnings and errors",
    "",
    ...issuesSection(data),
    "",
    "## Timeline",
    "",
    ...timelineSection(events, maxTimeline),
  ];

  return `${lines.join("\n")}\n`;
}

export class ReportExistsError extends Error {
  constructor(public readonly file: string) {
    super(`Refusing to overwrite ${file}; pass --force to replace it`);
    this.name = "ReportExistsError";
  }
}

/**
 * Writes a report file. Refuses to replace an existing file unless `force`
 * is set (`wx` flag, so the check and the write are one step).
 */
export async function saveSessionReport(
  file: string,
  content: string,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    await fs.writeFile(file, content, {
      encoding: "utf8",
      flag: options.force ? "w" : "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ReportExistsError(file);
    }
    throw error;
  }
}
