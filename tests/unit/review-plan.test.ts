import { describe, expect, it } from "vitest";
import { TaskComplexityAnalyzer } from "../../src/index.js";

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
});
