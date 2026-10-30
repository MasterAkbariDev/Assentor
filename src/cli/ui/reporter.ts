import * as readline from "node:readline";
import type { EngineEvent } from "../../protocol/events.js";
import type { SupervisorEvent } from "../../orchestrator/supervisor.js";
import {
  reduceSeatEvents,
  seatLineModel,
  type SeatLineModel,
  type SeatState,
} from "../../ui-shared/status.js";
import {
  isExecutorStreamBlob,
  summarizeExecutorStreamOutput,
} from "../../providers/executors/cursor/stream-status.js";
import {
  emptyLeadBoardView,
  LEAD_COLUMN_LABELS,
  LEAD_COLUMNS,
  leadColumns,
  reduceLeadEvents,
  type LeadBoardView,
} from "../../ui-shared/lead.js";

const ESC = "\x1b[";
const c = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  magenta: `${ESC}35m`,
  blue: `${ESC}34m`,
  white: `${ESC}37m`,
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Activity =
  | "starting"
  | "thinking"
  | "reading"
  | "editing"
  | "writing"
  | "searching"
  | "running"
  | "exploring"
  | "planning"
  | "reviewing"
  | "collecting"
  | "waiting";

/**
 * Production CLI progress UI: one in-place status line, colored sections,
 * no raw agent dumps or event spam (unless verbose).
 */
export class RunReporter {
  private heartbeat?: NodeJS.Timeout;
  private phaseStartedAt = 0;
  private statusLabel = "";
  private activity: Activity = "waiting";
  private activityDetail = "";
  private spinnerIndex = 0;
  private readonly isTty = Boolean(process.stdout.isTTY);
  private statusActive = false;
  private lastPaintAt = 0;
  private pendingPaint?: NodeJS.Timeout;
  private lastSection = "";
  private round = 0;
  private lastNonTtySec = -1;
  private lastToolDetail = "";
  /** Reviewer seats folded from seat events (`reviewer-*` only). */
  private reviewerSeats: Record<string, SeatState> = {};
  /** Team board folded from lead events. Printed on each lead turn in lead mode. */
  private leadView: LeadBoardView = emptyLeadBoardView();
  private leadMode = false;

  constructor(
    private readonly options: {
      verbose?: boolean;
      executorName: string;
      reviewerName: string;
    },
  ) {}

  updateAgentLabels(labels: {
    executorName?: string;
    reviewerName?: string;
  }): void {
    if (labels.executorName) {
      this.options.executorName = labels.executorName;
    }
    if (labels.reviewerName) {
      this.options.reviewerName = labels.reviewerName;
    }
  }

  /** Immediate spinner so run/resume is never a blank screen. */
  preparing(detail: string): void {
    this.section("Setup");
    this.startStatus("Assentor", "starting", detail);
  }

  updatePreparing(detail: string): void {
    if (!this.statusActive) {
      this.preparing(detail);
      return;
    }
    this.activityDetail = truncate(detail, 72);
    this.paint(true);
  }

  /** Drop the startup spinner so the task banner can print. */
  ready(): void {
    this.endStatus();
  }

  header(lines: string[]): void {
    this.endStatus();
    for (const line of lines) {
      console.log(`${c.dim}${line}${c.reset}`);
    }
  }

  note(message: string): void {
    this.writeln(`  ${c.dim}${message}${c.reset}`);
  }

  /**
   * Folds reviewer seat events into the seat state. After the `review.completed`
   * event (sent as `review.verdict` with `legacyType`), prints the seats. The
   * stream is strictly ordered, so every reviewer `seat.done` before it is folded.
   */
  onEngineEvent(event: EngineEvent): void {
    if (event.seatId?.startsWith("reviewer-")) {
      this.reviewerSeats = reduceSeatEvents(this.reviewerSeats, event);
    }
    if (
      event.type === "review.verdict" &&
      (event.data as { legacyType?: string }).legacyType === "review.completed"
    ) {
      this.printReviewSeats();
    }
    if (event.type === "mode.selected") {
      this.leadMode = event.data.mode === "lead";
    }
    this.leadView = reduceLeadEvents(this.leadView, event);
    if (event.type === "lead.turn" && this.leadMode) {
      this.printLeadBoard();
    }
  }

