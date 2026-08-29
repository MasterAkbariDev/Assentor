import type { ExecutorResult } from "../providers/executors/types.js";
import type { ReviewResult } from "../protocol/review-result.js";
import { ReviewStatus } from "../core/types.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_DEBOUNCE_MS = 2_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function retryDelayMs(attempt: number, baseMs = DEFAULT_RETRY_DEBOUNCE_MS): number {
  return baseMs * Math.max(1, attempt);
}

export function isRetryableExecutorResult(result: ExecutorResult): boolean {
  if (result.status === "timeout") {
    return true;
  }
  if (result.status !== "failed") {
    return false;
  }
  const message = `${result.error ?? ""} ${result.summary ?? ""}`.toLowerCase();
  if (/auth|authentication|api key|login required|permission denied/.test(message)) {
    return false;
  }
  if (/cancel|interrupt/.test(message)) {
    return false;
  }
  return /timeout|timed out|rate limit|429|503|502|504|network|econn|etimedout|temporarily unavailable|waiting for response/.test(
    message,
  );
}

export function isRetryableReviewFailure(review: ReviewResult): boolean {
  if (review.status !== ReviewStatus.Failed) {
    return false;
  }
  const message = review.summary.toLowerCase();
  if (/auth|authentication|api key|invalid key|permission denied/.test(message)) {
    return false;
  }
  return /timeout|timed out|rate limit|429|503|502|504|network|econn|etimedout|temporarily unavailable|overloaded/.test(
    message,
  );
}
