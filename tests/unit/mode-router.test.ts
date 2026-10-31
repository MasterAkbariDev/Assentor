import { describe, expect, it } from "vitest";
import type { ComplexityAnalysis, ComplexityRisk } from "../../packages/engine/src/review/complexity.js";
import { suggestMode } from "../../packages/engine/src/modes/auto.js";

const ALL_MODES = ["solo", "review", "explore", "plan", "swarm", "debug", "tdd", "cascade", "lead"];

function complexity(risk: ComplexityRisk = "low"): ComplexityAnalysis {
  return {
    score: 20,
    risk,
    recommendedRoles: ["general"],
    recommendedCount: 1,
    evidenceDepth: "QUICK",
    signals: [],
  };
}

function route(task: string, options: { risk?: ComplexityRisk; available?: string[] } = {}) {
  return suggestMode({
    task,
    complexity: complexity(options.risk),
    availableModes: options.available ?? ALL_MODES,
  });
}

describe("auto mode router: keyword rules", () => {
  it("routes review and audit requests to review at 0.8 confidence", () => {
    const suggestion = route("Please review this PR for leaks");
    expect(suggestion.mode).toBe("review");
    expect(suggestion.confidence).toBe(0.8);
    expect(suggestion.reasons[0]).toContain('"review"');
  });

  it("routes questions with no build verb to explore", () => {
    const suggestion = route("How does the scheduler handle rate limits?");
    expect(suggestion.mode).toBe("explore");
    expect(suggestion.confidence).toBe(0.8);
  });

  it("does not route a question to explore when it asks for a build verb", () => {
    expect(route("Explain how to add a retry to the fetch helper").mode).toBe("solo");
  });

  it("routes planning requests with no build verb to plan", () => {
    expect(route("Plan the caching design for sessions").mode).toBe("plan");
  });

  it("routes mechanical multi-file changes to swarm", () => {
    expect(route("Rename the config key across the repo").mode).toBe("swarm");
  });

  it("routes bug descriptions to debug", () => {
    expect(route("Intermittent crash in the worker pool").mode).toBe("debug");
  });

  it("routes test-first requests to tdd", () => {
    expect(route("Write the parser test first, then the parser").mode).toBe("tdd");
  });

  it("routes the tdd keyword itself to tdd", () => {
    const suggestion = route("Use TDD for the parser");
    expect(suggestion.mode).toBe("tdd");
    expect(suggestion.reasons[0]).toContain('"TDD"');
  });

  it("routes check my, look over and replace all triggers", () => {
    expect(route("Check my diff before merge").mode).toBe("review");
    expect(route("Look over the auth module").mode).toBe("review");
    expect(route("Replace all the old helpers").mode).toBe("swarm");
  });

  it("matches multi-word phrases across any whitespace", () => {
    expect(route("Check  my branch").mode).toBe("review");
    expect(route("How\ndoes the cache evict?").mode).toBe("explore");
    expect(route("Sync the names across\nthe  repo").mode).toBe("swarm");
  });

  it("does not match review inside longer words", () => {
    expect(route("Fix the reviewer assignment").mode).toBe("solo");
    expect(route("Previewing the page layout").mode).toBe("solo");
  });

  it("lets a build verb suppress plan", () => {
    expect(route("Build the caching design for sessions").mode).toBe("solo");
  });
});

describe("auto mode router: risk and multi-part rules", () => {
  it("routes high or critical risk to cascade at 0.6 confidence", () => {
    for (const risk of ["high", "critical"] as const) {
      const suggestion = route("Change the payment retry logic", { risk });
      expect(suggestion.mode).toBe("cascade");
      expect(suggestion.confidence).toBe(0.6);
      expect(suggestion.reasons[0]).toContain(risk);
    }
  });

  it("routes a goal with three listed items to lead", () => {
    const task = "Ship the feature:\n- add login form\n- add session store\n- write tests";
    const suggestion = route(task);
    expect(suggestion.mode).toBe("lead");
    expect(suggestion.confidence).toBe(0.6);
    expect(suggestion.reasons[0]).toContain("3 separate items");
  });

  it("routes a goal with three build sentences to lead", () => {
    const suggestion = route("Add a cache. Build a size limit. Update the docs.");
    expect(suggestion.mode).toBe("lead");
    expect(suggestion.reasons[0]).toContain("3 separate sentences");
  });

  it("does not count dotted filenames as separate sentences", () => {
    const suggestion = route("Update a.ts and fix b.ts and write c.ts");
    expect(suggestion.mode).toBe("solo");
    expect(suggestion.reasons[0]).not.toContain("separate sentences");
  });

  it("counts numbered items written as 1. and as 1)", () => {
    const dotted = route("Ship the feature:\n1. login form\n2. session store\n3. tests");
    expect(dotted.mode).toBe("lead");
    expect(dotted.reasons[0]).toContain("3 separate items");

    const parenthesized = route("Ship the feature:\n1) login form\n2) session store\n3) tests");
    expect(parenthesized.mode).toBe("lead");
    expect(parenthesized.reasons[0]).toContain("3 separate items");
  });
});

describe("auto mode router: fallback, availability and alternatives", () => {
  it("falls back to solo at 0.4 confidence when nothing matches", () => {
    const suggestion = route("add a retry to the fetch helper");
    expect(suggestion).toEqual({
      mode: "solo",
      confidence: 0.4,
      reasons: [expect.stringContaining("simplest fit")],
      alternatives: [],
    });
  });

  it("falls through to the next matching rule when the first mode is unavailable", () => {
    const suggestion = route("Intermittent crash in the worker", {
      risk: "critical",
      available: ["solo", "cascade"],
    });
    expect(suggestion.mode).toBe("cascade");
    expect(suggestion.reasons).toContain(
      "debug also fits, but it is not available here, so it was skipped.",
    );
  });

  it("returns solo when no matching mode is available", () => {
    const suggestion = route("Intermittent crash in the worker", { available: ["solo"] });
    expect(suggestion.mode).toBe("solo");
    expect(suggestion.reasons[0]).toContain("No available mode matched");
    expect(suggestion.reasons[0]).not.toContain("No specific pattern matched");
    expect(suggestion.reasons).toContain(
      "debug also fits, but it is not available here, so it was skipped.",
    );
  });

  it("lists up to two other available modes whose rules matched as alternatives", () => {
    const suggestion = route("Review this flaky test, it is a regression", { risk: "high" });
    expect(suggestion.mode).toBe("review");
    expect(suggestion.alternatives).toEqual(["debug", "cascade"]);
  });

  it("leaves unavailable modes out of alternatives", () => {
    const suggestion = route("Review this flaky test", { available: ["solo", "review"] });
    expect(suggestion.mode).toBe("review");
    expect(suggestion.alternatives).toEqual([]);
  });

  it("gives the same mode and reasons for the same input", () => {
    const input = {
      task: "Review this flaky test. Add a fix.",
      complexity: complexity("high"),
      availableModes: ALL_MODES,
    };
    expect(suggestMode(input)).toEqual(suggestMode(input));
  });
});
