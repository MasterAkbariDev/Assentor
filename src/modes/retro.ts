import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureAssentorGitignored } from "../persistence/paths.js";
import type { EngineEvent } from "../protocol/events.js";
import { redactSecrets } from "../security/redact.js";
import type { TemplateVariables } from "../prompts/template.js";

/** Lessons live here, relative to the project root. */
export const LESSONS_PATH = path.join(".assentor", "memory", "lessons.md");

export type RetroOutcomeStatus = "completed" | "blocked" | "failed" | "unfinished";

export interface RetroSeat {
  provider: string;
  model: string;
  role: string;
  accepted: number;
  rejected: number;
  /** Times work done by this provider/model was escalated away from it. */
  escalatedFrom: number;
  /** Times work was escalated onto this provider/model. */
  escalatedTo: number;
  failures: string[];
}

export interface RetroInput {
  goal: string;
  outcome: { status: RetroOutcomeStatus; reason?: string };
  seats: RetroSeat[];
  sessionTotals: string;
}

export interface RetroRow {
  provider: string;
  model: string;
  role: string;
  accepted: number;
  rejected: number;
  escalatedFrom: number;
  escalatedTo: number;
}

/** Every seat-derived text passes through here: redacted, one line, bounded. */
function clean(text: string, max: number): string {
  const single = redactSecrets(text).text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function reasonOf(data: object): string | undefined {
  const { reason, message } = data as { reason?: unknown; message?: unknown };
  const text = typeof reason === "string" ? reason : typeof message === "string" ? message : undefined;
  return text === undefined ? undefined : clean(text, 300);
}

interface SeatTally {
  provider: string;
  model: string;
  role: string;
  accepted: number;
  rejected: number;
  failures: string[];
}

/**
 * Folds one finished session's events into the per-seat record the retro prompt
 * reads. Seats are keyed by seat id; escalations match a seat by its
 * "provider/model" key, the same key `task.escalated` uses. Empty and failed
 * sessions produce a valid input (no seats, or failures, and the outcome).
 */
export function buildRetroInput(events: EngineEvent[]): RetroInput {
  const seats = new Map<string, SeatTally>();
  const owner = new Map<string, string>(); // taskId -> seat id of its latest assignment
  const escalations: Array<{ from: string; to: string }> = [];
  let goal: string | undefined;
  let outcome: RetroInput["outcome"] = { status: "unfinished" };
  let tokens: { in: number; out: number } | undefined;

  const seatOf = (seatId: string | undefined): SeatTally | undefined => {
    if (!seatId) return undefined;
    let seat = seats.get(seatId);
    if (!seat) {
      seat = { provider: "unknown", model: "unknown", role: "unknown", accepted: 0, rejected: 0, failures: [] };
      seats.set(seatId, seat);
    }
    return seat;
  };
  const taskSeat = (taskId: string): SeatTally | undefined => seatOf(owner.get(taskId));

  for (const event of events) {
    switch (event.type) {
      case "session.created":
        goal ??= event.data.title;
        break;
      case "session.completed":
        outcome = { status: "completed" };
        break;
      case "session.blocked":
        outcome = { status: "blocked", reason: reasonOf(event.data) };
        break;
      case "session.failed":
        outcome = { status: "failed", reason: reasonOf(event.data) };
        break;
      case "seat.spawned": {
        const seat = seatOf(event.seatId);
        if (seat) {
          seat.provider = event.data.provider;
          seat.model = event.data.model;
          seat.role = event.data.role;
        }
        break;
      }
      case "seat.model.changed": {
        const seat = seatOf(event.seatId);
        if (seat && !event.data.pending) seat.model = event.data.to;
        break;
      }
      case "seat.error":
        seatOf(event.seatId)?.failures.push(clean(event.data.message, 300));
        break;
      case "seat.done":
        if (!event.data.ok) {
          seatOf(event.seatId)?.failures.push(clean(event.data.summary ?? "finished without success", 300));
        }
        break;
      case "seat.tokens":
        tokens = { in: (tokens?.in ?? 0) + event.data.tokensIn, out: (tokens?.out ?? 0) + event.data.tokensOut };
        break;
      case "task.assigned":
        owner.set(event.data.taskId, event.data.seatId);
        break;
      case "task.accepted":
        {
          const seat = taskSeat(event.data.taskId);
          if (seat) seat.accepted += 1;
        }
        break;
      case "task.rejected":
        {
          const seat = taskSeat(event.data.taskId);
          if (seat) seat.rejected += 1;
        }
        break;
      case "task.escalated":
        escalations.push({ from: event.data.from ?? "", to: event.data.to });
        break;
      default:
        break;
    }
  }

  return {
    goal: goal ? clean(goal, 500) : "not recorded",
    outcome,
    seats: [...seats.values()].map((seat) => {
      const key = `${seat.provider}/${seat.model}`;
      return {
        ...seat,
        escalatedFrom: escalations.filter((e) => e.from === key).length,
        escalatedTo: escalations.filter((e) => e.to === key).length,
      };
    }),
    sessionTotals: totalsText(events, tokens),
  };
}

function totalsText(events: EngineEvent[], tokens: { in: number; out: number } | undefined): string {
  const parts: string[] = [];
  if (events.length > 0) {
    const seconds = Math.round((Date.parse(events.at(-1)!.at) - Date.parse(events[0]!.at)) / 1000);
    parts.push(`duration ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}`);
  }
  if (tokens) parts.push(`tokens in ${tokens.in}, out ${tokens.out}`);
  return parts.length > 0 ? parts.join("; ") : "not recorded";
}

/** One row per seat, for the scoreboard (T06-01). Nothing is persisted here. */
export function scoreboardRows(input: RetroInput): RetroRow[] {
  return input.seats.map((seat) => ({
    provider: seat.provider,
    model: seat.model,
    role: seat.role,
    accepted: seat.accepted,
    rejected: seat.rejected,
    escalatedFrom: seat.escalatedFrom,
    escalatedTo: seat.escalatedTo,
  }));
}

/**
 * Variables for the built-in `retro` prompt (`goal`, `seats`, `sessionTotals`).
 * The engine does not escape values and the prompt has no fence, so nothing is
 * escaped here; seat text is already redacted and bounded by `buildRetroInput`.
 */
export function retroVariables(input: RetroInput): TemplateVariables {
  return {
    goal: input.goal,
    seats: input.seats.map((seat) => ({
      model: seat.model,
      role: seat.role,
      accepted: seat.accepted,
      rejected: seat.rejected,
      escalations: seat.escalatedFrom,
      failures: seat.failures.length > 0 ? seat.failures.join("; ") : "none",
    })),
    sessionTotals: input.sessionTotals,
  };
}

/**
 * Appends one dated section of lessons to `.assentor/memory/lessons.md`.
 * Writes nothing and returns false when no lesson has text. Lessons are
 * redacted and put on one line each; the whole file is rewritten through a
 * temp file and a rename, so a crash never leaves it half-written.
 * shortcut: the read-then-rename is not locked, so two sessions that finish at
 * the same moment can drop one section; upgrade with the event-log lock.
 */
export async function appendLessons(
  projectPath: string,
  sessionId: string,
  lessons: string[],
): Promise<boolean> {
  const items = lessons
    .map((lesson) => clean(lesson.replace(/^\s*[-*]\s+/, ""), 500))
    .filter((lesson) => lesson.length > 0);
  if (items.length === 0) {
    return false;
  }

  const root = path.resolve(projectPath);
  const file = path.join(root, LESSONS_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await ensureAssentorGitignored(root);

  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const section = `## ${date} · session ${sessionId}\n${items.map((item) => `- ${item}`).join("\n")}\n`;
  const next = existing.length === 0 ? section : `${existing.endsWith("\n") ? existing : `${existing}\n`}\n${section}`;

  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, next, "utf8");
  await fs.rename(temp, file);
  return true;
}
