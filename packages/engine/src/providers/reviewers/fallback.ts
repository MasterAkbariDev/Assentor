import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "./types.js";

export interface FallbackReviewerOptions {
  /**
   * Stable logical agent id — preserved across primary → fallback switches.
   */
  name: string;
  primary: Reviewer;
  fallback: Reviewer;
  onStatus?: (message: string) => void;
}

/**
 * Tries the primary reviewer transport; on failure keeps the logical id and
 * switches to the fallback transport/provider.
 */
export class FallbackReviewer implements Reviewer {
  readonly name: string;
  private readonly primary: Reviewer;
  private readonly fallback: Reviewer;
  private readonly onStatus?: (message: string) => void;
  callCount = 0;
  /** Which transport last succeeded: primary | fallback */
  lastUsed: "primary" | "fallback" | undefined;
  lastPrimaryError?: string;

  constructor(options: FallbackReviewerOptions) {
    this.name = options.name;
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.onStatus = options.onStatus;
  }

  async review(input: ReviewInput): Promise<ReviewerTurnResult> {
    return this.turn("review", input);
  }

  async continue(input: ReviewContinuation): Promise<ReviewerTurnResult> {
    return this.turn("continue", input);
  }

  private async turn(
    method: "review" | "continue",
    input: ReviewInput | ReviewContinuation,
  ): Promise<ReviewerTurnResult> {
    this.callCount += 1;

    const primaryResult = await this.safeCall(this.primary, method, input);
    if (!isTransportFailure(primaryResult)) {
      this.lastUsed = "primary";
      return primaryResult;
    }

    this.lastPrimaryError =
      primaryResult.error ?? "Primary reviewer returned no result";
    this.onStatus?.(
      `Primary reviewer failed (${this.lastPrimaryError}); switching to fallback…`,
    );

    const fallbackResult = await this.safeCall(this.fallback, method, input);
    this.lastUsed = "fallback";

    if (isTransportFailure(fallbackResult)) {
      return {
        error: [
          `Primary failed: ${this.lastPrimaryError}`,
          `Fallback failed: ${fallbackResult.error ?? "no result"}`,
        ].join("\n"),
        rawOutput: fallbackResult.rawOutput ?? primaryResult.rawOutput,
      };
    }

    return fallbackResult;
  }

  private async safeCall(
    reviewer: Reviewer,
    method: "review" | "continue",
    input: ReviewInput | ReviewContinuation,
  ): Promise<ReviewerTurnResult> {
    try {
      if (method === "review") {
        return await reviewer.review(input as ReviewInput);
      }
      return await reviewer.continue(input as ReviewContinuation);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Transport/provider failure — not a legitimate NEEDS_WORK/BLOCKED decision.
 */
export function isTransportFailure(result: ReviewerTurnResult): boolean {
  if (result.error) {
    return true;
  }
  if (!result.result && !(result.messages && result.messages.length > 0)) {
    return true;
  }
  return false;
}
