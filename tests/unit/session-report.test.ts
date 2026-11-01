import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineEvent } from "../../packages/protocol/src/events.js";
import {
  renderSessionReport,
  ReportExistsError,
  saveSessionReport,
} from "../../packages/engine/src/export/index.js";

const SESSION = "s-report-1";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

let seq = 0;
const T0 = Date.parse("2026-01-01T10:00:00.000Z");

/** Builds an event with a deterministic seq and a time `offsetSec` after the start. */
function ev(offsetSec: number, type: string, data: object, extra: Partial<EngineEvent> = {}): EngineEvent {
  seq += 1;
  return {
    seq,
    sessionId: SESSION,
    at: new Date(T0 + offsetSec * 1000).toISOString(),
    type,
    data,
    ...extra,
  } as EngineEvent;
}

function fixture(): EngineEvent[] {
  seq = 0;
  return [
    ev(0, "session.created", { title: "Fix the | login <b>flow</b>" }),
    ev(1, "round.started", { round: 1 }),
    ev(2, "seat.spawned", {
      displayName: "Builder",
      provider: "mock",
      transport: "cli",
      model: "m-1",
      role: "executor",
      permissions: "edit",
    }, { seatId: "builder" }),
    ev(3, "seat.spawned", {
      displayName: "Reviewer",
      provider: "openai",
      transport: "api",
      model: "m-2",
      role: "reviewer",
      permissions: "read-only",
    }, { seatId: "reviewer" }),
    ev(4, "seat.status", { status: "writing" }, { seatId: "builder" }),
    ev(5, "seat.output.delta", { text: "SECRET_OUTPUT_TEXT" }, { seatId: "builder" }),
    ev(6, "seat.tokens", { tokensIn: 100, tokensOut: 40 }, { seatId: "builder" }),
    ev(7, "seat.done", { ok: true }, { seatId: "builder" }),
    ev(8, "review.verdict", { status: "approve" }, { seatId: "reviewer" }),
    ev(9, "round.completed", { round: 1 }),
    ev(10, "gate.result", { passed: false }, { stageId: "verify" }),
    ev(11, "session.warning", { kind: "budget", message: "close to limit" }),
    ev(12, "seat.error", { message: "rate limited upstream" }, { seatId: "reviewer" }),
    ev(125, "session.completed", {}),
  ];
}

function timelineLines(report: string): string[] {
  const section = report.slice(report.indexOf("## Timeline"));
  return section.split("\n").filter((line) => line.startsWith("- `"));
}

