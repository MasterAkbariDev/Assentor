import { describe, expect, it } from "vitest";
import {
  AGENT_REPORT_STATUSES,
  MAX_REPORT_SCAN_BYTES,
  parseAgentReport,
  repairPrompt,
  verifyReportClaims,
  type AgentReport,
} from "../../packages/engine/src/index.js";

const REPORT = {
  taskId: "T1",
  status: "done",
  summary: "Added the login check.",
  filesChanged: ["src/auth/login.ts"],
  testsRun: [{ command: "pnpm test", passed: true }],
};

function fenced(body: object, info = "json"): string {
  return `Here is my report.\n\`\`\`${info}\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

/** A report with no test claims unless given some: path tests should not also raise test claims. */
function reportOf(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    ...REPORT,
    filesChanged: [...REPORT.filesChanged],
    testsRun: [],
    confidence: 0.5,
    blockers: [],
    questions: [],
    ...overrides,
  } as AgentReport;
}

const PASSING_TEST = [{ command: "pnpm test", passed: true }];

describe("parseAgentReport: finding the JSON", () => {
  it("reads a fenced json block", () => {
    const result = parseAgentReport(fenced(REPORT), "T1");

    expect(result).toMatchObject({ ok: true, report: { taskId: "T1", status: "done", summary: REPORT.summary } });
  });

  it("reads a bare fenced block and a bare JSON object with prose around it", () => {
    expect(parseAgentReport(fenced(REPORT, ""), "T1").ok).toBe(true);
    const bare = `All done. ${JSON.stringify(REPORT)} Thanks.`;
    expect(parseAgentReport(bare, "T1").ok).toBe(true);
  });

  it("the last fenced json block wins when there are several", () => {
    const text = `${fenced({ ...REPORT, summary: "first draft" })}\nRevised:\n${fenced({ ...REPORT, summary: "final" })}`;
    const result = parseAgentReport(text, "T1");

    expect(result).toMatchObject({ ok: true, report: { summary: "final" } });
  });

  it("a broken last block is reported, not replaced by an earlier valid one", () => {
    const text = `${fenced(REPORT)}\n\`\`\`json\n{"taskId": "T1", "status": }\n\`\`\`\n`;
    const result = parseAgentReport(text, "T1");

    expect(result).toMatchObject({ ok: false, needsRepair: true });
    expect((result as { error: string }).error).toMatch(/does not parse/);
  });
});

describe("parseAgentReport: taskId", () => {
  it("fills a missing taskId from the argument", () => {
    const { taskId: _omit, ...withoutId } = REPORT;
    const result = parseAgentReport(fenced(withoutId), "T7");

    expect(result).toMatchObject({ ok: true, report: { taskId: "T7" } });
  });

  it("refuses a different task without asking for a repair", () => {
    const result = parseAgentReport(fenced({ ...REPORT, taskId: "T2" }), "T1");

    expect(result).toEqual({ ok: false, error: "report is for task T2, expected T1", needsRepair: false });
  });

  it("truncates a long wrong task id to 100 characters with an ellipsis", () => {
    const longId = "X".repeat(500);
    const result = parseAgentReport(fenced({ ...REPORT, taskId: longId }), "T1");

    expect(result).toEqual({
      ok: false,
      error: `report is for task ${"X".repeat(100)}..., expected T1`,
      needsRepair: false,
    });
  });

  it("treats a case difference as the same task and returns the argument's spelling", () => {
    const result = parseAgentReport(fenced({ ...REPORT, taskId: "t1" }), "T1");

    expect(result).toMatchObject({ ok: true, report: { taskId: "T1" } });
  });
});

