import { describe, expect, it } from "vitest";
import {
  parseArchitectureSummary,
  parseExecutorExplanation,
} from "../../src/review/pack-builder.js";

describe("local evidence parsing", () => {
  it("extracts architecture summary from executor JSON output", () => {
    const text = JSON.stringify({
      architectureSummary: "Supervisor owns the loop",
      whatChanged: "src/orchestrator/supervisor.ts",
    });
    expect(parseArchitectureSummary(text)).toBe("Supervisor owns the loop");
    expect(parseExecutorExplanation(text).whatChanged).toContain("supervisor.ts");
  });

  it("returns undefined when no architecture summary is present", () => {
    expect(parseArchitectureSummary("plain text only")).toBeUndefined();
  });
});
