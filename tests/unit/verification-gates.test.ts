import { describe, expect, it } from "vitest";
import {
  applyGateRunsToPack,
  emptyEvidencePack,
  ReviewStatus,
  runVerificationGates,
  syntheticNeedsWorkFromGates,
} from "../../src/index.js";

describe("verification gates", () => {
  it("skips missing commands and treats them as NOT_RUN", async () => {
    const result = await runVerificationGates({
      projectPath: "/tmp",
      commands: { typecheck: "", test: "", lint: "", build: "" },
      skipReviewOnFailure: {
        typecheck: true,
        build: true,
        test: true,
        lint: false,
      },
      runCommand: async () => {
        throw new Error("should not run");
      },
    });
    expect(result.passed).toBe(true);
    expect(result.hardFailures).toHaveLength(0);
    expect(result.runs.every((run) => run.status === "NOT_RUN")).toBe(true);
  });

  it("short-circuits on hard typecheck failure", async () => {
    const result = await runVerificationGates({
      projectPath: "/tmp",
      commands: {
        typecheck: "npx tsc --noEmit",
        test: "",
        lint: "pnpm lint",
        build: "",
      },
      skipReviewOnFailure: {
        typecheck: true,
        build: true,
        test: true,
        lint: false,
      },
      runCommand: async (command) => {
        if (command.includes("tsc")) {
          return { stdout: "", stderr: "error TS2322", code: 1 };
        }
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });
    expect(result.passed).toBe(false);
    expect(result.hardFailures.map((f) => f.slot)).toEqual(["typecheck"]);
  });

  it("does not skip review on lint when skipReviewOnFailure.lint is false", async () => {
    const result = await runVerificationGates({
      projectPath: "/tmp",
      commands: { typecheck: "", test: "", lint: "pnpm lint", build: "" },
      skipReviewOnFailure: {
        typecheck: true,
        build: true,
        test: true,
        lint: false,
      },
      runCommand: async () => ({ stdout: "lint error", stderr: "", code: 1 }),
    });
    expect(result.passed).toBe(true);
    expect(result.runs.find((r) => r.slot === "lint")?.status).toBe("FAILED");
  });

  it("builds synthetic NEEDS_WORK with stdout and a next-phase directive", () => {
    const review = syntheticNeedsWorkFromGates({
      failures: [
        {
          slot: "typecheck",
          command: "npx tsc --noEmit",
          status: "FAILED",
          output: "error TS2322: Type 'string' is not assignable",
          exitCode: 1,
        },
      ],
      phases: [
        { id: "p1", title: "Schema", status: "completed", acceptanceCriteria: [] },
        { id: "p2", title: "API", status: "pending", acceptanceCriteria: [] },
      ],
    });
    expect(review.status).toBe(ReviewStatus.NeedsWork);
    expect(review.requiredChanges[0]).toContain("error TS2322");
    expect(review.phaseProgress?.nextPhaseDirective).toMatch(/API/);
    expect(review.verification?.typecheck).toBe("FAILED");
  });

  it("applies gate runs onto the evidence pack", () => {
    const pack = emptyEvidencePack("/tmp/p", { taskId: "t", round: 1 });
    applyGateRunsToPack(pack, [
      {
        slot: "test",
        command: "pnpm test",
        status: "PASSED",
        output: "ok",
        exitCode: 0,
      },
    ]);
    expect(pack.tests.test.status).toBe("PASSED");
    expect(pack.tests.test.command).toBe("pnpm test");
  });
});
