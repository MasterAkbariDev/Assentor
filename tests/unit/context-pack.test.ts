import { describe, expect, it } from "vitest";
import { compactDiff, packContext, packPromptVariables, fitFailureOutput, roleBudget } from "#assentor/engine/context/index.js";
import { packStepVars } from "#assentor/engine/negotiation/pack-vars.js";
import { withReviewBudget } from "#assentor/engine/providers/reviewers/budget.js";
import type { ReviewInput, Reviewer } from "#assentor/engine/providers/reviewers/types.js";
import { estimateTokens } from "#assentor/engine/usage/tokens.js";
import { parseAssentorConfig } from "#assentor/engine/config/schema.js";

const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1} with some padding text`).join("\n");
const fences = (text: string) => text.split("\n").filter((line) => line.trimStart().startsWith("```")).length;

describe("packContext: budget cuts", () => {
  it("cuts nothing without a budget", () => {
    const packed = packContext([{ id: "history", kind: "history", text: lines("h", 500) }]);
    expect(packed.parts.history).toBe(lines("h", 500));
    expect(packed.omitted).toEqual([]);
  });

  it("shrinks lower priority sections first and leaves a marker, in the order given", () => {
    const packed = packContext(
      [
        { id: "history", kind: "history", text: lines("h", 200) },
        { id: "task", kind: "task", text: "fix add()" },
        { id: "diff", kind: "diff", text: lines("d", 40) },
      ],
      { budgetTokens: 600 },
    );
    expect(packed.text.startsWith("[… ")).toBe(true);
    expect(packed.text).toContain("fix add()");
    expect(packed.parts.diff).toBe(lines("d", 40));
    expect(packed.parts.history).toMatch(/\[… \d+ lines omitted\]/);
    expect(packed.parts.history).not.toContain("ask to see more");
    expect(packed.parts.history).toContain("h line 200");
    expect(packed.omitted.map((o) => o.id)).toEqual(["history"]);
    expect(packed.tokens).toBeLessThanOrEqual(600);
  });

  it("adds the caller's hint to markers", () => {
    const packed = packContext([{ id: "x", kind: "excerpt", text: lines("x", 200) }], { budgetTokens: 100, hint: "request via evidenceRequests" });
    expect(packed.text).toMatch(/\[… \d+ lines omitted — request via evidenceRequests\]/);
  });

  it("keeps the first error and the tail of failing-test output", () => {
    const output = ["FAIL first error here", ...Array.from({ length: 300 }, (_, i) => `    at frame ${i}`), "Tests 1 failed"].join("\n");
    const packed = packContext([{ id: "out", kind: "failing-test", text: output }], { budgetTokens: 120 });
    expect(packed.text).toContain("FAIL first error here");
    expect(packed.text).toContain("Tests 1 failed");
    expect(packed.text).toMatch(/lines omitted/);
    expect(packed.tokens).toBeLessThanOrEqual(120);
  });

  it("never exceeds the budget, whatever the budget", () => {
    for (const budget of [0, 5, 40, 300]) {
      const packed = packContext(
        [
          { id: "task", kind: "task", text: lines("t", 100), title: "## Task" },
          { id: "excerpt", kind: "excerpt", text: lines("e", 100), fence: true, title: "### e" },
        ],
        { budgetTokens: budget },
      );
      expect(packed.tokens).toBeLessThanOrEqual(budget);
      expect(estimateTokens(packed.text)).toBeLessThanOrEqual(budget);
      expect(fences(packed.text) % 2).toBe(0);
    }
  });

  it("cuts sections kept whole only after everything else", () => {
    const packed = packContext(
      [
        { id: "task", kind: "task", text: lines("t", 20) },
        { id: "excerpt", kind: "excerpt", text: lines("e", 100) },
      ],
      { budgetTokens: 400 },
    );
    expect(packed.parts.task).toBe(lines("t", 20));
    expect(packed.omitted.map((o) => o.id)).toEqual(["excerpt"]);
  });

  it("cuts one very long line by characters and keeps its tail", () => {
    const minified = `${"a".repeat(30_000)}THE_END_OF_THE_LINE`;
    const packed = packContext([{ id: "min", kind: "excerpt", text: minified }], { budgetTokens: 500 });
    expect(packed.tokens).toBeLessThanOrEqual(500);
    expect(packed.text).toContain("THE_END_OF_THE_LINE");
    expect(packed.text).toMatch(/characters omitted, tail kept/);
    expect(packed.omitted[0]?.id).toBe("min");
  });

  it("never leaves a code fence open after a cut, in a body or in a fenced section", () => {
    const body = ["# Notes", "```ts", ...Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`), "```", "after the code"].join("\n");
    for (const keep of ["start", "end", "both"] as const) {
      const packed = packContext([{ id: "md", kind: "summary", keep, text: body }], { budgetTokens: 300 });
      expect(packed.text).toMatch(/lines omitted/);
      expect(fences(packed.text) % 2).toBe(0);
    }
    const fenced = packContext([{ id: "f", kind: "excerpt", fence: true, title: "### f", text: lines("f", 300) }, { id: "g", kind: "task", text: "tail" }], { budgetTokens: 200 });
    expect(fences(fenced.text)).toBe(2);
    expect(fenced.text.endsWith("tail")).toBe(true);
  });

  it("rejects duplicate section ids", () => {
    expect(() => packContext([{ id: "a", kind: "task", text: "x" }, { id: "a", kind: "task", text: "y" }])).toThrow(/twice/);
  });
});

describe("packContext: lossless merging", () => {
  const block = "This long paragraph of architecture notes appears in the summary and again in the history.";

  it("sends a block that appears in two sections once, with the copy count, and cuts nothing", () => {
    const packed = packContext([
      { id: "notes", kind: "summary", text: `intro\n\n${block}` },
      { id: "history", kind: "history", text: block },
    ]);
    expect(packed.text.split(block)).toHaveLength(2);
    expect(packed.parts.history).toBe('[… same text as "notes" (2 copies)]');
    expect(packed.deduped).toEqual(["history"]);
  });

  it("merges identical repeated blocks inside test output and says how many", () => {
    const repeat = "[warn] connect ECONNREFUSED 127.0.0.1:5432, retrying in 200ms\n    at connect (src/net/pool.ts:41:11)";
    const output = ["AssertionError: x", "", ...Array.from({ length: 5 }, () => `${repeat}\n`), "Tests 1 failed"].join("\n");
    const packed = packContext([{ id: "out", kind: "failing-test", text: output }]);
    expect(packed.text.split("ECONNREFUSED")).toHaveLength(2);
    expect(packed.text).toContain("[… the block above repeats 4 more times]");
    expect(packed.text).toContain("Tests 1 failed");
  });

  it("does not merge blocks that differ (retry 1/3, retry 2/3, …)", () => {
    const output = Array.from({ length: 5 }, (_, i) => `[warn] connect ECONNREFUSED 127.0.0.1:5432, retry ${i + 1}/5 in 200ms\n    at connect (src/net/pool.ts:41:11)\n`).join("\n");
    expect(packContext([{ id: "out", kind: "failing-test", text: output }]).text).toBe(output);
  });

  it("does not merge short blocks, and never merges code", () => {
    expect(packContext([{ id: "a", kind: "summary", text: "none" }, { id: "b", kind: "history", text: "none" }]).text).toBe("none\n\nnone");
    const code = "export function slugify(input: string): string {\n  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n}";
    const packed = packContext([{ id: "a", kind: "excerpt", text: code }, { id: "b", kind: "diff", text: code }]);
    expect(packed.text.split(code)).toHaveLength(3);
    expect(packed.deduped).toEqual([]);
  });
});

describe("compactDiff", () => {
  const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,30 +1,31 @@", ...Array.from({ length: 14 }, (_, i) => ` ctx ${i}`), "+added line", ...Array.from({ length: 14 }, (_, i) => ` tail ${i}`)].join("\n");

  it("keeps headers, changed lines and the context around them", () => {
    const out = compactDiff(diff, 2);
    expect(out).toContain("+added line");
    expect(out).toContain(" ctx 13");
    expect(out).toContain(" tail 1");
    expect(out).not.toContain(" ctx 0");
    expect(out).toContain("@@ -1,30 +1,31 @@");
    expect(out).toMatch(/\[… 12 lines omitted\]/);
  });

  it("a shrinking diff section loses context before changed lines", () => {
    const packed = packContext([{ id: "diff", kind: "diff", text: diff }], { budgetTokens: estimateTokens(diff) - 20 });
    expect(packed.text).toContain("+added line");
    expect(packed.omitted[0]?.id).toBe("diff");
  });
});

describe("packPromptVariables and negotiation steps", () => {
  const long = (tag: string) => Array.from({ length: 120 }, (_, i) => `${tag} step ${i} of the plan with a fairly long description`).join("\n");
  const same = "Add retries with exponential backoff to the upload client and cover the deadline in tests, then run pnpm test.";

  it("packs identical proposals once without a budget, and passes the rest through", () => {
    const vars = { goal: "g", round: 2, proposals: [{ label: "Proposal A", text: same }, { label: "Proposal B", text: same }, { label: "Proposal C", text: "other" }] };
    const out = packPromptVariables(vars);
    expect(out.round).toBe(2);
    expect(out.proposals[1]).toEqual({ label: "Proposal B", text: '[… same text as "Proposal A" (2 copies)]' });
    expect(out.proposals[2]!.text).toBe("other");
  });

  it("shrinks only with a negotiation budget, the seat's own proposal and critiques last", () => {
    const vars = {
      goal: "g",
      round: 2,
      label: "Proposal A",
      proposal: long("own"),
      proposals: [{ label: "Proposal B", text: long("other") }],
      critiques: [{ target: "Proposal A", text: "No deadline.", citations: [] }],
    };
    expect(packStepVars(vars)).toEqual(vars);
    expect(packStepVars(vars, { negotiation: 0 })).toEqual(vars);
    const revise = packStepVars(vars, { negotiation: 2000 });
    expect(revise.proposal).toBe(long("own"));
    expect(revise.critiques[0]!.text).toBe("No deadline.");
    expect(revise.proposals[0]!.text).toMatch(/lines omitted\]/);
  });

  it("keeps every conflicting-summary variable a summary, not a diff", () => {
    const out = packPromptVariables({ goal: "g", conflicts: long("c"), diff: long("d") }, { budgetTokens: 2200 });
    expect(out.diff).toBe(long("d"));
    expect(out.conflicts).toMatch(/lines omitted/);
  });
});

