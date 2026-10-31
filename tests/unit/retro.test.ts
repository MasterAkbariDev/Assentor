import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEngineEvent, type EngineEvent } from "../../src/protocol/events.js";
import { PromptLibrary } from "../../src/prompts/library.js";
import {
  LESSONS_PATH,
  appendLessons,
  buildRetroInput,
  retroVariables,
  scoreboardRows,
} from "../../src/modes/retro.js";

const SESSION = "5f0c8a52-1b7e-4d2a-9c3e-0a1b2c3d4e5f";
const TEMP_ROOT = path.join(process.cwd(), ".tmp", "retro-tests");
const tempDirs: string[] = [];

let seq = 0;
const BASE = Date.parse("2026-10-30T10:00:00.000Z");

/** Builds a validated event; `t` is seconds after the session start. */
function ev(t: number, type: string, data: Record<string, unknown>, seatId?: string): EngineEvent {
  return parseEngineEvent({
    seq: ++seq,
    sessionId: SESSION,
    seatId,
    at: new Date(BASE + t * 1000).toISOString(),
    type,
    data,
  });
}

const spawn = (t: number, seatId: string, provider: string, model: string, role: string) =>
  ev(t, "seat.spawned", {
    displayName: `${role} ${seatId}`,
    provider,
    transport: "cli",
    model,
    role,
    permissions: "edit",
  }, seatId);

/** A full session: one task escalated from opus-a to opus-b, one rejected once. */
function completedStream(): EngineEvent[] {
  seq = 0;
  return [
    ev(0, "session.created", { title: "Add retry budget to the queue" }),
    spawn(1, "s1", "claude", "opus-a", "engineer"),
    spawn(1, "s2", "codex", "mini", "reviewer"),
    ev(2, "task.assigned", { taskId: "T1", seatId: "s1" }),
    ev(3, "seat.tokens", { tokensIn: 1000, tokensOut: 200 }, "s1"),
    ev(4, "seat.error", { message: "stopped after API_KEY=hunter2 leaked in the log" }, "s1"),
    ev(5, "task.rejected", { taskId: "T1", reason: "tests not run" }),
    ev(6, "task.escalated", { taskId: "T1", from: "claude/opus-a", to: "claude/opus-b" }),
    spawn(7, "s3", "claude", "opus-b", "engineer"),
    ev(8, "task.assigned", { taskId: "T1", seatId: "s3" }),
    ev(9, "task.accepted", { taskId: "T1" }),
    ev(10, "task.accepted", { taskId: "T9" }),
    ev(200, "session.completed", {}),
  ];
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeProject(): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
  tempDirs.push(dir);
  return dir;
}

