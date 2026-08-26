import { describe, expect, it } from "vitest";
import {
  SPECIALTY_PROMPT_ADDENDA,
  TaskComplexityAnalyzer,
  buildReviewPrompt,
  createEmptyContract,
  specialtyAddendum,
} from "../../src/index.js";

describe("specialty prompts", () => {
  it("provides addenda for all specialties", () => {
    for (const key of Object.keys(SPECIALTY_PROMPT_ADDENDA)) {
      const text = specialtyAddendum(key);
      expect(text.length).toBeGreaterThan(40);
      expect(text.toLowerCase()).toMatch(/evidence/);
    }
  });

  it("injects specialty addendum into review prompts", () => {
    const prompt = buildReviewPrompt({
      contract: createEmptyContract("Refactor auth module boundaries"),
      round: 1,
      artifacts: [],
      specialtyAddendum: specialtyAddendum("architecture"),
    });
    expect(prompt).toContain("Specialty: Architecture");
    expect(prompt).toContain("unchanged interfaces");
  });
});

describe("TaskComplexityAnalyzer", () => {
  it("scores simple tasks as low risk with QUICK depth", () => {
    const analysis = new TaskComplexityAnalyzer().analyze({
      taskText: "Rename a variable",
    });
    expect(analysis.score).toBeLessThan(30);
    expect(analysis.risk).toBe("low");
    expect(analysis.evidenceDepth).toBe("QUICK");
    expect(analysis.recommendedCount).toBe(1);
  });

  it("recommends security roles and deeper evidence for auth work", () => {
    const analysis = new TaskComplexityAnalyzer().analyze({
      taskText:
        "Implement OAuth authentication with secure session cookies and JWT refresh tokens across the architecture",
      projectOverview: {
        framework: "express",
        hasTests: false,
        moduleCount: 50,
      },
    });
    expect(analysis.score).toBeGreaterThanOrEqual(55);
    expect(analysis.recommendedRoles).toContain("security");
    expect(["STANDARD", "DEEP"]).toContain(analysis.evidenceDepth);
    expect(analysis.recommendedCount).toBeGreaterThanOrEqual(2);
    expect(analysis.signals.some((s) => s.startsWith("keyword:"))).toBe(true);
  });
});
