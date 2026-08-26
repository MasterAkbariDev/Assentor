import { describe, expect, it } from "vitest";
import { TaskComplexityAnalyzer, explainReviewPlan } from "../../src/index.js";

describe("assentor review CLI parity helpers", () => {
  it("produces a review plan for a security-heavy task", () => {
    const analysis = new TaskComplexityAnalyzer().analyze({
      taskText: "Add OAuth login with JWT refresh and harden auth middleware",
    });
    expect(analysis.score).toBeGreaterThan(20);
    expect(analysis.recommendedRoles).toEqual(
      expect.arrayContaining(["security"]),
    );
    expect(["QUICK", "STANDARD", "DEEP"]).toContain(analysis.evidenceDepth);
  });

  it("explains a review plan in plain language", () => {
    const analysis = new TaskComplexityAnalyzer().analyze({
      taskText: "Add OAuth login with JWT refresh and harden auth middleware",
    });
    const explained = explainReviewPlan(analysis);
    expect(explained.headline).toMatch(/reviewer/i);
    expect(explained.reviewers.length).toBeGreaterThan(0);
    expect(explained.reasons.some((r) => /security/i.test(r))).toBe(true);
  });
});
