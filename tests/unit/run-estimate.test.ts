import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parseAssentorConfig } from "../../packages/engine/src/config/schema.js";
import { estimateRun } from "../../packages/engine/src/estimate/cost.js";
import { readSessionUsage } from "../../packages/engine/src/usage/read.js";
import { UsageLedger } from "../../packages/engine/src/usage/ledger.js";
import { runAssentorTask } from "../../packages/cli/src/cli/commands.js";
import { formatUsageLine } from "../../packages/cli/src/cli/usage.js";
import { confirmRunEstimate, formatRunEstimate, toRunEstimate } from "../../packages/cli/src/cli/run-estimate.js";
import type { QuestionIO } from "../../packages/cli/src/cli/mode-questions.js";
import type { EngineEvent } from "../../packages/protocol/src/events.js";

// Pre-run estimate and confirm (TE-09). The prompt "goal" is 1 token, so each
// turn sends 2_001 input tokens. One mock reviewer, maxRounds 3:
// low 1 × 2_001 + 1_500 = 3_501; high 3 × 2_001 + 3 × 4_000 = 18_003.

const CONFIG = {
  reviewers: [{ provider: "mock" }],
  limits: { maxRounds: 3 },
};

/** Collects what a run prints to the console or stdout (mocked). */
async function captureOutput<T>(run: () => Promise<T>): Promise<{ value: T; text: string }> {
  const chunks: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    chunks.push(`${args.map(String).join(" ")}\n`);
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    return { value: await run(), text: chunks.join("") };
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
}

/** A terminal that answers the first prompt containing "Start the run?" with `answer`. */
function terminal(answer: string): QuestionIO & { asked: string[] } {
  const input = new PassThrough();
  const asked: string[] = [];
  const output = new Writable({
    write(chunk, _enc, done) {
      const text = String(chunk);
      asked.push(text);
      if (text.includes("Start the run?")) setImmediate(() => input.write(`${answer}\n`));
      done();
    },
  });
  return { input, output, interactive: true, asked };
}

const NO_TTY: QuestionIO = { input: new PassThrough(), output: new Writable({ write: (_c, _e, d) => d() }), interactive: false };

describe("pre-run estimate line", () => {
  it("solo: one line with tokens, cost status, team, seats and rounds", () => {
    const config = parseAssentorConfig(CONFIG);
    const estimate = estimateRun(config, "goal", "solo");
    expect(estimate.totalLow).toBe(3_501);
    expect(estimate.totalHigh).toBe(18_003);
    expect(formatRunEstimate(estimate, config, "solo")).toBe(
      "Estimate: 3,501–18,003 tokens, cost not estimated (no pricing) · solo · legacy reviewers · 1 seat · review rounds 1–3 · profile balanced",
    );
  });

  it("negotiate mode adds the negotiate team's turns; other modes keep the review estimate", () => {
    const config = parseAssentorConfig({
      ...CONFIG,
      teams: { panel: { seats: [{ provider: "mock", count: 2 }] } },
      modes: { negotiate: { team: "panel", strategy: "debate", maxRounds: 3, consensus: 0.7 } },
    });
    const solo = estimateRun(config, "goal", "solo");
    const negotiate = estimateRun(config, "goal", "negotiate");
    const lead = estimateRun(config, "goal", "lead");
    expect(negotiate.totalHigh).toBeGreaterThan(solo.totalHigh);
    expect(lead.totalHigh).toBe(solo.totalHigh);
    expect(formatRunEstimate(negotiate, config, "mode negotiate")).toMatch(
      /^Estimate: [\d,]+–[\d,]+ tokens, cost not estimated \(no pricing\) · mode negotiate · legacy reviewers · \d+ seats · review rounds 1–3 · profile balanced$/,
    );
  });
});

describe("confirmRunEstimate", () => {
  const big = estimateRun(parseAssentorConfig(CONFIG), "goal", "solo");

  it("passes silently when under every limit", async () => {
    await expect(
      confirmRunEstimate({ estimate: big, limits: { maxRounds: 3, maxMessages: 50, maxToolCalls: 200, maxRuntimeMinutes: 120, concurrency: {}, globalConcurrency: 6, session: {}, confirmAboveTokens: 100_000 }, io: NO_TTY, log: () => undefined }),
    ).resolves.toBeUndefined();
  });

  it("refuses over the limit without a terminal, and says how to proceed", async () => {
    const limits = parseAssentorConfig({ limits: { confirmAboveTokens: 1_000 } }).limits;
    await expect(confirmRunEstimate({ estimate: big, limits, io: NO_TTY, log: () => undefined })).rejects.toThrow(
      "Re-run with --yes",
    );
  });

  it("--yes skips the question and logs that it did", async () => {
    const limits = parseAssentorConfig({ limits: { confirmAboveTokens: 1_000 } }).limits;
    const lines: string[] = [];
    await confirmRunEstimate({ estimate: big, limits, yes: true, io: NO_TTY, log: (line) => lines.push(line) });
    expect(lines).toEqual([expect.stringContaining("starting anyway (--yes)")]);
  });

  it("asks on a terminal: yes starts, anything else cancels", async () => {
    const limits = parseAssentorConfig({ limits: { confirmAboveTokens: 1_000 } }).limits;
    const yes = terminal("y");
    await expect(confirmRunEstimate({ estimate: big, limits, io: yes, log: () => undefined })).resolves.toBeUndefined();
    expect(yes.asked.join("")).toContain("Start the run? [y/N]");

    await expect(
      confirmRunEstimate({ estimate: big, limits, io: terminal("n"), log: () => undefined }),
    ).rejects.toThrow("Run cancelled before it started.");
  });
});