  /**
   * "Team board" section for lead mode: the task columns and the last lead
   * actions, as the lead sees them at the start of a turn. Written with `writeln`
   * for the same reason as `printReviewSeats`.
   */
  printLeadBoard(): void {
    const width = process.stdout.columns ?? 80;
    const ascii = useAsciiIcons(this.isTty);
    this.writeln(`\n${c.bold}${c.cyan}▸ Team board${c.reset}${c.dim}  turn ${this.leadView.turn}${c.reset}`);
    for (const line of leadBoardLines(this.leadView, width, ascii)) {
      this.writeln(line);
    }
  }

  /**
   * "Review seats" section: one line per reviewer seat. Prints only when the
   * run has more than one reviewer seat, so single-reviewer output is unchanged.
   *
   * Written with `writeln`, not `section()`: that would end the live status line
   * and reset the section state, and this can run while the next phase is drawing.
   * On the final round the section can appear after "Task passed review"; that
   * ordering is known and accepted.
   */
  printReviewSeats(): void {
    const seats = Object.values(this.reviewerSeats);
    if (seats.length <= 1) {
      return;
    }
    const ascii = useAsciiIcons(this.isTty);
    const width = process.stdout.columns ?? 80;
    const now = Date.now();
    this.writeln(`\n${c.bold}${c.cyan}▸ Review seats${c.reset}`);
    for (const seat of seats) {
      this.writeln(fitSeatLine(seatLineModel(seat, now, ascii), width, 2));
    }
  }

