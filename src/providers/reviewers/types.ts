import type { TaskContract } from "../../core/task-contract.js";
import type { ProtocolMessage } from "../../protocol/messages.js";
import type { ReviewResult } from "../../protocol/review-result.js";

export interface ReviewInput {
  taskId: string;
  projectPath: string;
  contract: TaskContract;
  round: number;
  artifacts: ReviewArtifactRef[];
  messages?: ProtocolMessage[];
}

export interface ReviewContinuation {
  taskId: string;
  projectPath: string;
  contract: TaskContract;
  round: number;
  messages: ProtocolMessage[];
  artifacts: ReviewArtifactRef[];
}

export interface ReviewArtifactRef {
  id: string;
  type: string;
  path?: string;
  description?: string;
  content?: string;
}

export interface ReviewerTurnResult {
  /**
   * Structured decision when the reviewer is ready to conclude a turn.
   * May be omitted when the reviewer only emits protocol messages
   * (e.g. evidence requests) via `messages`.
   */
  result?: ReviewResult;
  messages?: ProtocolMessage[];
  rawOutput?: string;
  error?: string;
}

/**
 * Provider-independent reviewer adapter.
 * Implementations live under src/providers/reviewers/<provider>/.
 */
export interface Reviewer {
  readonly name: string;
  review(input: ReviewInput): Promise<ReviewerTurnResult>;
  continue(input: ReviewContinuation): Promise<ReviewerTurnResult>;
}