describe("buildRetroInput", () => {
  it("records each seat's model, role, accepted and rejected tasks, and escalations", () => {
    const input = buildRetroInput(completedStream());

    expect(input.goal).toBe("Add retry budget to the queue");
    expect(input.outcome).toEqual({ status: "completed" });
    expect(input.seats).toEqual([
      {
        provider: "claude",
        model: "opus-a",
        role: "engineer",
        accepted: 0,
        rejected: 1,
        escalatedFrom: 1,
        escalatedTo: 0,
        verdicts: [],
        failures: ["stopped after [REDACTED] leaked in the log"],
      },
      {
        provider: "codex",
        model: "mini",
        role: "reviewer",
        accepted: 0,
        rejected: 0,
        escalatedFrom: 0,
        escalatedTo: 0,
        verdicts: [],
        failures: [],
      },
      {
        provider: "claude",
        model: "opus-b",
        role: "engineer",
        accepted: 1,
        rejected: 0,
        escalatedFrom: 0,
        escalatedTo: 1,
        verdicts: [],
        failures: [],
      },
    ]);
  });

  it("totals the session duration and the recorded tokens", () => {
    const input = buildRetroInput(completedStream());
    expect(input.sessionTotals).toBe("duration 3m 20s; tokens in 1000, out 200");
  });

  it("a failed session keeps the failure reason and the seat's error", () => {
    seq = 0;
    const input = buildRetroInput([
      ev(0, "session.created", { title: "Fix the parser" }),
      spawn(1, "s1", "claude", "opus-a", "engineer"),
      ev(30, "seat.error", { message: "provider timed out" }, "s1"),
      ev(60, "session.failed", { message: "gate failed: pnpm test exited 1" }),
    ]);

    expect(input.outcome).toEqual({ status: "failed", reason: "gate failed: pnpm test exited 1" });
    expect(input.seats).toHaveLength(1);
    expect(input.seats[0]).toMatchObject({ model: "opus-a", failures: ["provider timed out"] });
    expect(input.sessionTotals).toBe("duration 1m 0s");
  });

  it("a seat that finished without success records a failure", () => {
    seq = 0;
    const input = buildRetroInput([
      spawn(0, "s1", "claude", "opus-a", "engineer"),
      ev(1, "seat.done", { ok: false, summary: "exit 2" }, "s1"),
      ev(2, "session.blocked", { reason: "review asked for changes" }),
    ]);
    expect(input.outcome).toEqual({ status: "blocked", reason: "review asked for changes" });
    expect(input.seats[0]!.failures).toEqual(["exit 2"]);
  });

  it("an empty session gives no seats, an unfinished outcome and no totals", () => {
    const input = buildRetroInput([]);

    expect(input).toEqual({
      goal: "not recorded",
      outcome: { status: "unfinished" },
      seats: [],
      sessionTotals: "not recorded",
    });
    expect(scoreboardRows(input)).toEqual([]);
  });

  it("the built-in retro prompt renders from the input", () => {
    const body = PromptLibrary.loadBuiltinSync().render("retro", retroVariables(buildRetroInput(completedStream())));

    expect(body).toContain("opus-b as engineer: accepted 1, rejected 0, escalations 0");
    expect(body).toContain("opus-a as engineer: accepted 0, rejected 1, escalations 1");
    expect(body).toContain("duration 3m 20s; tokens in 1000, out 200");
    expect(body).not.toContain("hunter2");
  });

  it("the built-in retro prompt renders an empty session", () => {
    const body = PromptLibrary.loadBuiltinSync().render("retro", retroVariables(buildRetroInput([])));
    expect(body).toContain("not recorded");
  });

  it("a pending model change does not replace the seat's model; a settled one does", () => {
    seq = 0;
    const input = buildRetroInput([
      spawn(0, "s1", "claude", "opus-a", "engineer"),
      ev(1, "seat.model.changed", { to: "opus-b", pending: true }, "s1"),
    ]);
    expect(input.seats[0]).toMatchObject({ provider: "claude", model: "opus-a" });

    seq = 0;
    const settled = buildRetroInput([
      spawn(0, "s1", "claude", "opus-a", "engineer"),
      ev(1, "seat.model.changed", { to: "opus-b", pending: true }, "s1"),
      ev(2, "seat.model.changed", { to: "opus-c", pending: false }, "s1"),
    ]);
    expect(settled.seats[0]).toMatchObject({ model: "opus-c" });
  });

  it("records review verdicts from the reviewer seat and from a Lead task, and change requests", () => {
    seq = 0;
    const input = buildRetroInput([
      spawn(0, "s1", "claude", "opus-a", "engineer"),
      spawn(1, "s2", "codex", "mini", "reviewer"),
      ev(2, "task.assigned", { taskId: "T1", seatId: "s1" }),
      ev(3, "review.verdict", { status: "NEEDS_WORK", summary: "tests missing" }, "s2"),
      ev(4, "review.changes_requested", { reason: "rename the helper" }, "s2"),
      ev(5, "review.verdict", { status: "PASS", taskId: "T1" }),
    ]);

    expect(input.seats.find((seat) => seat.model === "mini")!.verdicts).toEqual([
      "NEEDS_WORK: tests missing",
      "changes requested: rename the helper",
    ]);
    expect(input.seats.find((seat) => seat.model === "opus-a")!.verdicts).toEqual(["PASS"]);
  });

  it("drops format characters and turns controls into spaces before redaction", () => {
    seq = 0;
    const input = buildRetroInput([
      ev(0, "session.created", { title: "Bidi ‮goal" }),
      spawn(1, "s1", "claude", "opus-a", "engineer"),
      ev(2, "seat.error", { message: "\x1b[31mred\x1b[0m sk-​abcdefghijklmnopqrstuvwxyz" }, "s1"),
    ]);

    expect(input.goal).toBe("Bidi goal");
    expect(input.seats[0]!.failures).toEqual(["[31mred [0m [REDACTED]"]);
  });

  it("bounds the provider, model and role to 80 characters", () => {
    const long = "p".repeat(200);
    seq = 0;
    const input = buildRetroInput([spawn(0, "s1", long, long, long)]);
    expect(input.seats[0]!.provider.length).toBeLessThanOrEqual(80);
    expect(input.seats[0]!.model.length).toBeLessThanOrEqual(80);
    expect(input.seats[0]!.role.length).toBeLessThanOrEqual(80);
  });

  it("keeps five failures per seat and says how many more there were", () => {
    seq = 0;
    const errors = Array.from({ length: 7 }, (_, i) => ev(i + 1, "seat.error", { message: `error ${i + 1}` }, "s1"));
    const input = buildRetroInput([spawn(0, "s1", "claude", "opus-a", "engineer"), ...errors]);
    expect(input.seats[0]!.failures).toEqual([
      "error 1",
      "error 2",
      "error 3",
      "error 4",
      "error 5",
      "+2 more",
    ]);
  });
});