  onEvent(event: SupervisorEvent): void {
    if (event.type === "state.changed") {
      const to = String(event.data?.to ?? "");
      this.handleState(to, event.data?.reason ? String(event.data.reason) : undefined);
      this.debug(event);
      return;
    }

    if (event.type === "round.started") {
      this.round = Number(event.data?.round ?? this.round);
      this.section(`Round ${this.round}`);
      this.debug(event);
      return;
    }

    if (event.type === "executor.started") {
      this.section(`Executor · ${this.options.executorName}`);
      this.startStatus(
        `${this.options.executorName}`,
        "starting",
        "waiting for agent events…",
      );
      this.debug(event);
      return;
    }

    if (event.type === "executor.retry") {
      const attempt = Number(event.data?.attempt ?? 1);
      const maxAttempts = Number(event.data?.maxAttempts ?? 1);
      const delayMs = Number(event.data?.delayMs ?? 0);
      const reason = event.data?.reason
        ? String(event.data.reason)
        : "transient error";
      this.endStatus();
      console.log(
        `  ${c.yellow}↻${c.reset} Retrying ${this.options.executorName} (${attempt}/${maxAttempts}) in ${Math.round(delayMs / 1000)}s ${c.dim}— ${truncate(reason, 72)}${c.reset}`,
      );
      this.debug(event);
      return;
    }

    if (event.type === "review.retry") {
      const attempt = Number(event.data?.attempt ?? 1);
      const maxAttempts = Number(event.data?.maxAttempts ?? 1);
      const delayMs = Number(event.data?.delayMs ?? 0);
      const reason = event.data?.reason
        ? String(event.data.reason)
        : "transient error";
      this.endStatus();
      console.log(
        `  ${c.yellow}↻${c.reset} Retrying ${this.options.reviewerName} (${attempt}/${maxAttempts}) in ${Math.round(delayMs / 1000)}s ${c.dim}— ${truncate(reason, 72)}${c.reset}`,
      );
      this.debug(event);
      return;
    }

    if (event.type === "executor.completed" || event.type === "executor.failed") {
      const execStatus =
        typeof event.data?.status === "string" ? event.data.status : undefined;
      const summary = event.data?.summary
        ? String(event.data.summary)
        : event.type === "executor.failed"
          ? "failed"
          : "done";
      const raw = event.data?.rawOutput ? String(event.data.rawOutput) : "";
      const ok =
        event.type === "executor.completed" && execStatus === "completed";
      const failLabel =
        execStatus === "timeout"
          ? "timed out"
          : truncate(String(event.data?.error ?? summary), 80);
      this.finishStatus(ok, ok ? "done" : failLabel);
      const body = preferPlainExecutorText(summary, raw);
      if (body) {
        console.log(`\n  ${c.bold}Executor response${c.reset}`);
        for (const line of wrapMultiline(body, 88)) {
          console.log(`  ${line}`);
        }
        console.log("");
      }
      this.debug(event);
      return;
    }

    if (event.type === "verification.started") {
      this.section("Verification");
      this.startStatus("Gates", "running", "lint / typecheck / tests");
      this.debug(event);
      return;
    }

    if (event.type === "verification.passed") {
      this.finishStatus(true, "deterministic checks passed");
      this.debug(event);
      return;
    }

    if (event.type === "verification.failed") {
      this.finishStatus(false, "deterministic checks failed — skipping LLM review");
      this.debug(event);
      return;
    }

    if (event.type === "review.started") {
      this.section(`Reviewer · ${this.options.reviewerName}`);
      this.startStatus(
        this.options.reviewerName,
        "reviewing",
        "judging acceptance criteria",
      );
      this.debug(event);
      return;
    }

    if (event.type === "review.completed") {
      this.finishStatus(true, "response received");
      this.printReview(event.data ?? {});
      this.debug(event);
      return;
    }

    if (event.type === "evidence.requested") {
      const files = Array.isArray(event.data?.files)
        ? (event.data.files as string[])
        : [];
      const count = event.data?.count != null ? Number(event.data.count) : 0;
      if (this.statusActive && this.statusLabel === "Evidence") {
        this.finishStatus(
          true,
          files.length > 0
            ? files.slice(0, 5).join(", ") + (files.length > 5 ? "…" : "")
            : `${count} artifact(s)`,
        );
      } else {
        this.endStatus();
        if (files.length > 0) {
          console.log(
            `  ${c.green}✓${c.reset} Evidence ready · ${c.cyan}${files.slice(0, 6).join(", ")}${files.length > 6 ? "…" : ""}${c.reset}`,
          );
        } else if (event.data?.note) {
          console.log(`  ${c.dim}${String(event.data.note)}${c.reset}`);
        } else if (count > 0) {
          console.log(
            `  ${c.yellow}▸${c.reset} Reviewer asked for more evidence (${count})`,
          );
        }
      }
      this.debug(event);
      return;
    }

    if (event.type === "change.requested") {
      this.endStatus();
      console.log(
        `  ${c.yellow}▸${c.reset} Sending change request back to ${this.options.executorName}`,
      );
      this.debug(event);
      return;
    }

    if (
      event.type === "task.completed" ||
      event.type === "task.failed" ||
      event.type === "task.blocked" ||
      event.type === "budget.exceeded" ||
      event.type === "loop.detected"
    ) {
      this.endStatus();
      const color =
        event.type === "task.completed"
          ? c.green
          : event.type === "task.failed" || event.type === "budget.exceeded"
            ? c.red
            : c.yellow;
      const summary = event.data?.summary
        ? `: ${truncate(String(event.data.summary), 160)}`
        : event.data?.reason
          ? `: ${truncate(String(event.data.reason), 160)}`
          : "";
      console.log(`\n  ${color}${c.bold}${labelEvent(event.type)}${summary}${c.reset}`);
      this.debug(event);
      return;
    }

    this.debug(event);
  }

