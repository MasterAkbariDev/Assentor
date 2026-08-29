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
      phases: [],
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
    expect(parsed.phases).toEqual([]);
  });

  it("parses a multi-phase contract", () => {
    const parsed = parseTaskContract({
      goal: "Build the app",
      requirements: [],
      constraints: [],
      acceptanceCriteria: ["all phases done"],
      nonGoals: [],
      verificationPlan: [],
      phases: [
        {
          id: "p1",
          title: "Schema",
          status: "completed",
          acceptanceCriteria: ["tables exist"],
        },
        { id: "p2", title: "API" },
      ],
    });
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.phases[0]?.status).toBe("completed");
    expect(parsed.phases[1]?.status).toBe("pending");
    expect(parsed.phases[1]?.acceptanceCriteria).toEqual([]);
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