describe("budgets come from the config they were passed, not from process state", () => {
  const vars = { goal: "g", proposals: [{ label: "Proposal A", text: Array.from({ length: 300 }, (_, i) => `step ${i} of the plan with a long description`).join("\n") }] };

  it("two configs in flight each get their own negotiation budget", async () => {
    const a = parseAssentorConfig({ context: { budgetTokens: { negotiation: 300 } } });
    const b = parseAssentorConfig({});
    const [packedA, packedB] = await Promise.all([
      Promise.resolve().then(() => packStepVars(vars, a.context?.budgetTokens)),
      Promise.resolve().then(() => packStepVars(vars, b.context?.budgetTokens)),
    ]);
    expect(packedA.proposals[0]!.text).toMatch(/lines omitted/);
    expect(packedB.proposals[0]!.text).toBe(vars.proposals[0]!.text);
    // Loading a third config changes neither.
    parseAssentorConfig({ context: { budgetTokens: { negotiation: 50 } } });
    expect(packStepVars(vars, b.context?.budgetTokens).proposals[0]!.text).toBe(vars.proposals[0]!.text);
  });

  it("two reviewers wrapped with different budgets send their own", async () => {
    const seen: Array<number | undefined> = [];
    const inner: Reviewer = { name: "r", review: async (input) => (seen.push(input.contextBudgetTokens), {}), continue: async (input) => (seen.push(input.contextBudgetTokens), {}) };
    const input = { taskId: "t", projectPath: "/p", contract: { goal: "g" }, round: 1, artifacts: [] } as unknown as ReviewInput;
    await withReviewBudget(inner, 1000).review(input);
    await withReviewBudget(inner, 2000).review(input);
    await inner.review(input);
    expect(seen).toEqual([1000, 2000, undefined]);
  });
});

