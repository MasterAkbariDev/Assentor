import { describe, expect, it } from "vitest";
import {
  explainSignals,
  explainStrategy,
  formatReviewPlanExplanation,
} from "../../src/review/plan-explain.js";
import type { ComplexityAnalysis } from "../../src/review/complexity.js";

describe("review plan explanations", () => {
  it("translates raw signals into plain language", () => {
    expect(explainSignals(["keyword:security", "long_task_text"])).toEqual([
      "Goal mentions security-related work",
      "Long / detailed goal description",
    ]);
  });

  it("explains strategies", () => {
    expect(explainStrategy("ADAPTIVE")).toMatch(/harder/i);
  });

  it("formats a readable plan block", () => {
    const plan: ComplexityAnalysis = {
      score: 42,
      risk: "medium",
      recommendedRoles: ["general", "testing"],
      recommendedCount: 2,
      evidenceDepth: "STANDARD",
      signals: ["keyword:testing", "short_task_text"],
    };
    const lines = formatReviewPlanExplanation(plan, {
      goal: "Add unit tests",
      strategy: "ADAPTIVE",
    });
    expect(lines.some((l) => l.includes("Add unit tests"))).toBe(true);
    expect(lines.some((l) => l.includes("testing"))).toBe(true);
    expect(lines.some((l) => /Medium risk/i.test(l))).toBe(true);
  });
});