  /** Live structured status from Cursor stream-json (preferred). */
  onExecutorStatus(status: { activity: string; detail: string }): void {
    if (!this.statusActive || this.statusLabel === "Evidence") {
      return;
    }
    const next = normalizeActivity(status.activity);
    const detail = (status.detail || status.activity).trim();
    // Keep the last tool/file line while the model is "reasoning" so it
    // doesn't look frozen on the word "reasoning" for minutes.
    if (
      (next === "thinking" || /reason/i.test(detail)) &&
      this.lastToolDetail &&
      (this.activity === "editing" ||
        this.activity === "writing" ||
        this.activity === "reading" ||
        this.activity === "running" ||
        this.activity === "searching" ||
        this.activity === "exploring")
    ) {
      this.activity = "thinking";
      this.activityDetail = truncate(
        `still working · last: ${this.lastToolDetail}`,
        72,
      );
      this.paint(true);
      return;
    }
    this.activity = next;
    this.activityDetail = truncate(
      next === "thinking" && (!detail || /^(reasoning|planning)/i.test(detail))
        ? "model thinking — this can take a few minutes"
        : detail || next,
      72,
    );
    if (
      next === "editing" ||
      next === "writing" ||
      next === "reading" ||
      next === "running" ||
      next === "searching" ||
      next === "exploring"
    ) {
      this.lastToolDetail = this.activityDetail;
    }
    this.paint(true);
  }

  /** Infer activity from live agent text output (fallback). */
  onExecutorOutput(chunk: string, _stream: "stdout" | "stderr"): void {
    const activity = inferActivity(chunk);
    if (activity) {
      this.activity = activity.kind;
      this.activityDetail = activity.detail;
      this.paint(true);
    } else if (this.statusActive && this.activity === "starting") {
      this.activity = "running";
      this.activityDetail = "agent is working";
      this.paint(true);
    }
  }

  onReviewerStatus(message: string): void {
    const model = message.match(/Calling Gemini \(([^)]+)\)/i)?.[1];
    if (model) {
      this.activity = "reviewing";
      this.activityDetail = `calling ${model}`;
      this.paint(true);
      return;
    }

    const used = message.match(/responded with (.+)$/i)?.[1];
    if (used) {
      this.activityDetail = `got reply from ${used}`;
      this.paint(true);
      return;
    }

