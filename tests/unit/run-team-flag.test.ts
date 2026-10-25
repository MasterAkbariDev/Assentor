import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAssentorConfig } from "../../src/config/schema.js";
import { EventLog, type EngineEvent } from "../../src/index.js";
import { parseEngineEvent } from "../../src/protocol/events.js";
import {
  assertReviewerOrTeam,
  doctorAssentor,
  runAssentorTask,
  withReviewTeam,
} from "../../src/cli/commands.js";
import { RunReporter } from "../../src/cli/ui/reporter.js";

const TEAM_CONFIG = [
  "git:",
  "  checkpoints: false",
  "executor:",
  "  provider: mock",
  "teams:",
  "  panel:",
  "    seats:",
  "      - provider: mock",
  "        count: 2",
  "",
].join("\n");

/** Collects everything the run prints to the console or stdout. */
async function captureOutput<T>(run: () => Promise<T>): Promise<{ value: T; text: string }> {
  const chunks: string[] = [];
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      chunks.push(`${args.map(String).join(" ")}\n`);
    });
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
  try {
    const value = await run();
    return { value, text: chunks.join("") };
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
}

/** Columns a line takes in a terminal: 🛠, ⏳ and ⏸ take two, the rest one. */
function displayWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    width += cp >= 0x1f000 || (cp >= 0x23e9 && cp <= 0x23fa) ? 2 : 1;
  }
  return width;
}

function withColumns<T>(columns: number, run: () => T): T {
  const before = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  try {
    return run();
  } finally {
    if (before) {
      Object.defineProperty(process.stdout, "columns", before);
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
  }
}

describe("run/resume --team and --reviewer", () => {
  it("rejects --reviewer together with --team before anything runs", () => {
    expect(() => assertReviewerOrTeam({ reviewer: "mock", team: "panel" })).toThrow(
      "Use either --reviewer or --team, not both.",
    );
    expect(() => assertReviewerOrTeam({ reviewer: "mock" })).not.toThrow();
    expect(() => assertReviewerOrTeam({ team: "panel" })).not.toThrow();
  });

  it("runAssentorTask rejects the combination before reading the project", async () => {
    await expect(
      runAssentorTask({
        projectPath: "/does/not/exist",
        prompt: "goal",
        reviewer: "mock",
        team: "panel",
      }),
    ).rejects.toThrow("Use either --reviewer or --team, not both.");
  });

  it("withReviewTeam sets modes.review.team and returns a new config", () => {
    const config = parseAssentorConfig({
      teams: { panel: { seats: [{ provider: "mock", count: 2 }] } },
    });
    const next = withReviewTeam(config, "panel");

    expect(next.modes.review).toMatchObject({ team: "panel", policy: "security-veto" });
    expect(next).not.toBe(config);
    expect(config.modes.review).toBeUndefined();
  });

  it("withReviewTeam keeps the policy of an existing modes.review", () => {
    const config = parseAssentorConfig({
      teams: {
        a: { seats: [{ provider: "mock" }] },
        b: { seats: [{ provider: "mock" }] },
      },
      modes: { review: { team: "a", policy: "unanimous" } },
    });
    expect(withReviewTeam(config, "b").modes.review).toMatchObject({
      team: "b",
      policy: "unanimous",
    });
  });

  it("an unknown team fails with the resolveTeams message", () => {
    const config = parseAssentorConfig({
      teams: { panel: { seats: [{ provider: "mock" }] } },
    });
    expect(() => withReviewTeam(config, "nope")).toThrow(
      'Unknown team "nope" in modes.review. Defined teams: panel',
    );
  });
});

describe("run --team end to end", () => {
  let projectDir: string;
  let userDir: string;
  const savedUserDir = process.env.ASSENTOR_USER_DIR;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-team-"));
    userDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-team-user-"));
    process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
    await fs.mkdir(path.join(projectDir, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(projectDir, ".assentor", "config.yaml"), TEAM_CONFIG, "utf8");
  });

  afterEach(async () => {
    if (savedUserDir === undefined) {
      delete process.env.ASSENTOR_USER_DIR;
    } else {
      process.env.ASSENTOR_USER_DIR = savedUserDir;
    }
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(userDir, { recursive: true, force: true });
  });

  it("an unknown --team fails before the executor starts, with no task recorded", async () => {
    await expect(
      runAssentorTask({
        projectPath: projectDir,
        prompt: "goal",
        team: "nope",
        skipPreflight: true,
        skipGates: true,
      }),
    ).rejects.toThrow('Unknown team "nope" in modes.review. Defined teams: panel');
    await expect(fs.stat(path.join(projectDir, ".assentor", "tasks"))).rejects.toThrow();
  });

  it("--team runs a two-seat mock team: both seats spawn and the Review seats section prints", async () => {
    const { value, text } = await captureOutput(() =>
      runAssentorTask({
        projectPath: projectDir,
        prompt: "goal",
        team: "panel",
        skipPreflight: true,
        skipGates: true,
      }),
    );

    const events = await (await EventLog.open(projectDir, value.result.taskId)).readFrom(0);
    const spawned = events.filter((e) => e.type === "seat.spawned");
    expect(spawned.map((e) => (e.data as { displayName: string }).displayName)).toEqual(
      expect.arrayContaining(["Mock#1", "Mock#2"]),
    );

    // The section's rows follow its header: one per reviewer seat, each done.
    const header = text.indexOf("▸ Review seats");
    expect(header).toBeGreaterThan(-1);
    const rows = text
      .slice(header)
      .split("\n")
      .slice(1, 3);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("OK  done");
    expect(rows[0]).toContain("Mock#1");
    expect(rows[1]).toContain("OK  done");
    expect(rows[1]).toContain("Mock#2");
  });

  it("a single-reviewer run prints the same output with and without a seat listener", async () => {
    await fs.writeFile(
      path.join(projectDir, ".assentor", "config.yaml"),
      "git:\n  checkpoints: false\nexecutor:\n  provider: mock\nreviewers:\n  - provider: mock\n",
      "utf8",
    );

    const runOnce = async (listener: boolean) => {
      const { value, text } = await captureOutput(() =>
        runAssentorTask({
          projectPath: projectDir,
          prompt: "goal",
          skipPreflight: true,
          skipGates: true,
          ...(listener ? { onEngineEvent: () => {} } : {}),
        }),
      );
      // Task ids and timings differ between runs; everything else must match.
      return text
        .split(value.result.taskId)
        .join("<task>")
        .replace(/\b\d+:\d{2}\b/g, "<time>");
    };

    const without = await runOnce(false);
    const withListener = await runOnce(true);

    expect(without).not.toContain("Review seats");
    expect(withListener).toBe(without);
  });
});