describe("config limits", () => {
  it("confirmAbove* are optional with no defaults, and round-trip when set", () => {
    const bare = parseAssentorConfig({}).limits;
    expect(bare).not.toHaveProperty("confirmAboveTokens");
    expect(bare).not.toHaveProperty("confirmAboveUsd");
    const set = parseAssentorConfig({ limits: { confirmAboveTokens: 5_000, confirmAboveUsd: 2 } }).limits;
    expect(set).toMatchObject({ confirmAboveTokens: 5_000, confirmAboveUsd: 2 });
  });
});

describe("usage report carries the estimate", () => {
  it("the ledger keeps the session.estimate event and the usage line shows it", () => {
    const ledger = new UsageLedger("s1");
    ledger.add({
      type: "session.estimate",
      sessionId: "s1",
      seq: 1,
      at: "2026-11-01T10:00:00.000Z",
      data: toRunEstimate(estimateRun(parseAssentorConfig(CONFIG), "goal", "solo")),
    } as EngineEvent);
    const report = ledger.snapshot();
    expect(report.estimate).toEqual({ tokens: { low: 3_501, high: 18_003 } });
    expect(formatUsageLine(report)).toBe(
      "Usage: no token counts reported by these seats · estimate 3,501–18,003 tokens",
    );
  });
});

describe("run gate end to end", () => {
  let projectDir: string;
  let userDir: string;
  const savedUserDir = process.env.ASSENTOR_USER_DIR;
  const LIMITED = [
    "git:",
    "  checkpoints: false",
    "executor:",
    "  provider: mock",
    "teams:",
    "  panel:",
    "    seats:",
    "      - provider: mock",
    "        count: 2",
    "limits:",
    "  confirmAboveTokens: 1000",
    "",
  ].join("\n");

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-estimate-"));
    userDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-estimate-user-"));
    process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
    await fs.mkdir(path.join(projectDir, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(projectDir, ".assentor", "config.yaml"), LIMITED, "utf8");
  });

  afterEach(async () => {
    if (savedUserDir === undefined) delete process.env.ASSENTOR_USER_DIR;
    else process.env.ASSENTOR_USER_DIR = savedUserDir;
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(userDir, { recursive: true, force: true });
  });

  it("solo over the limit without a terminal is refused before any task is recorded", async () => {
    await expect(
      runAssentorTask({ projectPath: projectDir, prompt: "goal", team: "panel", skipPreflight: true, skipGates: true, confirmIO: NO_TTY }),
    ).rejects.toThrow("Re-run with --yes");
    await expect(fs.stat(path.join(projectDir, ".assentor", "tasks"))).rejects.toThrow();
  });

  it("a --mode run over the limit without a terminal is refused too", async () => {
    await fs.writeFile(
      path.join(projectDir, ".assentor", "config.yaml"),
      LIMITED.replace("limits:", "modes:\n  negotiate:\n    team: panel\n    strategy: debate\n    maxRounds: 2\n    consensus: 0.7\nlimits:"),
      "utf8",
    );
    await expect(
      runAssentorTask({ projectPath: projectDir, prompt: "goal", modeId: "negotiate", skipPreflight: true, confirmIO: NO_TTY }),
    ).rejects.toThrow("Re-run with --yes");
  });

  it("solo on a terminal: a 'no' cancels before the run starts", async () => {
    await expect(
      runAssentorTask({ projectPath: projectDir, prompt: "goal", team: "panel", skipPreflight: true, skipGates: true, confirmIO: terminal("n") }),
    ).rejects.toThrow("Run cancelled before it started.");
  });

  it("--yes runs, prints the estimate line, and the usage report carries the estimate", async () => {
    const { value, text } = await captureOutput(() =>
      runAssentorTask({ projectPath: projectDir, prompt: "goal", team: "panel", skipPreflight: true, skipGates: true, yes: true, confirmIO: NO_TTY }),
    );
    expect(value.result.status).toBe("DONE");
    expect(text).toContain("Estimate: ");
    expect(text).toContain("starting anyway (--yes)");

    const report = await readSessionUsage(projectDir, value.result.taskId);
    expect(report.estimate?.tokens.high).toBeGreaterThan(1_000);
  });
});