    if (/fallback|unavailable/i.test(message)) {
      this.activityDetail = truncate(message, 80);
      this.paint(true);
      if (this.options.verbose) {
        this.endStatus();
        console.log(`  ${c.yellow}· ${message}${c.reset}`);
        this.paint(true);
      }
    }
  }

  dispose(): void {
    this.endStatus();
    this.stopHeartbeat();
    if (this.pendingPaint) {
      clearTimeout(this.pendingPaint);
      this.pendingPaint = undefined;
    }
  }

  private handleState(to: string, reason?: string): void {
    switch (to) {
      case "CHECKING_PROJECT":
        this.section("Setup");
        this.oneShot("Checking project path");
        break;
      case "CREATING_CHECKPOINT":
        this.oneShot("Creating git checkpoint");
        break;
      case "CONTRACTING":
        this.oneShot("Building task contract");
        break;
      case "EXECUTING":
        // Round / executor.started will own the UI.
        break;
      case "COLLECTING_EVIDENCE":
        this.section("Evidence");
        this.startStatus(
          "Evidence",
          "collecting",
          "gathering files, git, and project context locally",
        );
        break;
      case "REVIEWING":
        // review.started owns the UI
        break;
      case "COMMUNICATING":
        this.section("Follow-up");
        this.oneShot("Collecting reviewer-requested evidence locally");
        break;
      case "DONE":
        this.endStatus();
        console.log(`\n  ${c.green}${c.bold}✓ Task passed review${c.reset}`);
        break;
      case "FAILED":
        this.endStatus();
        console.log(
          `\n  ${c.red}${c.bold}✗ Task failed${c.reset}${reason ? `${c.dim} — ${truncate(reason, 120)}${c.reset}` : ""}`,
        );
        break;
      default:
        break;
    }
  }

  private writeln(text: string): void {
    if (this.statusActive && this.isTty) {
      this.clearLine();
      process.stdout.write(`${text}\n`);
      this.paint(true);
      return;
    }
    console.log(text);
  }

  private section(title: string): void {
    this.endStatus();
    if (title === this.lastSection) {
      return;
    }
    this.lastSection = title;
    console.log(`\n${c.bold}${c.cyan}▸ ${title}${c.reset}`);
  }

  private oneShot(message: string): void {
    this.endStatus();
    console.log(`  ${c.green}✓${c.reset} ${message}`);
  }

  private startStatus(
    label: string,
    activity: Activity,
    detail: string,
  ): void {
    this.statusLabel = label;
    this.activity = activity;
    this.activityDetail = detail;
    if (activity !== "thinking") {
      this.lastToolDetail = "";
    }
    this.phaseStartedAt = Date.now();
    this.spinnerIndex = 0;
    this.lastNonTtySec = -1;
    this.statusActive = true;
    this.startHeartbeat();
    this.paint(true);
  }

  private finishStatus(ok: boolean, detail: string): void {
    this.stopHeartbeat();
    if (!this.statusActive) {
      return;
    }
    const elapsed = formatElapsed(Date.now() - this.phaseStartedAt);
    this.clearLine();
    const mark = ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(
      `  ${mark} ${this.statusLabel} ${c.dim}· ${elapsed}${c.reset} · ${truncate(detail, 90)}`,
    );
    this.statusActive = false;
    this.statusLabel = "";
  }

  private endStatus(): void {
    if (!this.statusActive) {
      return;
    }
    this.stopHeartbeat();
    this.clearLine();
    this.statusActive = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER.length;
      this.paint(false);
    }, 250);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private paint(force: boolean): void {
    if (!this.statusActive || !this.statusLabel) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastPaintAt < 200) {
      if (!this.pendingPaint) {
        this.pendingPaint = setTimeout(() => {
          this.pendingPaint = undefined;
          this.paint(true);
        }, 200);
        this.pendingPaint.unref?.();
      }
      return;
    }
    this.lastPaintAt = now;

    const elapsed = formatElapsed(now - this.phaseStartedAt);
    const spin = SPINNER[this.spinnerIndex] ?? "·";
    const color = activityColor(this.activity);
    const line = `  ${c.cyan}${spin}${c.reset} ${this.statusLabel} ${c.dim}·${c.reset} ${color}${c.bold}${this.activity}${c.reset} ${c.dim}${elapsed}${c.reset}  ${c.dim}${truncate(this.activityDetail, 64)}${c.reset}`;

    if (this.isTty) {
      this.clearLine();
      process.stdout.write(line);
      return;
    }

    // Non-TTY: at most one progress line every 5s (ignore force after start).
    const sec = Math.floor((now - this.phaseStartedAt) / 1000);
    if (sec > 0 && sec % 5 === 0 && sec !== this.lastNonTtySec) {
      this.lastNonTtySec = sec;
      console.log(line);
    }
  }

  private clearLine(): void {
    if (!this.isTty) {
      return;
    }
    try {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    } catch {
      process.stdout.write(`\r${ESC}2K`);
    }
  }

  private printReview(data: Record<string, unknown>): void {
    this.endStatus();
    const status = String(data.status ?? "UNKNOWN");
    const summary = data.summary ? String(data.summary) : "";
    const confidence =
      typeof data.confidence === "number"
        ? ` · confidence ${(data.confidence * 100).toFixed(0)}%`
        : "";
    const statusColor =
      status === "PASS"
        ? c.green
        : status === "NEEDS_WORK"
          ? c.yellow
          : c.red;

    console.log(
      `\n  ${statusColor}${c.bold}Decision: ${status}${c.reset}${c.dim}${confidence}${c.reset}`,
    );
    if (summary) {
      for (const paragraph of wrapText(summary, 88)) {
        console.log(`  ${paragraph}`);
      }
    }

    const issues = Array.isArray(data.issues) ? data.issues : [];
    if (issues.length > 0) {
      console.log(`  ${c.bold}Issues${c.reset}`);
      for (const issue of issues.slice(0, 8)) {
        const row = issue as {
          severity?: string;
          description?: string;
          id?: string;
        };
        console.log(
          `    ${c.yellow}•${c.reset} [${row.severity ?? "?"}] ${truncate(row.description ?? String(issue), 100)}`,
        );
      }
    }

    const required = Array.isArray(data.requiredChanges)
      ? data.requiredChanges.map(String)
      : [];
    if (required.length > 0) {
      console.log(`  ${c.bold}Required changes${c.reset}`);
      for (const item of required.slice(0, 8)) {
        console.log(`    ${c.yellow}•${c.reset} ${truncate(item, 100)}`);
      }
    }

    const evidence = Array.isArray(data.evidenceRequests)
      ? data.evidenceRequests
      : [];
    if (evidence.length > 0) {
      console.log(`  ${c.bold}Evidence requested${c.reset}`);
      for (const item of evidence.slice(0, 8)) {
        const row = item as { kind?: string; path?: string; command?: string };
        const target = row.path ?? row.command ?? JSON.stringify(item);
        console.log(
          `    ${c.blue}•${c.reset} ${row.kind ?? "item"}: ${truncate(String(target), 80)}`,
        );
      }
    }
  }

  private debug(event: SupervisorEvent): void {
    if (!this.options.verbose) {
      return;
    }
    const resume =
      this.statusActive && this.statusLabel
        ? {
            label: this.statusLabel,
            activity: this.activity,
            detail: this.activityDetail,
          }
        : undefined;
    this.endStatus();
    const detail = event.data ? ` ${JSON.stringify(event.data)}` : "";
    console.log(
      `  ${c.dim}[debug] ${event.type}${truncate(detail, 160)}${c.reset}`,
    );
    if (resume) {
      this.startStatus(resume.label, resume.activity, resume.detail);
    }
  }
}

