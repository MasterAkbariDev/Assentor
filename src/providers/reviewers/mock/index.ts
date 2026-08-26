import { ReviewStatus, Severity } from "../../../core/types.js";
import { MessageType, type ProtocolMessage } from "../../../protocol/messages.js";
import {
  makeReviewResult,
  type ReviewResult,
} from "../../../protocol/review-result.js";
import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "../types.js";

export type MockReviewerStep =
  | {
      type: "pass";
      summary?: string;
      confidence?: number;
    }
  | {
      type: "needs_work";
      summary?: string;
      requiredChanges?: string[];
      issueId?: string;
      confidence?: number;
    }
  | {
      type: "evidence";
      summary?: string;
      path?: string;
      confidence?: number;
    }
  | {
      type: "blocked";
      summary?: string;
      confidence?: number;
    }
  | {
      type: "failed";
      summary?: string;
      confidence?: number;
    }
  | {
      type: "custom";
      result?: ReviewResult;
      messages?: ProtocolMessage[];
      error?: string;
    };

export interface MockReviewerOptions {
  name?: string;
  /**
   * Scripted turns consumed in order for review/continue calls.
   * When exhausted, defaults to PASS.
   */
  steps?: MockReviewerStep[];
  /**
   * If true and inbound contains EVIDENCE_RESPONSE, auto-PASS when no steps left.
   */
  passAfterEvidence?: boolean;
}

/**
 * Deterministic reviewer for orchestration tests (no provider API calls).
 */
export class MockReviewer implements Reviewer {
  readonly name: string;
  private readonly steps: MockReviewerStep[];
  private stepIndex = 0;
  private readonly passAfterEvidence: boolean;
  callCount = 0;

  constructor(options: MockReviewerOptions = {}) {
    this.name = options.name ?? "mock";
    this.steps = [...(options.steps ?? [])];
    this.passAfterEvidence = options.passAfterEvidence ?? true;
  }

  async review(input: ReviewInput): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  async continue(input: ReviewContinuation): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  remainingSteps(): number {
    return Math.max(0, this.steps.length - this.stepIndex);
  }

  private turn(input: ReviewInput | ReviewContinuation): ReviewerTurnResult {
    this.callCount += 1;

    const step = this.nextStep();
    if (step) {
      return this.fromStep(step, input);
    }

    const hasEvidence = (input.messages ?? []).some(
      (message) => message.type === MessageType.EvidenceResponse,
    );

    if (this.passAfterEvidence && hasEvidence) {
      return {
        result: passResult("Evidence received; acceptance criteria satisfied"),
      };
    }

    return {
      result: passResult("Mock reviewer default PASS"),
    };
  }

  private nextStep(): MockReviewerStep | undefined {
    if (this.stepIndex >= this.steps.length) {
      return undefined;
    }
    const step = this.steps[this.stepIndex];
    this.stepIndex += 1;
    return step;
  }

  private fromStep(
    step: MockReviewerStep,
    input: ReviewInput | ReviewContinuation,
  ): ReviewerTurnResult {
    switch (step.type) {
      case "pass":
        return {
          result: passResult(
            step.summary ?? "Mock reviewer PASS",
            step.confidence ?? 0.95,
          ),
        };
      case "needs_work":
        return {
          result: makeReviewResult({
            status: ReviewStatus.NeedsWork,
            confidence: step.confidence ?? 0.9,
            summary: step.summary ?? "Mock reviewer NEEDS_WORK",
            issues: [
              {
                id: step.issueId ?? "MOCK-001",
                severity: Severity.Major,
                description: step.summary ?? "Required changes outstanding",
                evidence: input.artifacts.map((artifact) => artifact.id),
              },
            ],
            requiredChanges: step.requiredChanges ?? ["Address mock findings"],
            optionalChanges: [],
            evidenceRequests: [],
          }),
        };
      case "evidence":
        return {
          result: makeReviewResult({
            status: ReviewStatus.NeedsWork,
            confidence: step.confidence ?? 0.5,
            summary: step.summary ?? "Need more evidence",
            issues: [],
            requiredChanges: [],
            optionalChanges: [],
            evidenceRequests: [
              {
                kind: "file",
                path: step.path ?? "src/example.ts",
                description: "Mock evidence request",
              },
            ],
          }),
        };
      case "blocked":
        return {
          result: makeReviewResult({
            status: ReviewStatus.Blocked,
            confidence: step.confidence ?? 0.8,
            summary: step.summary ?? "Mock reviewer BLOCKED",
            issues: [],
            requiredChanges: [],
            optionalChanges: [],
            evidenceRequests: [],
          }),
        };
      case "failed":
        return {
          result: makeReviewResult({
            status: ReviewStatus.Failed,
            confidence: step.confidence ?? 1,
            summary: step.summary ?? "Mock reviewer FAILED",
            issues: [],
            requiredChanges: [],
            optionalChanges: [],
            evidenceRequests: [],
          }),
        };
      case "custom":
        return {
          result: step.result,
          messages: step.messages,
          error: step.error,
        };
      default: {
        const _exhaustive: never = step;
        return _exhaustive;
      }
    }
  }
}

function passResult(summary: string, confidence = 0.95): ReviewResult {
  return makeReviewResult({
    status: ReviewStatus.Pass,
    confidence,
    summary,
    issues: [],
    requiredChanges: [],
    optionalChanges: [],
    evidenceRequests: [],
  });
}

/** Convenience factory used by tests and future CLI `--reviewer mock`. */
export function createPassingMockReviewer(name = "mock"): MockReviewer {
  return new MockReviewer({ name, steps: [{ type: "pass" }] });
}
