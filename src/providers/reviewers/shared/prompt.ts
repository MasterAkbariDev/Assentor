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
import type { ProjectReviewEvidencePack } from "../../../review/evidence-pack.js";
import { evidencePackToMarkdown } from "../../../review/persist.js";

export function buildReviewPrompt(input: {
  contract: TaskContract;
  round: number;
  artifacts: ReviewArtifactRef[];
  messages?: ProtocolMessage[];
  evidencePack?: ProjectReviewEvidencePack;
  specialtyAddendum?: string;
}): string {
  const packBlock = input.evidencePack
    ? formatEvidencePackForPrompt(input.evidencePack)
    : "";

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
    "Never invent file contents, test results, git state, or architecture.",
    "Treat executor claims as claims — verify against evidence pack artifacts.",
    "Evaluate only against the task contract and provided evidence.",
    "Every issue must cite evidence (file path, diff hunk, command output, or pack section).",
    "",
    "Git / evidence rules:",
    "- Section G lists files changed since TASK START (later commits + uncommitted). A clean working tree with a non-empty changed list means the executor already committed — that is valid evidence.",
    "- Do NOT require git add, git commit, or staging unless the task contract explicitly asks for a commit.",
    "- If claimed files appear in the pack with contents (Section D / File contents), review those files. Only evidenceRequest a file that is still missing.",
    "- NOT_RUN for tests/build/lint is not by itself NEEDS_WORK unless the contract requires that verification.",
    "",
    "Return ONLY valid JSON matching this schema:",
    JSON.stringify(
      {
        status: "PASS | NEEDS_WORK | BLOCKED | FAILED",
        confidence: 0.85,
        summary: "string",
        architectureAssessment: { status: "ok|concern|unknown", summary: "string" },
        requirementsAssessment: [
          { criterion: "string", satisfied: true, notes: "string" },
        ],
        issues: [
          {
            id: "ID",
            severity: "blocker|major|minor|info",
            category:
              "architecture|correctness|testing|security|performance|maintainability|requirements|integration|other",
            description: "string",
            evidence: ["string"],
            affectedFiles: ["path"],
          },
        ],
        requiredChanges: ["string"],
        optionalChanges: ["string"],
        evidenceRequests: [
          { kind: "file", path: "relative/path.ts" },
          { kind: "search", query: "symbolOrText" },
          { kind: "command", command: "npm test" },
        ],
        verification: {
          tests: "PASSED|FAILED|NOT_RUN",
          build: "NOT_RUN",
          lint: "NOT_RUN",
          typecheck: "NOT_RUN",
        },
      },
      null,
      2,
    ),
    "Rules: confidence MUST be a float between 0 and 1 inclusive (e.g. 0.85). Do NOT use 0–100 percentages.",
    "issues[].evidence and issues[].affectedFiles MUST be JSON arrays of strings, never a single string.",
    "requiredChanges and optionalChanges MUST be JSON arrays of strings.",
    "",
    input.specialtyAddendum ? `${input.specialtyAddendum}\n` : "",
    `Round: ${input.round}`,
    "Task contract:",
    JSON.stringify(input.contract, null, 2),
    "",
    "Evidence pack (scoped — request more if needed):",
    packBlock || "(none — request evidence via evidenceRequests)",
    "",
    "Additional artifacts:",
    artifactBlock || "(none)",
    "",
    "Recent messages:",
    messageBlock || "(none)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function formatEvidencePackForPrompt(
  pack: ProjectReviewEvidencePack,
  maxChars = 48_000,
): string {
  const md = evidencePackToMarkdown(pack);
  const fileBodies = [...pack.relevantFiles, ...pack.unchangedImportant]
    .slice(0, 16)
    .map((f) => {
      if (!f.content) return `- \`${f.path}\` (${f.role}) — content not inlined`;
      return [
        `### ${f.path} [${f.role}]`,
        "```",
        truncate(f.content, 8_000),
        "```",
      ].join("\n");
    })
    .join("\n\n");

  const depExcerpt = pack.dependencies.manifestExcerpt
    ? `### package.json\n\`\`\`\n${truncate(pack.dependencies.manifestExcerpt, 3_000)}\n\`\`\``
    : "";

  const gitDiff = pack.git.diff
    ? `### Diff\n\`\`\`\n${truncate(pack.git.diff, 12_000)}\n\`\`\``
    : "";

  const combined = [
    md,
    "",
    "## File contents",
    fileBodies || "(none)",
    "",
    depExcerpt,
    gitDiff,
    "",
    "## Executor claims vs evidence",
    `Explanation source: ${pack.executorExplanation.source}`,
    pack.executorExplanation.whatChanged ||
      pack.executorExplanation.raw ||
      "(no executor explanation)",
    `Architecture source: ${pack.architecture.source}`,
    pack.architecture.summary || "(no architecture summary)",
  ].join("\n");

  return truncate(combined, maxChars);
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
    evidencePack: "evidencePack" in input ? input.evidencePack : undefined,
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n…[truncated]`;
}

export type { ReviewResult };