describe("parseAgentReport: failures", () => {
  it("a schema failure asks for a repair and names the field", () => {
    const result = parseAgentReport(fenced({ taskId: "T1", status: "finished", summary: "x" }), "T1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.needsRepair).toBe(true);
      expect(result.error).toMatch(/^report does not match the schema: status:/);
    }
  });

  it("no JSON at all asks for a repair", () => {
    expect(parseAgentReport("I finished the work, no report.", "T1")).toEqual({
      ok: false,
      error: "no JSON report found",
      needsRepair: true,
    });
    expect(parseAgentReport("", "T1")).toMatchObject({ ok: false, needsRepair: true });
  });

  it("names the parse error when JSON-looking text cannot be parsed", () => {
    const result = parseAgentReport('My report: {"taskId": "T1", "status": }', "T1");

    expect(result).toMatchObject({ ok: false, needsRepair: true });
    expect((result as { error: string }).error).toMatch(/^JSON found but it could not be parsed: ./);
    expect((result as { error: string }).error).not.toContain("no JSON report found");
  });

  it("says a brace is unmatched when there is no closing brace", () => {
    expect(parseAgentReport("I wrote {not finished", "T1")).toEqual({
      ok: false,
      error: "JSON found but it could not be parsed: no matching closing brace",
      needsRepair: true,
    });
  });

  it("brace-only input with no closing brace fails fast with a clear error", () => {
    const text = "{\n".repeat(32 * 1024);
    expect(Buffer.byteLength(text, "utf8")).toBe(MAX_REPORT_SCAN_BYTES);

    const start = performance.now();
    const result = parseAgentReport(text, "T1");
    const elapsed = performance.now() - start;

    expect(result).toEqual({
      ok: false,
      error: "JSON found but it could not be parsed: no matching closing brace",
      needsRepair: true,
    });
    expect(elapsed).toBeLessThan(200);
  });

  it("keeps 'no JSON report found' for text with no brace at all", () => {
    expect(parseAgentReport("Done, no report here.", "T1")).toEqual({
      ok: false,
      error: "no JSON report found",
      needsRepair: true,
    });
  });

  it("a JSON array is not a report", () => {
    expect(parseAgentReport(fenced([1, 2]), "T1")).toMatchObject({ ok: false, needsRepair: true });
  });

  it("a cut inside an earlier code block does not turn its closing fence into an opener", () => {
    // ~40k lines of ts: the 64 KB tail begins inside this block, so its closing fence is the first fence seen.
    const tsBlock = ["```ts", ...Array.from({ length: 40_000 }, (_, i) => `const value${i} = ${i};`), "```"].join("\n");
    const text = `${tsBlock}\nThe report follows.\n${fenced(REPORT)}`;

    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_REPORT_SCAN_BYTES);
    expect(parseAgentReport(text, "T1")).toMatchObject({ ok: true, report: { taskId: "T1", status: "done" } });
  });

  it("ignores everything before the last 64 KB", () => {
    const report = fenced(REPORT);
    const padding = "x".repeat(MAX_REPORT_SCAN_BYTES + 100);

    // The report sits before the cap: it is not seen.
    expect(parseAgentReport(`${report}${padding}`, "T1")).toEqual({
      ok: false,
      error: "no JSON report found",
      needsRepair: true,
    });
    // The same report at the end is seen, after a huge prefix.
    const huge = `${"y".repeat(MAX_REPORT_SCAN_BYTES * 2)}\n${report}`;
    expect(parseAgentReport(huge, "T1")).toMatchObject({ ok: true, report: { taskId: "T1" } });
  });
});

describe("repairPrompt", () => {
  it("includes the error, every allowed status, and a valid example", () => {
    const prompt = repairPrompt("report does not match the schema: status: Invalid enum value");

    expect(prompt).toContain("Error: report does not match the schema: status: Invalid enum value");
    for (const status of AGENT_REPORT_STATUSES) {
      expect(prompt).toContain(status);
    }
    expect(prompt).toContain('{"taskId":"T1","status":"done","summary":"What you changed and why."}');
    expect(prompt.length).toBeLessThan(1200);
  });

  it("truncates a very long error", () => {
    const prompt = repairPrompt("e".repeat(5000));

    expect(prompt).toContain(`Error: ${"e".repeat(500)}…`);
    expect(prompt).not.toContain("e".repeat(501));
    expect(prompt.length).toBeLessThan(1200);
  });
});

