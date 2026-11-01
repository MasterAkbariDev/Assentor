import type { TaskContract } from "../../core/task-contract.js";
import type { ProtocolMessage } from "#assentor/protocol/messages.js";
import type { ReviewResult, PhaseProgress } from "#assentor/protocol/review-result.js";
import type { ProjectReviewEvidencePack } from "../../review/evidence-pack.js";
import type { CorrelatedFinding } from "../../review/ranking.js";
import type { CliUsage } from "../../usage/cli-usage.js";

export interface ReviewInput {
  taskId: string;
  projectPath: string;
  contract: TaskContract;
  round: number;
  artifacts: ReviewArtifactRef[];
  messages?: ProtocolMessage[];
  /** Structured evidence pack (preferred over raw artifacts alone). */
  evidencePack?: ProjectReviewEvidencePack;
  /** Latest phase steering state from prior rounds. */
  phaseProgress?: PhaseProgress;
  /** When true, reviewer should steer multi-phase work autonomously. */
  autopilot?: boolean;
  /** `context.budgetTokens.reviewer` (TE-03), set by the host from the config; unset = no budget cuts. */
  contextBudgetTokens?: number;
}

export interface ReviewContinuation {
  taskId: string;
  projectPath: string;
  contract: TaskContract;
  round: number;
  messages: ProtocolMessage[];
  artifacts: ReviewArtifactRef[];
  evidencePack?: ProjectReviewEvidencePack;
  phaseProgress?: PhaseProgress;
  autopilot?: boolean;
  contextBudgetTokens?: number;
}

export interface ReviewArtifactRef {
  id: string;
  type: string;
  path?: string;
  description?: string;
  content?: string;
  metadata?: Record<string, unknown>;
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
  /**
   * With `error`: whether retrying the same turn may succeed (e.g. a panel that
   * was inconclusive because a member timed out). Unset means the caller
   * decides from the error text.
   */
  retryable?: boolean;
  /** Token use of this turn when the transport reports it (API seats, Claude Code CLI) (TE-05). */
  usage?: CliUsage;
  /** The model the provider reported for this turn (FU-17); unset = unverified, never the requested model. */
  model?: string;
  /** Set by a panel: each member's reported token use, by the member's seat id. */
  memberUsage?: Array<{ seatId: string; usage: CliUsage }>;
  /** Set by a panel with a result: its decision policy and the findings correlated across members. */
  policy?: string;
  correlated?: CorrelatedFinding[];
}

/**
 * Provider-independent reviewer adapter.
 * Implementations live under src/providers/reviewers/<provider>/.
 */
export interface Reviewer {
  readonly name: string;
  review(input: ReviewInput): Promise<ReviewerTurnResult>;
  continue(input: ReviewContinuation): Promise<ReviewerTurnResult>;
  /** Model for the next turn (`AUTO` = default). Absent when the reviewer cannot switch models. */
  setModel?(model: string): void;
}
