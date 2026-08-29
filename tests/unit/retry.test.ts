import { describe, expect, it } from "vitest";
import {
  isRetryableExecutorResult,
  isRetryableReviewFailure,
  retryDelayMs,
} from "../../src/core/retry.js";
import { ReviewStatus } from "../../src/core/types.js";
import { makeReviewResult } from "../../src/protocol/review-result.js";

describe("retry helpers", () => {
  it("debounces retries linearly", () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(3)).toBe(6_000);
  });

  it("retries executor timeouts and transient failures", () => {
    expect(
      isRetryableExecutorResult({
        status: "timeout",
        summary: "Antigravity timed out",
      }),
    ).toBe(true);
    expect(
      isRetryableExecutorResult({
        status: "failed",
        summary: "Antigravity: timeout waiting for response",
      }),
    ).toBe(true);
    expect(
      isRetryableExecutorResult({
        status: "failed",
        summary: "Authentication required",
        error: "invalid api key",
      }),
    ).toBe(false);
    expect(
      isRetryableExecutorResult({
        status: "completed",
        summary: "done",
      }),
    ).toBe(false);
  });

  it("retries reviewer rate limits and network failures", () => {
    expect(
      isRetryableReviewFailure(
        makeReviewResult({
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: "429 rate limit exceeded",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableReviewFailure(
        makeReviewResult({
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: "Invalid API key",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      ),
    ).toBe(false);
  });
});
