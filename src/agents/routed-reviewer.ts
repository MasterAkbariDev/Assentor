import {
  asReviewInput,
  buildReviewPrompt,
  reviewResultFromModelText,
} from "../providers/reviewers/shared/prompt.js";
import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "../providers/reviewers/types.js";
import type { RoutingEngine } from "../routing/engine.js";
import type { LogicalAgentProfile } from "../agents/index.js";
import type { AgentMemoryStore } from "../agents/index.js";
import { ReviewStatus } from "../core/types.js";
import type { ReviewResult } from "../protocol/review-result.js";
import { specialtyAddendum } from "../review/specialty-prompts.js";

/**
 * Reviewer bound to a logical agent identity + routing engine.
 * Provider/model/key can change without losing Assentor-owned context.
 */
export class RoutedReviewer implements Reviewer {
  readonly name: string;
  callCount = 0;

  constructor(
    private readonly profile: LogicalAgentProfile,
    private readonly routing: RoutingEngine,
    private readonly memory: AgentMemoryStore,
    private readonly projectGoal: string,
    private readonly acceptanceCriteria: string[],
  ) {
    this.name = profile.id;
  }

  async review(input: ReviewInput): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  async continue(input: ReviewContinuation): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  private async turn(
    input: ReviewInput | ReviewContinuation,
  ): Promise<ReviewerTurnResult> {
    this.callCount += 1;
    const mem = await this.memory.load(this.profile.id);
    const reviewInput = asReviewInput(input);
    const basePrompt = buildReviewPrompt({
      ...reviewInput,
      specialtyAddendum: specialtyAddendum(this.profile.specialty),
    });
    const context = this.memory.buildContextPack({
      memory: mem,
      contractGoal: this.projectGoal,
      acceptanceCriteria: this.acceptanceCriteria,
      evidence: input.artifacts
        ?.filter((a) => a.content)
        .map((a) => `${a.path ?? a.id}:\n${a.content?.slice(0, 2000)}`),
    });

    const prompt = [
      `You are logical agent "${this.profile.name}" (${this.profile.role}).`,
      this.profile.instructions,
      specialtyAddendum(this.profile.specialty),
      "",
      "Assentor-owned context (survives model/provider/key changes):",
      context,
      "",
      basePrompt,
    ].join("\n");

    try {
      const { response, decision } = await this.routing.generate({
        agentId: this.profile.id,
        preference: this.profile.routing,
        provider: this.profile.provider,
        model: this.profile.model,
        prompt,
        system: "Reply with JSON review result only.",
        jsonMode: true,
        requireStructuredOutput: true,
      });

      await this.memory.appendMessage(
        this.profile.id,
        "assistant",
        `Reviewed via ${decision.provider}/${decision.model}: ${response.text.slice(0, 500)}`,
      );

      const parsed = reviewResultFromModelText(response.text);
      if (parsed.result) {
        mem.findings.push(parsed.result.summary);
        mem.unresolvedIssues = [
          ...(parsed.result.issues ?? []).map((i) => i.description),
          ...(parsed.result.requiredChanges ?? []),
        ];
        await this.memory.save(mem);
      }
      return parsed;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface ReviewerFinding {
  agentId: string;
  result: ReviewResult;
}

export type AdjudicatorDecision =
  | "PASS"
  | "NEEDS_WORK"
  | "MORE_EVIDENCE"
  | "BLOCKED";

/**
 * Resolve disagreements between reviewers without modifying the project.
 */
export async function adjudicate(input: {
  routing: RoutingEngine;
  profile: LogicalAgentProfile;
  goal: string;
  acceptanceCriteria: string[];
  findings: ReviewerFinding[];
  evidenceSummary: string;
}): Promise<{ decision: AdjudicatorDecision; summary: string; raw?: ReviewResult }> {
  const debate = input.findings
    .map(
      (f) =>
        `- ${f.agentId}: ${f.result.status} — ${f.result.summary}\n  issues: ${(f.result.issues ?? []).map((i) => i.description).join("; ") || "(none)"}\n  required: ${(f.result.requiredChanges ?? []).join("; ") || "(none)"}`,
    )
    .join("\n");

  const prompt = [
    "You are the Assentor Adjudicator. Do NOT modify code. Decide among PASS, NEEDS_WORK, MORE_EVIDENCE, BLOCKED.",
    `Goal: ${input.goal}`,
    `Acceptance criteria: ${input.acceptanceCriteria.join("; ") || "(none)"}`,
    "Reviewer findings:",
    debate,
    "Evidence summary:",
    input.evidenceSummary || "(none)",
    "",
    'Return JSON: { "status": "PASS|NEEDS_WORK|BLOCKED|FAILED", "confidence": 0.0-1.0 (not 0-100), "summary": "...", "issues": [], "requiredChanges": [], "optionalChanges": [], "evidenceRequests": [] }',
    "Use FAILED only if adjudication itself failed. Prefer NEEDS_WORK with evidenceRequests for MORE_EVIDENCE.",
  ].join("\n");

  const { response } = await input.routing.generate({
    agentId: input.profile.id,
    preference: input.profile.routing,
    provider: input.profile.provider,
    model: input.profile.model,
    prompt,
    jsonMode: true,
    requireStructuredOutput: true,
  });

  const parsed = reviewResultFromModelText(response.text);
  if (!parsed.result) {
    return {
      decision: "BLOCKED",
      summary: parsed.error ?? "Adjudicator returned no result",
    };
  }

  if (
    parsed.result.status === ReviewStatus.NeedsWork &&
    (parsed.result.evidenceRequests?.length ?? 0) > 0
  ) {
    return {
      decision: "MORE_EVIDENCE",
      summary: parsed.result.summary,
      raw: parsed.result,
    };
  }

  const map: Record<string, AdjudicatorDecision> = {
    [ReviewStatus.Pass]: "PASS",
    [ReviewStatus.NeedsWork]: "NEEDS_WORK",
    [ReviewStatus.Blocked]: "BLOCKED",
    [ReviewStatus.Failed]: "BLOCKED",
  };

  return {
    decision: map[parsed.result.status] ?? "BLOCKED",
    summary: parsed.result.summary,
    raw: parsed.result,
  };
}

export function reviewersDisagree(findings: ReviewerFinding[]): boolean {
  if (findings.length < 2) {
    return false;
  }
  const statuses = new Set(findings.map((f) => f.result.status));
  return statuses.size > 1;
}