function activityColor(activity: Activity): string {
  switch (activity) {
    case "editing":
    case "writing":
      return c.magenta;
    case "reading":
    case "exploring":
    case "searching":
      return c.blue;
    case "reviewing":
    case "planning":
      return c.yellow;
    case "thinking":
      return c.cyan;
    case "collecting":
      return c.blue;
    case "running":
      return c.green;
    default:
      return c.dim;
  }
}

function normalizeActivity(value: string): Activity {
  switch (value) {
    case "starting":
    case "thinking":
    case "reading":
    case "editing":
    case "writing":
    case "searching":
    case "running":
    case "exploring":
    case "planning":
    case "reviewing":
    case "collecting":
    case "waiting":
      return value;
    default:
      return "running";
  }
}

function inferActivity(
  chunk: string,
): { kind: Activity; detail: string } | undefined {
  const text = chunk.replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }

  if (/writ(e|ing|es)|created file|updated file|apply.?patch|strreplace/i.test(text)) {
    return { kind: "writing", detail: snippet(text) };
  }
  if (/edit(ing|ed)?|modif(y|ied)|change(d|s)?/i.test(text)) {
    return { kind: "editing", detail: snippet(text) };
  }
  if (/read(ing|s)?|open(ed|ing)?|inspect|look(ing)? at|view(ing)?/i.test(text)) {
    return { kind: "reading", detail: snippet(text) };
  }
  if (/think(ing)?|plan(ning)?|analyz/i.test(text)) {
    return { kind: "thinking", detail: snippet(text) };
  }
  if (/run(ning)?|execut|shell|test|build|npm|pnpm/i.test(text)) {
    return { kind: "running", detail: snippet(text) };
  }
  return { kind: "running", detail: snippet(text) };
}

