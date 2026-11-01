import { describe, expect, it } from "vitest";
import { compactDiff, packContext, packPromptVariables, roleOfPrompt, contextBudget, setContextBudgets, DEFAULT_BUDGET_TOKENS } from "#assentor/engine/context/index.js";
import { estimateTokens } from "#assentor/engine/usage/tokens.js";
import { parseAssentorConfig } from "#assentor/engine/config/schema.js";

const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1} with some padding text`).join("\n");

describe("packContext", () => {
  it("keeps everything, in the given order, when it fits", () => {
    const packed = packContext(
      [
        { id: "history", kind: "history", text: "old" },
        { id: "task", kind: "task", text: "do the thing" },
      ],
      { budgetTokens: 1000 },
    );
    expect(packed.text).toBe("old\n\ndo the thing");
    expect(packed.omitted).toEqual([]);
  });

  it("shrinks lower priority sections first and leaves a marker", () => {
    const packed = packContext(
      [
        { id: "task", kind: "task", text: "fix add()" },
        { id: "history", kind: "history", text: lines("h", 200) },
        { id: "diff", kind: "diff", text: lines("d", 40) },
      ],
      { budgetTokens: 600 },
    );
    expect(packed.text).toContain("fix add()");
    expect(packed.parts.diff).toBe(lines("d", 40));
    expect(packed.parts.history).toMatch(/\[… \d+ lines omitted — ask to see more\]/);
    // history keeps its most recent lines
    expect(packed.parts.history).toContain("h line 200");
    expect(packed.parts.history).not.toContain("h line 1 ");
    expect(packed.omitted.map((o) => o.id)).toEqual(["history"]);
    expect(packed.tokens).toBeLessThanOrEqual(600);
  });

  it("keeps the first error and the tail of failing-test output", () => {
    const output = ["FAIL first error here", ...Array.from({ length: 300 }, (_, i) => `    at frame ${i}`), "Tests 1 failed"].join("\n");
    const packed = packContext([{ id: "out", kind: "failing-test", text: output }], { budgetTokens: 120 });
    expect(packed.text).toContain("FAIL first error here");
    expect(packed.text).toContain("Tests 1 failed");
    expect(packed.text).toMatch(/lines omitted/);
    expect(packed.tokens).toBeLessThanOrEqual(120);
  });

  it("cuts sections kept whole only after everything else, and never exceeds the budget", () => {
    for (const budget of [0, 5, 40, 300]) {
      const packed = packContext(
        [
          { id: "task", kind: "task", text: lines("t", 100), title: "## Task" },
          { id: "excerpt", kind: "excerpt", text: lines("e", 100) },
        ],
        { budgetTokens: budget },
      );
      expect(packed.tokens).toBeLessThanOrEqual(budget);
      expect(estimateTokens(packed.text)).toBeLessThanOrEqual(budget);
    }
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

  it("sends a block that appears in two sections once, in the higher priority one", () => {
    const block = "This long paragraph of architecture notes appears in the summary and again in the evidence.";
    const packed = packContext(
      [
        { id: "notes", kind: "summary", text: `intro\n\n${block}` },
        { id: "history", kind: "history", text: block },
      ],
      { budgetTokens: 1000 },
    );
    expect(packed.text.split(block)).toHaveLength(2);
    expect(packed.parts.history).toBe('[… same text as "notes" omitted]');
    expect(packed.deduped).toEqual(["history"]);
  });

  it("never dedupes code: two copies of a function in two excerpts both stay", () => {
    const code = "export function slugify(input: string): string {\n  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n}";
    const packed = packContext([{ id: "a", kind: "excerpt", text: code }, { id: "b", kind: "diff", text: code }], { budgetTokens: 1000 });
    expect(packed.text.split(code)).toHaveLength(3);
    expect(packed.deduped).toEqual([]);
  });

  it("does not dedupe short blocks", () => {
    const packed = packContext(
      [
        { id: "a", kind: "excerpt", text: "none" },
        { id: "b", kind: "summary", text: "none" },
      ],
      { budgetTokens: 100 },
    );
    expect(packed.text).toBe("none\n\nnone");
  });

  it("rejects duplicate section ids", () => {
    expect(() => packContext([{ id: "a", kind: "task", text: "x" }, { id: "a", kind: "task", text: "y" }], { budgetTokens: 10 })).toThrow(/twice/);
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
    expect(out).toMatch(/\[… 12 lines omitted/);
  });

  it("a shrinking diff section loses context before changed lines", () => {
    const packed = packContext([{ id: "diff", kind: "diff", text: diff }], { budgetTokens: estimateTokens(diff) - 20 });
    expect(packed.text).toContain("+added line");
    expect(packed.omitted[0]?.id).toBe("diff");
  });
});

describe("packPromptVariables", () => {
  it("packs context variables and list items, and passes the rest through", () => {
    const vars = { goal: "g", round: 2, proposals: [{ label: "Proposal A", text: lines("p", 300) }, { label: "Proposal B", text: "short" }] };
    const out = packPromptVariables(vars, { budgetTokens: 300 });
    expect(out.round).toBe(2);
    expect(out.goal).toBe("g");
    expect(out.proposals[1]).toEqual({ label: "Proposal B", text: "short" });
    expect(out.proposals[0]!.label).toBe("Proposal A");
    expect(out.proposals[0]!.text).toMatch(/lines omitted/);
  });
});

describe("budgets and config", () => {
  it("maps prompts to roles and resolves budgets with 0 = off", () => {
    expect(roleOfPrompt("negotiate-critique")).toBe("negotiation");
    expect(roleOfPrompt("code-reviewer")).toBe("reviewer");
    expect(roleOfPrompt("lead")).toBe("lead");
    expect(roleOfPrompt("engineer")).toBe("coder");
    setContextBudgets({ reviewer: 500, coder: 0 });
    try {
      expect(contextBudget("reviewer")).toBe(500);
      expect(contextBudget("coder")).toBeUndefined();
      expect(contextBudget("lead")).toBe(DEFAULT_BUDGET_TOKENS.lead);
    } finally {
      setContextBudgets(undefined);
    }
  });

  it("writes no context defaults into a parsed config", () => {
    expect(parseAssentorConfig({}).context).toBeUndefined();
    expect(parseAssentorConfig({ context: { budgetTokens: { lead: 3000 } } }).context?.budgetTokens).toEqual({ lead: 3000 });
  });
});

describe("negotiation step variables", () => {
  const long = (tag: string) => Array.from({ length: 120 }, (_, i) => `${tag} step ${i} of the plan with a fairly long description`).join("\n");

  it("sends identical proposals once and keeps the seat's own proposal whole in a revision", async () => {
    const { packStepVars } = await import("#assentor/engine/negotiation/pack-vars.js");
    const same = "Add retries with exponential backoff to the upload client and cover the deadline in tests, then run pnpm test.";
    const critique = packStepVars("negotiate-critique", { goal: "g", round: 1, proposals: [{ label: "Proposal A", text: same }, { label: "Proposal B", text: same }] });
    expect(critique.proposals[1]!.text).toBe('[… same text as "Proposal A" omitted]');

    setContextBudgets({ negotiation: 2000 });
    try {
      const revise = packStepVars("negotiate-revise", {
        goal: "g",
        round: 2,
        label: "Proposal A",
        proposal: long("own"),
        proposals: [{ label: "Proposal B", text: long("other") }],
        critiques: [{ target: "Proposal A", text: "No deadline.", citations: [] }],
      });
      expect(revise.proposal).toBe(long("own"));
      expect(revise.critiques[0]!.text).toBe("No deadline.");
      expect(revise.proposals[0]!.text).toMatch(/lines omitted — ask to see more/);
    } finally {
      setContextBudgets(undefined);
    }
  });
});

describe("packFailureOutput", () => {
  it("keeps the first error and the tail within the caller's cap, repeats once; undefined when packing is off", async () => {
    const { packFailureOutput } = await import("#assentor/engine/context/budget.js");
    const repeat = "[warn] connect ECONNREFUSED 127.0.0.1:5432, retrying in 200ms\n    at connect (src/net/pool.ts:41:11)";
    const output = ["AssertionError: expected 1 to be 2", "", ...Array.from({ length: 200 }, () => `${repeat}\n`), "Tests 1 failed"].join("\n");
    const packed = packFailureOutput(output, 1500)!;
    expect(packed.length).toBeLessThanOrEqual(1500);
    expect(packed).toContain("AssertionError: expected 1 to be 2");
    expect(packed).toContain("Tests 1 failed");
    expect(packed.split("ECONNREFUSED")).toHaveLength(2);
    setContextBudgets({ coder: 0 });
    try {
      expect(packFailureOutput(output, 1500)).toBeUndefined();
    } finally {
      setContextBudgets(undefined);
    }
  });
});