describe("renderSessionReport", () => {
  it("renders every section in order with title, times and duration", () => {
    const report = renderSessionReport(fixture());

    const headings = report.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## Outcome",
      "## Seats",
      "## Review verdicts",
      "## Gates",
      "## Warnings and errors",
      "## Timeline",
    ]);
    expect(report).toContain("# `Fix the | login <b>flow</b>`");
    expect(report).toContain(`- Session: \`${SESSION}\``);
    expect(report).toContain("- Started: `2026-01-01T10:00:00.000Z`");
    expect(report).toContain("- Ended: `2026-01-01T10:02:05.000Z`");
    expect(report).toContain("- Duration: 2m 5s");
  });

  it("reports the outcome from the last terminal session event", () => {
    expect(renderSessionReport(fixture())).toContain("## Outcome\n\ncompleted\n");

    const blocked = fixture();
    blocked.push(ev(200, "session.blocked", {}));
    expect(renderSessionReport(blocked)).toContain("## Outcome\n\nblocked\n");

    const running = fixture().filter((event) => event.type !== "session.completed");
    expect(renderSessionReport(running)).toContain("in progress or interrupted");
  });

  it("fills the seats table from the reducer, spawn data and output counts", () => {
    const report = renderSessionReport(fixture());

    expect(report).toContain(
      "| Seat | Provider | Model | Role | Permissions | Final status | Tokens in/out | Output chars |",
    );
    expect(report).toContain(
      "| `Builder` | `mock` | `m-1` | `executor` | `edit` | `done` | `100 / 40` | `18` |",
    );
    expect(report).toContain(
      "| `Reviewer` | `openai` | `m-2` | `reviewer` | `read-only` | `failed` | `0 / 0` | `0` |",
    );
  });

  it("lists verdicts with their round, seat and status, and gates with pass or fail", () => {
    const report = renderSessionReport(fixture());

    expect(report).toContain("- round 1, seat `reviewer`: `approve`");
    expect(report).toContain("- gate `verify`: failed");
  });

  it("marks a panel member's own verdict so it is not read as a second panel verdict", () => {
    const report = renderSessionReport([
      ev(0, "review.verdict", { status: "NEEDS_WORK", panelMember: true }, { seatId: "reviewer-1" }),
      ev(1, "review.verdict", { status: "NEEDS_WORK", policy: "majority" }, { seatId: "panel" }),
    ]);

    expect(report).toContain("- round unknown, seat `reviewer-1` (panel member): `NEEDS_WORK`");
    expect(report).toContain("- round unknown, seat `panel`: `NEEDS_WORK`");
  });

  it("lists warnings and seat errors", () => {
    const report = renderSessionReport(fixture());

    expect(report).toContain("- `budget: close to limit`");
    expect(report).toContain("- `reviewer: rate limited upstream`");
  });

  it("caps the timeline and adds a count line for the rest, skipping output deltas", () => {
    const events = fixture();
    const report = renderSessionReport(events, { maxTimelineLines: 3 });

    const lines = timelineLines(report);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes("seat.output.delta"))).toBe(false);
    // 14 events minus the one output delta is 13 timeline events; 3 are shown.
    expect(report.trimEnd().endsWith("… 10 more events")).toBe(true);
  });

  it("uses 200 timeline lines by default", () => {
    const many: EngineEvent[] = [ev(0, "session.created", { title: "Big" })];
    for (let i = 1; i <= 250; i += 1) {
      many.push(ev(i, "round.started", { round: i }));
    }
    const report = renderSessionReport(many);

    expect(timelineLines(report)).toHaveLength(200);
    expect(report).toContain("… 51 more events");
  });

  it("is deterministic for the same input", () => {
    const first = renderSessionReport(fixture());
    const second = renderSessionReport(fixture());
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("never writes seat output text, only the character count", () => {
    const report = renderSessionReport(fixture());

    expect(report).not.toContain("SECRET_OUTPUT_TEXT");
    expect(report).toContain("`18` |");
  });

  it("redacts secrets found in event data", () => {
    const events = fixture();
    events.push(
      ev(130, "session.warning", { kind: "config", message: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" }),
    );
    const report = renderSessionReport(events);

    expect(report).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(report).toContain("[REDACTED]");
  });

  it("escapes pipes, HTML and headings that come from model text", () => {
    seq = 0;
    const events: EngineEvent[] = [
      ev(0, "session.created", { title: "T" }),
      ev(1, "seat.spawned", {
        displayName: "Evil",
        provider: "p",
        transport: "cli",
        model: "m",
        role: "a|b",
        permissions: "read-only",
      }, { seatId: "evil" }),
      ev(2, "session.warning", { kind: "warn", message: "x | <script>y</script>\n# heading `tick`" }),
      ev(3, "session.completed", {}),
    ];
    const report = renderSessionReport(events);

    // Table cell: the pipe is escaped so it cannot split the row.
    expect(report).toContain("| `a\\|b` |");
    // Issue line: one code span on one line, so HTML is literal and `# heading` cannot start a line.
    expect(report).toContain("- `warn: x | <script>y</script> # heading ʼtickʼ`");
    expect(report.split("\n").some((line) => line.startsWith("# heading"))).toBe(false);
    expect(report.split("\n").some((line) => line.startsWith("<script"))).toBe(false);
  });

  it("refuses an empty event list", () => {
    expect(() => renderSessionReport([])).toThrow(/without events/);
  });
});

describe("saveSessionReport", () => {
  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-report-"));
    dirs.push(dir);
    return dir;
  }

  it("refuses to overwrite an existing file without force", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "report.md");
    await fs.writeFile(file, "original", "utf8");

    await expect(saveSessionReport(file, "new")).rejects.toBeInstanceOf(ReportExistsError);
    expect(await fs.readFile(file, "utf8")).toBe("original");
  });

  it("replaces the file with force, and writes a new file without it", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "report.md");

    await saveSessionReport(file, "first");
    expect(await fs.readFile(file, "utf8")).toBe("first");

    await saveSessionReport(file, "second", { force: true });
    expect(await fs.readFile(file, "utf8")).toBe("second");
  });
});

