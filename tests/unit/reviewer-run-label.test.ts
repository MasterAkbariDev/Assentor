import { describe, expect, it } from "vitest";
import { formatReviewerRunLabel } from "../../src/review/backends.js";

describe("formatReviewerRunLabel", () => {
  it("shows provider and logical role when they differ", () => {
    expect(
      formatReviewerRunLabel("general-reviewer", {
        provider: "cursor",
        role: "general",
        transport: "cli",
      }),
    ).toBe("Cursor (general-reviewer)");
  });

  it("shows provider only when names match", () => {
    expect(
      formatReviewerRunLabel("cursor", {
        provider: "cursor",
        role: "general",
        transport: "cli",
      }),
    ).toBe("Cursor");
  });
});