describe("verifyReportClaims", () => {
  it("a matching report has no claims", () => {
    const checks = verifyReportClaims(reportOf({ testsRun: PASSING_TEST }), {
      diffFiles: ["src/auth/login.ts"],
      gateRuns: [{ command: "pnpm test", passed: true }],
    });

    expect(checks).toEqual([]);
  });

  it("file_not_in_diff: a reported file the diff does not touch", () => {
    const checks = verifyReportClaims(reportOf({ filesChanged: ["src/auth/login.ts", "src/other.ts"] }), {
      diffFiles: ["src/auth/login.ts"],
    });

    expect(checks).toEqual([{ kind: "file_not_in_diff", detail: "reported file src/other.ts is not in the diff" }]);
  });

  it("diff_file_not_reported: a changed file the report leaves out", () => {
    const checks = verifyReportClaims(reportOf({ filesChanged: [] }), {
      diffFiles: ["src/auth/login.ts"],
    });

    expect(checks.map((check) => check.kind)).toEqual(["diff_file_not_reported"]);
  });

  it("test_claim_unverified: no gate run has that command", () => {
    const checks = verifyReportClaims(reportOf({ testsRun: PASSING_TEST }), {
      diffFiles: ["src/auth/login.ts"],
      gateRuns: [],
    });

    expect(checks).toEqual([{ kind: "test_claim_unverified", detail: 'no gate run for "pnpm test"' }]);
  });

  it("test_claim_contradicted: a gate run has the same command with the opposite result", () => {
    const checks = verifyReportClaims(reportOf({ testsRun: PASSING_TEST }), {
      diffFiles: ["src/auth/login.ts"],
      gateRuns: [{ command: "pnpm test", passed: false }],
    });

    expect(checks.map((check) => check.kind)).toEqual(["test_claim_contradicted"]);
    expect(checks[0]!.detail).toContain('"pnpm test" is reported passed, but a gate run failed');
  });

  it("compares trimmed commands", () => {
    const checks = verifyReportClaims(reportOf({ testsRun: [{ command: "  pnpm test  ", passed: true }] }), {
      diffFiles: ["src/auth/login.ts"],
      gateRuns: [{ command: "pnpm test", passed: true }],
    });

    expect(checks).toEqual([]);
  });

  it("normalises Windows-style paths, a leading ./ and doubled slashes", () => {
    const checks = verifyReportClaims(reportOf({ filesChanged: ["src\\auth\\login.ts", "./src//util.ts"] }), {
      diffFiles: ["./src/auth/login.ts", "src/util.ts"],
    });

    expect(checks).toEqual([]);
  });

  it("paths are case-sensitive by default and case-insensitive with ignoreCase", () => {
    const report = reportOf({ filesChanged: ["SRC/Auth/Login.ts"] });
    const evidence = { diffFiles: ["src/auth/login.ts"] };

    expect(verifyReportClaims(report, evidence).map((check) => check.kind)).toEqual([
      "file_not_in_diff",
      "diff_file_not_reported",
    ]);
    expect(verifyReportClaims(report, evidence, { ignoreCase: true })).toEqual([]);
  });

  it("normalises '/./' segments and a trailing slash, and counts a repeated file once", () => {
    const checks = verifyReportClaims(reportOf({ filesChanged: ["src/./a.ts", "./src/a.ts", "src/a.ts/"] }), {
      diffFiles: ["src/a.ts"],
    });

    expect(checks).toEqual([]);

    const repeated = verifyReportClaims(reportOf({ filesChanged: ["src/x.ts", "./src/x.ts"] }), { diffFiles: [] });
    expect(repeated).toEqual([{ kind: "file_not_in_diff", detail: "reported file src/x.ts is not in the diff" }]);
  });

  it("no false positives when the same file appears in several spellings of the diff list", () => {
    const checks = verifyReportClaims(reportOf({ testsRun: PASSING_TEST }), {
      diffFiles: ["src/auth/login.ts", "./src/auth/login.ts"],
      gateRuns: [{ command: "pnpm test", passed: true }],
    });

    expect(checks).toEqual([]);
  });
});