/** Codepoints a terminal or a bidi-aware viewer would act on, as in the code() filter. */
const UNSAFE_CODEPOINT =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/;

describe("terminal and spoofing safety", () => {
  it("drops escape sequences, bidi overrides and NUL from every event-derived field", () => {
    seq = 0;
    const events: EngineEvent[] = [
      ev(0, "session.created", { title: "Build\x1b[31m ‮ evil \u0000 end" }),
      ev(1, "seat.error", { message: "boom\x1b[2J\x1b]52;c;ZGF0YQ==\x07 ‮reversed" }, { seatId: "s1" }),
      ev(2, "session.warning", { kind: "clip\x1b[31m", message: "‮ \u0000 hidden" }),
      ev(3, "session.completed", {}),
    ];
    const report = renderSessionReport(events);

    const unsafe = [...report].filter((ch) => UNSAFE_CODEPOINT.test(ch));
    expect(unsafe).toEqual([]);
    expect(report).not.toContain("\x1b");
    expect(report).not.toContain("‮");
    expect(report).not.toContain("\u0000");
    // The text around the removed characters is kept.
    expect(report).toContain("# `Build [31m   evil   end`");
    expect(report).toContain("- `clip [31m:");
    expect(report).toContain("hidden`");
  });

  it("redacts bare sk- tokens and Bearer tokens in the title and seat errors", () => {
    seq = 0;
    const events: EngineEvent[] = [
      ev(0, "session.created", { title: "Use sk-abcdefghijklmnopqrstuvwxyz012345 now" }),
      ev(1, "seat.error", { message: "auth failed with Bearer abc.def-ghi_123/jkl==" }, { seatId: "s1" }),
      ev(2, "session.completed", {}),
    ];
    const report = renderSessionReport(events);

    expect(report).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(report).not.toContain("abc.def-ghi_123");
    expect(report).toContain("# `Use [REDACTED] now`");
    expect(report).toContain("[REDACTED]");
  });

  it("redacts a secret that has a zero-width space inside it", () => {
    seq = 0;
    const events: EngineEvent[] = [
      ev(0, "session.created", { title: "Use sk-ab\u200Bcdefghijklmnopqrstuvwxyz0123 now" }),
      ev(1, "seat.error", { message: "bad key sk-x\u2060y\uFEFFzabcdefghijklmnopqrstuv" }, { seatId: "s1" }),
      ev(2, "session.completed", {}),
    ];
    const report = renderSessionReport(events);

    expect(report).toContain("# `Use [REDACTED] now`");
    expect(report).not.toContain("cdefghijklmnop");
    expect(report).not.toContain("zabcdefghijklmnop");
    expect(report).toContain("[REDACTED]");
  });

  it("cuts a long value to 500 characters plus an ellipsis", () => {
    seq = 0;
    const message = "a".repeat(2000);
    const events: EngineEvent[] = [
      ev(0, "session.created", { title: "Long" }),
      ev(1, "session.warning", { kind: "warn", message }),
      ev(2, "session.completed", {}),
    ];
    const report = renderSessionReport(events);

    const value = `warn: ${message}`;
    expect(report).toContain(`- \`${value.slice(0, 500)}…\``);
    expect(report).not.toContain("a".repeat(495));
  });
});

describe("saveSessionReport missing directory", () => {
  it("names the missing directory instead of a bare ENOENT", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-report-missing-"));
    dirs.push(dir);
    const missing = path.join(dir, "no-such-dir");

    await expect(saveSessionReport(path.join(missing, "r.md"), "x")).rejects.toThrow(
      `Directory does not exist: ${missing}`,
    );
  });
});
