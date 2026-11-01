/**
 * Fixture tasks for `bench:tokens` (TE-10). Each is a tiny project, the
 * built-in role prompt that works on it, an automatic success check, and the
 * reply a competent seat gives (used by the mock runner).
 */

export interface TaskResult {
  /** The seat's final reply. */
  output: string;
  /** Project files after the run (repository-relative path → content). */
  files: Record<string, string>;
}

export interface BenchTask {
  id: string;
  /** Built-in prompt id of the seat. */
  role: string;
  /** Variables rendered into the role prompt. */
  variables: Record<string, string>;
  files: Record<string, string>;
  /**
   * Strings the seat's prompt must still contain for a competent seat to get the task right (the vulnerable
   * line to review, the first failing assertion). The mock seat is blind without them, so a variant that cuts
   * context it needs fails the task instead of just looking smaller.
   */
  needs?: string[];
  check(result: TaskResult): boolean;
  mock: {
    output: string;
    /** Files the mock seat writes (merged over `files`). */
    edits?: Record<string, string>;
  };
}

/** The last fenced JSON block of a reply, parsed; undefined when there is none or it is cut off. */
export function lastJson(output: string): Record<string, unknown> | undefined {
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  try {
    const value: unknown = JSON.parse(blocks.at(-1)?.[1] ?? "");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const hasHandoff = (output: string) => typeof lastJson(output)?.whatChanged === "string";

const handoff = (whatChanged: string, why: string) =>
  "### Handoff\n```json\n" +
  JSON.stringify(
    {
      whatChanged,
      why,
      assumptions: [],
      unchanged: "Everything outside the owned files.",
      risks: [],
      limitations: [],
      architectureSummary: "A local change inside one module; callers and the public signature are unchanged.",
    },
    null,
    2,
  ) +
  "\n```";

const MATH_TS = `export function add(a: number, b: number): number {
  return a - b;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => add(total, value), 0);
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error("mean() of an empty list");
  }
  return sum(values) / values.length;
}
`;

const MATH_TEST = `import { describe, expect, it } from "vitest";
import { add, mean, sum } from "../src/math.js";

describe("math", () => {
  it("adds", () => expect(add(2, 3)).toBe(5));
  it("sums", () => expect(sum([1, 2, 3])).toBe(6));
  it("averages", () => expect(mean([2, 4])).toBe(3));
});
`;

const SLUG_TS = `/** URL slug: lower case, ASCII letters and digits, single dashes, no dashes at the ends. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`;

const PRICE_TS = `export interface Line {
  net: number;
  quantity: number;
}

export function netToGross(net: number): number {
  return Math.round(net * 1.2 * 100) / 100;
}

export function cartTotal(lines: Line[]): number {
  let total = 0;
  for (const line of lines) {
    total += Math.round(line.net * line.quantity * 1.2 * 100) / 100;
  }
  return Math.round(total * 100) / 100;
}
`;

/** A module of `count` small query helpers, the shape of a real src/users.ts. */
const userHelpers = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `export async function listUsersBy${i}(value: string, limit = 50) {
  // Admin listing ${i}: filter on column c${i}, newest first.
  const rows = await db.query("SELECT id, name FROM users WHERE c${i} = $1 ORDER BY id DESC LIMIT $2", [value, limit]);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}
`,
  ).join("\n");

const USERS_BEFORE = `import { db } from "./db.js";

export async function findUser(id: number) {
  return db.query("SELECT id, name FROM users WHERE id = $1", [id]);
}

${userHelpers(24)}`;

const SEARCH_USERS = `export async function searchUsers(name: string) {
  // Search by name for the admin page.
  return db.query(\`SELECT id, name, email FROM users WHERE name LIKE '%\${name}%'\`);
}`;

const beforeLines = USERS_BEFORE.split("\n");
const addedLines = ["", ...SEARCH_USERS.split("\n")];

/** The change as a function-context diff (the whole file around the hunk), which is what a "show me the function" diff looks like. */
const USERS_DIFF = [
  "diff --git a/src/users.ts b/src/users.ts",
  "--- a/src/users.ts",
  "+++ b/src/users.ts",
  `@@ -1,${beforeLines.length} +1,${beforeLines.length + addedLines.length} @@`,
  ...beforeLines.map((line) => ` ${line}`),
  ...addedLines.map((line) => `+${line}`),
  "",
].join("\n");

/** What an evidence pack carries next to the diff: the project tree, the callee and the new file in full. */
const USERS_EVIDENCE = [
  "### Project structure",
  "src/db.ts, src/users.ts, src/routes/admin.ts, tests/users.test.ts, package.json",
  "",
  "### src/db.ts",
  "db.query(sql, params?) passes params to the driver as bound parameters.",
  "",
  "### src/users.ts (after the change)",
  [...beforeLines, ...addedLines].join("\n"),
].join("\n");

/** A failing run whose retry warning repeats verbatim, as retry loops and flaky suites print it. */
const RETRY_BLOCK = "[warn] connect ECONNREFUSED 127.0.0.1:5432, retrying in 200ms\n    at connect (src/net/pool.ts:41:11)\n    at retry (src/net/pool.ts:77:5)\n    at Pool.acquire (src/net/pool.ts:102:9)";
const TEST_OUTPUT = [
  " RUN  v3.2.7 /work/pricing",
  " FAIL  tests/price.test.ts > cartTotal > rounds each line once",
  "AssertionError: expected 24.01 to be 24",
  "    at tests/price.test.ts:18:34",
  "",
  ...Array.from({ length: 14 }, () => `${RETRY_BLOCK}\n`),
  " Test Files  1 failed | 3 passed (4)",
  "      Tests  1 failed | 11 passed (12)",
].join("\n");

export const BENCH_TASKS: BenchTask[] = [
  {
    id: "bug-fix",
    role: "engineer",
    variables: {
      goal: "Fix add() in src/math.ts: it subtracts instead of adding, so sum() and mean() are wrong.",
      subtask: "Fix add() so the existing tests in tests/math.test.ts pass. Owned paths: src/math.ts.",
      acceptanceCriteria: "- add(2, 3) returns 5\n- sum and mean tests pass\n- no other file changes",
    },
    files: { "src/math.ts": MATH_TS, "tests/math.test.ts": MATH_TEST },
    check: ({ output, files }) => /return\s+a\s*\+\s*b/.test(files["src/math.ts"] ?? "") && hasHandoff(output),
    mock: {
      edits: { "src/math.ts": MATH_TS.replace("return a - b;", "return a + b;") },
      output: [
        "### Summary",
        "add() in src/math.ts returned a - b, so sum() and mean() were wrong. It now returns a + b; nothing else changed.",
        "",
        "### Files changed",
        "- src/math.ts: add() returns a + b.",
        "",
        "### Tests run",
        "- `npx vitest run tests/math.test.ts`: 3 passed, 0 failed (before the fix: 3 failed).",
        "",
        "### Criteria status",
        "- add(2, 3) returns 5: met (tests/math.test.ts \"adds\").",
        "- sum and mean tests pass: met.",
        "- no other file changes: met (git diff shows only src/math.ts).",
        "",
        "### Open issues",
        "none",
        "",
        handoff("add() now adds its arguments instead of subtracting them.", "sum() and mean() build on add(), so all three were wrong."),
      ].join("\n"),
    },
  },
  {
    id: "add-test",
    role: "test-writer",
    variables: {
      goal: "Cover slugify() in src/slug.ts with unit tests.",
      acceptanceCriteria: "- lower-cases and joins words with single dashes\n- strips accents\n- trims leading and trailing dashes\n- empty input gives an empty string",
      projectSummary: "TypeScript library, vitest, tests live in tests/*.test.ts.",
    },
    files: { "src/slug.ts": SLUG_TS },
    check: ({ output, files }) =>
      Object.entries(files).some(([file, text]) => file.endsWith(".test.ts") && text.includes("slugify(") && text.includes("expect(")) &&
      hasHandoff(output),
    mock: {
      edits: {
        "tests/slug.test.ts": `import { describe, expect, it } from "vitest";
import { slugify } from "../src/slug.js";

describe("slugify", () => {
  it("lower-cases and joins words with single dashes", () => expect(slugify("Hello  World")).toBe("hello-world"));
  it("strips accents", () => expect(slugify("Crème Brûlée")).toBe("creme-brulee"));
  it("trims dashes at the ends", () => expect(slugify("--a b--")).toBe("a-b"));
  it("gives an empty string for empty input", () => expect(slugify("")).toBe(""));
});
`,
      },
      output: [
        "### Tests added",
        "- tests/slug.test.ts: four cases for slugify().",
        "",
        "### Criteria covered",
        "- lower-cases and joins words: \"lower-cases and joins words with single dashes\".",
        "- strips accents: \"strips accents\" (Crème Brûlée → creme-brulee).",
        "- trims dashes: \"trims dashes at the ends\".",
        "- empty input: \"gives an empty string for empty input\".",
        "",
        "### Edge cases",
        "Repeated separators collapse to one dash; punctuation-only input gives an empty string (same branch as empty input).",
        "",
        "### Results",
        "`npx vitest run tests/slug.test.ts`: 4 passed, 0 failed.",
        "",
        "### Open issues",
        "none",
        "",
        handoff("Added tests/slug.test.ts with four slugify() cases, one per criterion.", "slugify() had no tests."),
      ].join("\n"),
    },
  },
  {
    id: "refactor",
    role: "refactorer",
    variables: {
      goal: "Remove the duplicated VAT rounding in src/price.ts without changing behaviour.",
      subtask: "Extract the gross calculation into one helper used by netToGross() and cartTotal(). Owned paths: src/price.ts.",
      testOutput: TEST_OUTPUT,
    },
    files: { "src/price.ts": PRICE_TS },
    needs: ["AssertionError: expected 24.01 to be 24"],
    check: ({ output, files }) => {
      const text = files["src/price.ts"] ?? "";
      return (text.match(/1\.2\b/g) ?? []).length === 1 && /export function netToGross/.test(text) && /export function cartTotal/.test(text) && hasHandoff(output);
    },
    mock: {
      edits: {
        "src/price.ts": `export interface Line {
  net: number;
  quantity: number;
}

const VAT = 1.2;
const cents = (value: number) => Math.round(value * 100) / 100;

export function netToGross(net: number): number {
  return cents(net * VAT);
}

export function cartTotal(lines: Line[]): number {
  return cents(lines.reduce((total, line) => total + netToGross(line.net * line.quantity), 0));
}
`,
      },
      output: [
        "### Summary",
        "The VAT factor and cent rounding were written out twice. They are now one constant and one helper; cartTotal() reuses netToGross().",
        "",
        "### Moved or renamed",
        "- New private `VAT` and `cents()` in src/price.ts.",
        "",
        "### Baseline and final results",
        "No tests exist; both functions give the same results for the examples in the task (netToGross(10) = 12, cartTotal([{ net: 10, quantity: 2 }]) = 24).",
        "",
        "### Behaviour changes",
        "none",
        "",
        "### Open issues",
        "src/price.ts has no tests; adding them is outside this subtask.",
        "",
        handoff("Extracted the VAT factor and rounding into one helper used by both functions.", "The duplicated formula could drift."),
      ].join("\n"),
    },
  },
  {
    id: "review",
    role: "code-reviewer",
    variables: {
      goal: "Add a user search for the admin page.",
      acceptanceCriteria: "- searchUsers(name) returns users whose name contains the text\n- no SQL injection",
      diff: USERS_DIFF,
      evidence: USERS_EVIDENCE,
    },
    files: {},
    needs: ["name LIKE '%${name}%'"],
    check: ({ output }) => {
      const review = lastJson(output);
      return review?.status === "NEEDS_WORK" && /inject/i.test(JSON.stringify(review.issues ?? []));
    },
    mock: {
      output:
        "```json\n" +
        JSON.stringify(
          {
            status: "NEEDS_WORK",
            confidence: 0.9,
            summary: "searchUsers() builds SQL from user input: SQL injection.",
            requirementsAssessment: [
              { criterion: "searchUsers(name) returns users whose name contains the text", satisfied: true, notes: "LIKE with wildcards on both sides." },
              { criterion: "no SQL injection", satisfied: false, notes: "name is interpolated into the SQL string." },
            ],
            issues: [
              {
                id: "C1",
                severity: "blocker",
                category: "security",
                description: "searchUsers() interpolates name into the query, so a crafted name is SQL injection.",
                evidence: ["src/users.ts +11: db.query(`SELECT … WHERE name LIKE '%${name}%'`)"],
                affectedFiles: ["src/users.ts"],
                requiredChange: "Pass the pattern as a bound parameter: db.query(\"… WHERE name LIKE $1\", [`%${name}%`]).",
              },
              {
                id: "C2",
                severity: "minor",
                category: "privacy",
                description: "The admin search returns email, which findUser() does not; confirm the admin page needs it.",
                evidence: ["src/users.ts +11: SELECT id, name, email"],
                affectedFiles: ["src/users.ts"],
                requiredChange: "",
              },
            ],
            requiredChanges: ["Use a bound parameter for the LIKE pattern in searchUsers()."],
            optionalChanges: ["Drop email from the result unless the admin page shows it."],
            evidenceRequests: [],
            verification: { tests: "NOT_RUN", build: "NOT_RUN", lint: "NOT_RUN", typecheck: "NOT_RUN" },
          },
          null,
          2,
        ) +
        "\n```",
    },
  },
  {
    id: "plan",
    role: "planner",
    variables: {
      goal: "Add CSV export to the reports page.",
      acceptanceCriteria: "- an Export button downloads the visible rows as CSV\n- values with commas or quotes are escaped\n- large reports (50k rows) do not freeze the page",
      projectSummary: "React app in src/web, report table in src/web/reports/ReportTable.tsx, data hooks in src/web/reports/useReport.ts, vitest.",
    },
    files: {},
    check: ({ output }) => {
      const subtasks = lastJson(output)?.subtasks;
      return Array.isArray(subtasks) && subtasks.length >= 2;
    },
    mock: {
      output:
        "```json\n" +
        JSON.stringify(
          {
            subtasks: [
              { id: "S1", description: "Add toCsv(rows, columns) in src/web/reports/csv.ts with RFC 4180 escaping; cover commas, quotes and newlines in tests/unit/csv.test.ts.", ownedPaths: ["src/web/reports/csv.ts", "tests/unit/csv.test.ts"], dependsOn: [] },
              { id: "S2", description: "Build the CSV in chunks of 5k rows with a yield between chunks so 50k rows do not block the page; verify with a 50k-row test.", ownedPaths: ["src/web/reports/csv-stream.ts", "tests/unit/csv-stream.test.ts"], dependsOn: ["S1"] },
              { id: "S3", description: "Add the Export button to src/web/reports/ReportTable.tsx; it exports the visible rows from useReport() and downloads report.csv.", ownedPaths: ["src/web/reports/ReportTable.tsx"], dependsOn: ["S2"] },
            ],
          },
          null,
          2,
        ) +
        "\n```",
    },
  },
];