describe("RunReporter review seats", () => {
  const at = "2026-10-24T10:00:00.000Z";
  const later = "2026-10-24T10:00:12.000Z";
  let seq = 0;

  function event(type: string, seatId: string | undefined, data: Record<string, unknown>, when = at): EngineEvent {
    seq += 1;
    return parseEngineEvent({
      seq,
      sessionId: "s1",
      ...(seatId ? { seatId } : {}),
      type,
      data,
      at: when,
    });
  }

  function reviewerSeat(index: number, name: string, role: string) {
    return [
      event("seat.spawned", `reviewer-${index}`, {
        displayName: name,
        provider: "claude-code",
        transport: "cli",
        model: "opus",
        role,
        permissions: "read-only",
      }),
      event("seat.status", `reviewer-${index}`, { status: "thinking", detail: "reading the diff" }),
      event("seat.status", `reviewer-${index}`, { status: "done" }, later),
      event("seat.done", `reviewer-${index}`, { ok: true, summary: "no blocking findings in the diff" }, later),
    ];
  }

  it("prints one line per reviewer seat, each within the terminal width", () => {
    const reporter = new RunReporter({ executorName: "executor", reviewerName: "reviewer" });
    for (const e of [...reviewerSeat(1, "Opus#1", "security"), ...reviewerSeat(2, "Opus#2", "architecture")]) {
      reporter.onEngineEvent(e);
    }

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      withColumns(40, () => reporter.printReviewSeats());
    } finally {
      spy.mockRestore();
    }

    const seatLines = lines.filter((line) => line.includes("Opus#"));
    expect(seatLines).toHaveLength(2);
    for (const line of seatLines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(39);
    }
    expect(seatLines[0]).toContain("Opus#1");
    expect(seatLines[0]).toContain("OK  done");
  });

  it("prints nothing for a single reviewer seat", () => {
    const reporter = new RunReporter({ executorName: "executor", reviewerName: "reviewer" });
    for (const e of reviewerSeat(1, "Opus#1", "security")) {
      reporter.onEngineEvent(e);
    }
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      reporter.printReviewSeats();
      expect(spy).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      write.mockRestore();
    }
  });

  it("ignores events from seats that are not reviewers", () => {
    const reporter = new RunReporter({ executorName: "executor", reviewerName: "reviewer" });
    reporter.onEngineEvent(
      event("seat.spawned", "executor", {
        displayName: "Executor",
        provider: "mock",
        transport: "api",
        model: "AUTO",
        role: "engineer",
        permissions: "edit",
      }),
    );
    reporter.onEngineEvent(
      event("seat.spawned", "panel", {
        displayName: "Review panel",
        provider: "panel",
        transport: "api",
        model: "AUTO",
        role: "panel",
        permissions: "read-only",
      }),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      reporter.printReviewSeats();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("doctor Teams section", () => {
  it("lists each team seat with a binary check for CLI seats only", async () => {
    const config = parseAssentorConfig({
      teams: {
        panel: {
          seats: [
            { provider: "claude-code", transport: "cli", count: 1, permissions: "read-only" },
            { provider: "codex", transport: "cli", count: 1, permissions: "read-only" },
            { provider: "gemini", transport: "api", count: 1, permissions: "read-only" },
          ],
        },
      },
    });
    const located: string[] = [];
    const lines = await doctorAssentor({
      config,
      locate: (provider) => {
        located.push(provider);
        return provider === "claude";
      },
    });

    const start = lines.indexOf("Teams");
    expect(start).toBeGreaterThan(-1);
    expect(lines[start + 1]).toBe("  panel");
    const seatLines = lines.slice(start + 2).filter((line) => line.startsWith("    "));
    expect(seatLines).toHaveLength(3);
    expect(seatLines[0]).toMatch(/ · claude-code\/cli · AUTO · read-only · ✓$/);
    expect(seatLines[1]).toMatch(/ · codex\/cli · AUTO · read-only · ✗$/);
    expect(seatLines[2]).toMatch(/ · gemini\/api · AUTO · read-only · api$/);
    // Only the two CLI seats are probed; the API seat never is.
    expect(located).toEqual(["claude", "codex"]);
  });

  it("has no Teams section when no teams are configured", async () => {
    const lines = await doctorAssentor({ config: parseAssentorConfig({}), locate: () => true });
    expect(lines).not.toContain("Teams");
  });
});