describe("failure output sent to coders", () => {
  const repeat = "[warn] connect ECONNREFUSED 127.0.0.1:5432, retrying in 200ms\n    at connect (src/net/pool.ts:41:11)";
  const output = ["AssertionError: expected 1 to be 2", "", ...Array.from({ length: 200 }, () => `${repeat}\n`), "Tests 1 failed"].join("\n");

  it("without a budget: repeats once, then the caller's own cut", () => {
    const fitted = fitFailureOutput(output, 1500, undefined);
    expect(fitted.split("ECONNREFUSED")).toHaveLength(2);
    expect(fitted.length).toBeLessThanOrEqual(1500);
    expect(fitFailureOutput("x".repeat(5000) + "END", 1500, undefined)).toBe("x".repeat(1497) + "END");
    expect(fitFailureOutput("START" + "x".repeat(5000), 1500, undefined, "start")).toBe("START" + "x".repeat(1495));
  });

  it("with a coder budget: the first error and the tail within the cap", () => {
    const fitted = fitFailureOutput("AssertionError: first\n" + lines("frame", 400) + "\nTests 1 failed", 1500, 2000);
    expect(fitted.length).toBeLessThanOrEqual(1500);
    expect(fitted).toContain("AssertionError: first");
    expect(fitted).toContain("Tests 1 failed");
  });
});

describe("config", () => {
  it("writes no context defaults, and 0 or unset means no cuts", () => {
    expect(parseAssentorConfig({}).context).toBeUndefined();
    const config = parseAssentorConfig({ context: { budgetTokens: { lead: 3000, coder: 0 } } });
    expect(config.context?.budgetTokens).toEqual({ lead: 3000, coder: 0 });
    expect(roleBudget(config.context?.budgetTokens, "lead")).toBe(3000);
    expect(roleBudget(config.context?.budgetTokens, "coder")).toBeUndefined();
    expect(roleBudget(config.context?.budgetTokens, "reviewer")).toBeUndefined();
    expect(roleBudget(undefined, "lead")).toBeUndefined();
  });
});