describe("scoreboardRows", () => {
  it("returns one row per seat with the counts the scoreboard needs", () => {
    expect(scoreboardRows(buildRetroInput(completedStream()))).toEqual([
      { provider: "claude", model: "opus-a", role: "engineer", accepted: 0, rejected: 1, escalatedFrom: 1, escalatedTo: 0 },
      { provider: "codex", model: "mini", role: "reviewer", accepted: 0, rejected: 0, escalatedFrom: 0, escalatedTo: 0 },
      { provider: "claude", model: "opus-b", role: "engineer", accepted: 1, rejected: 0, escalatedFrom: 0, escalatedTo: 1 },
    ]);
  });
});

describe("appendLessons", () => {
  it("creates the lessons file, ignores .assentor, and appends a dated section", async () => {
    const project = await makeProject();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));

    const first = await appendLessons(project, SESSION, [
      "Worked: small owned paths let parallel tasks finish without conflicts.",
      "Failed: review rejected a task whose report claimed tests ran.",
    ]);
    expect(first).toBe(true);

    vi.setSystemTime(new Date("2026-10-31T09:00:00.000Z"));
    await appendLessons(project, SESSION, ["- Model: the low-cost seat missed a parser boundary."]);

    const text = await fs.readFile(path.join(project, LESSONS_PATH), "utf8");
    expect(text).toBe(
      [
        `## 2026-10-30 · session ${SESSION}`,
        "- Worked: small owned paths let parallel tasks finish without conflicts.",
        "- Failed: review rejected a task whose report claimed tests ran.",
        "",
        `## 2026-10-31 · session ${SESSION}`,
        "- Model: the low-cost seat missed a parser boundary.",
        "",
      ].join("\n"),
    );

    const gitignore = await fs.readFile(path.join(project, ".gitignore"), "utf8");
    expect(gitignore).toContain(".assentor/");

    const leftovers = (await fs.readdir(path.dirname(path.join(project, LESSONS_PATH)))).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("redacts secrets and keeps each lesson on one line", async () => {
    const project = await makeProject();
    await appendLessons(project, SESSION, ["Failed: the job echoed sk-abcdefghijklmnopqrstuvwxyz\nthen stopped."]);

    const text = await fs.readFile(path.join(project, LESSONS_PATH), "utf8");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("- Failed: the job echoed [REDACTED] then stopped.");
  });

  it("strips terminal escapes and bidi overrides from lessons", async () => {
    const project = await makeProject();
    await appendLessons(project, SESSION, ["Failed: \x1b[31ma‮b\x1b[0m"]);

    const text = await fs.readFile(path.join(project, LESSONS_PATH), "utf8");
    expect(text).not.toMatch(/[\x1b‮]/);
    expect(text).toContain("- Failed: [31mab [0m");
  });

  it("writes nothing for an empty session with no lessons", async () => {
    const project = await makeProject();
    const wrote = await appendLessons(project, SESSION, ["", "   "]);

    expect(wrote).toBe(false);
    await expect(fs.access(path.join(project, LESSONS_PATH))).rejects.toThrow();
  });

  it("refuses a session id that is not a UUID, and writes nothing", async () => {
    const project = await makeProject();
    await expect(appendLessons(project, "../escape", ["Worked: one."])).rejects.toThrow(/Invalid session id/);
    await expect(fs.access(path.join(project, LESSONS_PATH))).rejects.toThrow();
  });

  it("removes the temp file and rethrows when the rename fails", async () => {
    const project = await makeProject();
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));

    await expect(appendLessons(project, SESSION, ["Worked: one."])).rejects.toThrow("disk full");
    const leftovers = (await fs.readdir(path.dirname(path.join(project, LESSONS_PATH)))).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("refuses a lessons file that is a symlink, and leaves the target alone", async () => {
    const project = await makeProject();
    const outside = path.join(project, "outside.txt");
    await fs.writeFile(outside, "private\n", "utf8");
    await fs.mkdir(path.dirname(path.join(project, LESSONS_PATH)), { recursive: true });
    await fs.symlink(outside, path.join(project, LESSONS_PATH));

    await expect(appendLessons(project, SESSION, ["Worked: one."])).rejects.toThrow(/symbolic link/);
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");
  });
});