function snippet(text: string): string {
  return truncate(text.replace(/^[#*\-\s]+/, ""), 48);
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, max - 1)}…`;
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem.toString().padStart(2, "0")}s`;
}

function wrapText(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function wrapMultiline(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    lines.push(...wrapText(paragraph, width));
  }
  return lines;
}

/** Prefer the agent's summary; skip huge stream-json blobs. */
function preferPlainExecutorText(summary: string, raw: string): string {
  const s = summary.trim();
  if (s && !isExecutorStreamBlob(s)) {
    return s;
  }
  const fromRaw = summarizeExecutorStreamOutput(raw);
  if (fromRaw) {
    return fromRaw;
  }
  return "";
}

/** Icon column width in a seat line: the longest ASCII icon (`...`) plus a space. */
const ICON_CELL = 4;
/** Narrowest detail worth showing in a seat line. */
const MIN_DETAIL_COLUMNS = 8;

/** ASCII icons when unicode may not draw: ASSENTOR_ASCII=1, legacy Windows console, or no TTY. */
function useAsciiIcons(isTty: boolean): boolean {
  return (
    process.env.ASSENTOR_ASCII === "1" ||
    (process.platform === "win32" && !process.env.WT_SESSION) ||
    !isTty
  );
}

/** Columns a string takes in a terminal. 🛠, ⏳ and ⏸ take two; the rest of the icons take one. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charColumns(ch);
  }
  return width;
}

function charColumns(ch: string): number {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x1f000 || (cp >= 0x23e9 && cp <= 0x23fa) ? 2 : 1;
}

/** `text` cut to `columns`, ending in "…" when it does not fit. */
function cutToWidth(text: string, columns: number): string {
  if (columns <= 0) {
    return "";
  }
  if (displayWidth(text) <= columns) {
    return text;
  }
  let out = "";
  let used = 0;
  for (const ch of text) {
    const next = charColumns(ch);
    if (used + next > columns - 1) {
      break;
    }
    out += ch;
    used += next;
  }
  return `${out}…`;
}

/**
 * One reviewer seat line, `icon label  name · model · role  detail  elapsed`,
 * fitted to `width` columns with one column to spare. The detail is cut first;
 * the elapsed time stays.
 */
function fitSeatLine(line: SeatLineModel, width: number, indent: number): string {
  const budget = Math.max(0, width - indent - 1);
  const who = [line.name, line.model, line.role].filter(Boolean).join(" · ");
  const icon = `${line.icon}${" ".repeat(Math.max(1, ICON_CELL - displayWidth(line.icon)))}`;
  const tail = line.elapsed ? `  ${line.elapsed}` : "";
  const head = cutToWidth(`${icon}${line.label}  ${who}`, budget - displayWidth(tail));
  const detailRoom = budget - displayWidth(tail) - displayWidth(head) - 2;
  const detail =
    line.detail && detailRoom >= MIN_DETAIL_COLUMNS
      ? `  ${cutToWidth(line.detail, detailRoom)}`
      : "";
  return `${" ".repeat(indent)}${head}${detail}${tail}`;
}

/** Team board body: one block per non-empty column, then the last lead actions. Fitted to `width`. */
function leadBoardLines(view: LeadBoardView, width: number, ascii: boolean): string[] {
  const lines: string[] = [];
  const columns = leadColumns(view);
  for (const column of LEAD_COLUMNS) {
    const tasks = columns[column];
    if (tasks.length === 0) {
      continue;
    }
    lines.push(`  ${c.bold}${LEAD_COLUMN_LABELS[column]} (${tasks.length})${c.reset}`);
    for (const task of tasks) {
      const rejected = task.state === "rejected" ? `${c.red}${ascii ? "x" : "✗"}${c.reset} ` : "";
      const owner = task.owner ? `  ${task.owner}` : "";
      const markWidth = task.state === "rejected" ? 2 : 0;
      lines.push(`    ${rejected}${cutToWidth(`${task.id} ${task.title}${owner}`, width - 6 - markWidth)}`);
    }
  }
  if (lines.length === 0) {
    lines.push("  (no tasks yet)");
  }
  if (view.log.length > 0) {
    lines.push(`  ${c.bold}Lead log${c.reset}`);
    for (const entry of view.log) {
      const mark = entry.accepted
        ? `${c.green}${ascii ? "OK" : "✓"}${c.reset}`
        : `${c.red}${ascii ? "X" : "✗"}${c.reset}`;
      const text = `${entry.action}${entry.reason ? `: ${entry.reason}` : ""}`;
      lines.push(`    ${mark} ${cutToWidth(text, width - 8 - displayWidth(ascii ? "OK" : "✓"))}`);
    }
  }
  return lines;
}

function labelEvent(type: string): string {
  switch (type) {
    case "task.completed":
      return "Task completed";
    case "task.failed":
      return "Task failed";
    case "task.blocked":
      return "Task blocked";
    case "budget.exceeded":
      return "Budget exceeded";
    case "loop.detected":
      return "Loop detected";
    default:
      return type;
  }
}
