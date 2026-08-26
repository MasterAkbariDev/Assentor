import { describe, expect, it } from "vitest";
import {
  EvidenceKind,
  parseReviewResult,
  ReviewStatus,
  Severity,
} from "../../src/index.js";

describe("review result", () => {
  it("parses a valid NEEDS_WORK result", () => {
    const result = parseReviewResult({
      status: ReviewStatus.NeedsWork,
      confidence: 0.91,
      summary: "Missing tests",
      issues: [
        {
          id: "TEST-001",
          severity: Severity.Major,
          description: "No unit tests for average()",
          evidence: ["src/avg.ts has no companion test file"],
        },
      ],
      requiredChanges: ["Add unit tests for average()"],
      optionalChanges: [],
      evidenceRequests: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe(ReviewStatus.NeedsWork);
      expect(result.data.issues[0]?.id).toBe("TEST-001");
    }
  });

  it("accepts PASS without major issues", () => {
    const result = parseReviewResult({
      status: ReviewStatus.Pass,
      confidence: 0.97,
      summary: "Acceptance criteria met",
      issues: [],
      requiredChanges: [],
      optionalChanges: ["Consider renaming helper"],
      evidenceRequests: [],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects PASS with required changes", () => {
    const result = parseReviewResult({
      status: ReviewStatus.Pass,
      confidence: 0.9,
      summary: "Done",
      requiredChanges: ["still fix this"],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects PASS with blocker issues", () => {
    const result = parseReviewResult({
      status: ReviewStatus.Pass,
      confidence: 0.5,
      summary: "Looks fine",
      issues: [
        {
          id: "BUG-1",
          severity: Severity.Blocker,
          description: "Crashes on empty input",
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects empty NEEDS_WORK", () => {
    const result = parseReviewResult({
      status: ReviewStatus.NeedsWork,
      confidence: 0.8,
      summary: "Needs work but no details",
    });

    expect(result.ok).toBe(false);
  });

  it("allows NEEDS_WORK via evidence requests only", () => {
    const result = parseReviewResult({
      status: ReviewStatus.NeedsWork,
      confidence: 0.4,
      summary: "Insufficient evidence to decide",
      evidenceRequests: [{ kind: EvidenceKind.GitDiff }],
    });

    expect(result.ok).toBe(true);
  });

  it("coerces issue evidence from a string to an array", () => {
    const result = parseReviewResult({
      status: ReviewStatus.NeedsWork,
      confidence: 90,
      summary: "Hang not addressed",
      issues: [
        {
          id: "HANG-1",
          severity: "MAJOR",
          description: "Cursor process never exits after result",
          evidence: "src/providers/executors/cursor/index.ts",
          affectedFiles: "src/providers/executors/cursor/index.ts",
        },
        {
          description: "Missing stream parser coverage",
          evidence: "src/providers/executors/cursor/stream-status.ts",
        },
      ],
      requiredChanges: "Kill the process after the result event",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.issues[0]?.evidence).toEqual([
        "src/providers/executors/cursor/index.ts",
      ]);
      expect(result.data.issues[0]?.affectedFiles).toEqual([
        "src/providers/executors/cursor/index.ts",
      ]);
      expect(result.data.issues[0]?.severity).toBe(Severity.Major);
      expect(result.data.issues[1]?.id).toBe("ISSUE-2");
      expect(result.data.requiredChanges).toEqual([
        "Kill the process after the result event",
      ]);
    }
  });

  it("does not throw on garbage review output", () => {
    expect(parseReviewResult("totally broken").ok).toBe(false);
    expect(parseReviewResult({ status: "PASS" }).ok).toBe(false);
  });

  it("normalizes 0–100 confidence to 0–1", () => {
    const result = parseReviewResult({
      status: ReviewStatus.Pass,
      confidence: 92,
      summary: "Looks good",
      issues: [],
      requiredChanges: [],
      optionalChanges: [],
      evidenceRequests: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.confidence).toBeCloseTo(0.92);
    }
  });

  it("normalizes percentage string confidence", () => {
    const result = parseReviewResult({
      status: ReviewStatus.Pass,
      confidence: "85%",
      summary: "Looks good",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.confidence).toBeCloseTo(0.85);
    }
  });

  it("clamps confidence slightly above 1", () => {
    const result = parseReviewResult({
      status: ReviewStatus.Pass,
      confidence: 1.02,
      summary: "Looks good",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.confidence).toBe(1);
    }
  });
});
