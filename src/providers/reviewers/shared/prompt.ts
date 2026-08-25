import { parseReviewResult } from "../../../protocol/parse.js";
import type { ReviewResult } from "../../../protocol/review-result.js";
import type {
  ReviewArtifactRef,
  ReviewContinuation,
  ReviewInput,
  ReviewerTurnResult,
} from "../types.js";
import type { TaskContract } from "../../../core/task-contract.js";
import type { ProtocolMessage } from "../../../protocol/messages.js";

export function buildReviewPrompt(input: {
  contract: TaskContract;
  round: number;
  artifacts: ReviewArtifactRef[];
  messages?: ProtocolMessage[];
}): string {
  const artifactBlock = input.artifacts
    .slice(0, 24)
    .map((artifact) => {
      const header = `- (${artifact.type}) ${artifact.path ?? artifact.id}: ${artifact.description ?? ""}`;
      const limit = artifact.type === "file" ? 24_000 : 4_000;
      const body = artifact.content
        ? `\n\`\`\`\n${truncate(artifact.content, limit)}\n\`\`\``
        : "";
      return `${header}${body}`;
    })
    .join("\n");

  const messageBlock = (input.messages ?? [])
    .slice(-10)
    .map(
      (message) =>
        `- [${message.type}] ${message.from} → ${message.to}: ${JSON.stringify(message.content)}`,
    )
    .join("\n");

  return [
    "You are a strict software review agent for Assentor.",
    "Do NOT guess about project state. If evidence is insufficient, return NEEDS_WORK with evidenceRequests.",
    "Never invent file contents, test results, or git state.",
    "Evaluate only against the task contract and provided evidence.",
    "",
    "Return ONLY valid JSON matching this schema:",
    JSON.stringify(
      {
        status: "PASS | NEEDS_WORK | BLOCKED | FAILED",
        confidence: 0.85,
        summary: "string",
        issues: [
          {
            id: "ID",
            severity: "blocker|major|minor|info",
            description: "string",
            evidence: ["string"],
          },
        ],
        requiredChanges: ["string"],
        optionalChanges: ["string"],
        evidenceRequests: [
          { kind: "file", path: "relative/path.ts" },
          { kind: "command", command: "npm test" },
        ],
      },
      null,
      2,
    ),
    "Rules: confidence MUST be a float between 0 and 1 inclusive (e.g. 0.85). Do NOT use 0–100 percentages.",
    "",
    `Round: ${input.round}`,
    "Task contract:",
    JSON.stringify(input.contract, null, 2),
    "",
    "Artifacts:",
    artifactBlock || "(none)",
    "",
    "Recent messages:",
    messageBlock || "(none)",
  ].join("\n");
}

export function reviewResultFromModelText(raw: string): ReviewerTurnResult {
  const parsed = parseReviewResult(raw);
  if (!parsed.ok) {
    return {
      error: parsed.error,
      rawOutput: typeof raw === "string" ? raw : JSON.stringify(raw),
      result: undefined,
    };
  }

  return {
    result: parsed.data,
    rawOutput: typeof raw === "string" ? raw : JSON.stringify(raw),
  };
}

export function asReviewInput(
  input: ReviewInput | ReviewContinuation,
): ReviewInput {
  return {
    taskId: input.taskId,
    projectPath: input.projectPath,
    contract: input.contract,
    round: input.round,
    artifacts: input.artifacts,
    messages: input.messages,
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n…[truncated]`;
}

export type { ReviewResult };
