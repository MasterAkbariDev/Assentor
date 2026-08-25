import { describe, expect, it } from "vitest";
import {
  createEmptyContract,
  hasAcceptanceCriteria,
  mergeAcceptanceCriteria,
  parseTaskContract,
  ValidationError,
} from "../../src/index.js";

describe("task contract", () => {
  it("creates an empty contract from a goal", () => {
    const contract = createEmptyContract("  Add average helper  ");
    expect(contract).toEqual({
      goal: "Add average helper",
      requirements: [],
      constraints: [],
      acceptanceCriteria: [],
      nonGoals: [],
      verificationPlan: [],
    });
    expect(hasAcceptanceCriteria(contract)).toBe(false);
  });

  it("rejects empty goals", () => {
    expect(() => createEmptyContract("   ")).toThrow(ValidationError);
  });

  it("parses a valid contract", () => {
    const parsed = parseTaskContract({
      goal: "Ship feature",
      requirements: ["tests"],
      constraints: ["no network"],
      acceptanceCriteria: ["tests pass"],
      nonGoals: ["UI"],
      verificationPlan: ["run vitest"],
    });
    expect(parsed.goal).toBe("Ship feature");
    expect(hasAcceptanceCriteria(parsed)).toBe(true);
  });

  it("rejects malformed contracts", () => {
    expect(() => parseTaskContract({ goal: "" })).toThrow(ValidationError);
    expect(() =>
      parseTaskContract({
        goal: "x",
        requirements: "not-an-array",
      }),
    ).toThrow(ValidationError);
  });

  it("merges acceptance criteria without duplicates", () => {
    const base = createEmptyContract("goal");
    const once = mergeAcceptanceCriteria(base, ["A", "B", "  "]);
    const twice = mergeAcceptanceCriteria(once, ["B", "C", "A"]);

    expect(once.acceptanceCriteria).toEqual(["A", "B"]);
    expect(twice.acceptanceCriteria).toEqual(["A", "B", "C"]);
    expect(base.acceptanceCriteria).toEqual([]);
  });
});
