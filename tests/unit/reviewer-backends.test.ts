import { describe, expect, it } from "vitest";
import { parseAssentorConfig } from "../../src/config/load.js";
import {
  selectReviewerBackends,
  transportsForProvider,
  formatReviewerBackend,
  getAvailableReviewerProviders,
} from "../../src/review/backends.js";
import { explainReviewPlan, TaskComplexityAnalyzer } from "../../src/review/complexity.js";

describe("reviewer backends", () => {
  it("lists API and CLI transports per provider", () => {
    expect(transportsForProvider("gemini")).toEqual(["api"]);
    expect(transportsForProvider("antigravity")).toEqual(["cli"]);
    expect(transportsForProvider("claude")).toEqual(["cli"]);
    expect(transportsForProvider("openai")).toEqual(["api"]);
    expect(transportsForProvider("mock")).toEqual(["api"]);
  });

  it("uses the full list except SINGLE which takes the first", () => {
    const config = parseAssentorConfig({
      reviewers: [
        { provider: "gemini", transport: "api", name: "personal" },
        { provider: "claude", transport: "cli" },
      ],
      routing: { reviewStrategy: "ADAPTIVE" },
    });
    expect(selectReviewerBackends(config)).toHaveLength(2);

    config.routing.reviewStrategy = "SINGLE";
    expect(selectReviewerBackends(config).map((r) => r.provider)).toEqual([
      "gemini",
    ]);
  });

  it("formats a mixed panel row", () => {
    expect(
      formatReviewerBackend({
        provider: "gemini",
        role: "general",
        transport: "api",
        name: "personal",
      }),
    ).toBe("Gemini  api  personal");
  });

  it("explains a goal with configured backends", () => {
    const plan = new TaskComplexityAnalyzer().analyze({
      taskText: "Add OAuth login with JWT refresh and harden auth middleware",
    });
    const explained = explainReviewPlan(plan, [
      { provider: "gemini", transport: "api" },
      { provider: "claude", transport: "cli" },
    ]);
    expect(explained.backends.join(" ")).toMatch(/Gemini via API/i);
    expect(explained.backends.join(" ")).toMatch(/Claude via CLI/i);
    expect(explained.backendHint).toBeUndefined();

    const empty = explainReviewPlan(plan, []);
    expect(empty.backendHint).toMatch(/Configure/i);
  });

  it("filters unavailable CLIs from the reviewer add list", () => {
    const available = getAvailableReviewerProviders();
    expect(available).toContain("mock");
    expect(available).toContain("gemini");
    expect(available).toContain("openai");
  });
});
