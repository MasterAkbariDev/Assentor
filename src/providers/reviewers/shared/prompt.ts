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
import type { PhaseProgress } from "../../../protocol/review-result.js";
import type { ProjectReviewEvidencePack } from "../../../review/evidence-pack.js";
import { evidencePackToMarkdown } from "../../../review/persist.js";
import type { AIImagePart } from "../../ai/types.js";
import { ArtifactType } from "../../../artifacts/types.js";

export function buildReviewPrompt(input: {
  contract: TaskContract;
  round: number;
  artifacts: ReviewArtifactRef[];
  messages?: ProtocolMessage[];
  evidencePack?: ProjectReviewEvidencePack;
  specialtyAddendum?: string;
  phaseProgress?: PhaseProgress;
  autopilot?: boolean;
}): string {
  const packBlock = input.evidencePack
    ? formatEvidencePackForPrompt(input.evidencePack)
    : "";

  const artifactBlock = input.artifacts
    .slice(0, 24)
    .map((artifact) => {
      const header = `- (${artifact.type}) ${artifact.path ?? artifact.id}: ${artifact.description ?? ""}`;
      if (isVisionArtifact(artifact)) {
        return `${header} [attached as vision input]`;
      }
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
    ...(input.autopilot
      ? [
          "## MULTI-PHASE TASK STEERING INSTRUCTIONS:",
          "1. Large tasks must be broken down into ordered phases (e.g. Phase 1, Phase 2, Phase 3).",
          "2. If contract.phases is empty, infer a roadmap from the goal and return it in `phases`.",
          "3. If the executor only completed an intermediate phase and stopped or asked \"Should I proceed?\":",
          "   - DO NOT mark the task as PASS if later phases or acceptance criteria remain unfulfilled.",
          "   - Mark status as NEEDS_WORK.",
          "   - Update `phaseProgress.completedPhaseIds` with the verified phase.",
          "   - In `phaseProgress.nextPhaseDirective`, provide commanding instructions for the next phase:",
          "     \"Phase [X] verified. You are in autonomous execution mode. Proceed immediately to Phase [X+1]: [Specific steps]. Do NOT stop or ask for confirmation.\"",
          "4. If evidence pack `executorStalledWaitingForConfirmation` is true, treat it as a sub-phase pause — not PASS.",
          "5. Only output status: PASS when ALL phases and ALL acceptance criteria are completely implemented and verified by evidence.",
          "",
        ]
      : []),
    "Git / evidence rules:",
    "- Section G lists files changed since TASK START (later commits + uncommitted). A clean working tree with a non-empty changed list means the executor already committed — that is valid evidence.",
    "- Do NOT require git add, git commit, or staging unless the task contract explicitly asks for a commit.",
    "- Section D lists file paths; inlined bodies appear under ## File contents below.",
    "- Section C architecture, Section K executor explanation, and docs/architecture.md in File contents all count as architecture evidence.",
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
        phaseProgress: {
          currentPhaseId: "phase-2",
          completedPhaseIds: ["phase-1"],
          nextPhaseDirective:
            "Phase 1 verified. Autonomous mode. Proceed immediately to Phase 2. Do NOT ask for confirmation.",
          allPhasesComplete: false,
        },
        phases: [
          {
            id: "phase-1",
            title: "Schema",
            status: "completed",
            acceptanceCriteria: [],
          },
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
    input.phaseProgress
      ? `Latest phase progress:\n${JSON.stringify(input.phaseProgress, null, 2)}\n`
      : "",
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

const MAX_INLINED_FILES = 16;
const MAX_INLINED_FILE_CHARS = 8_000;
const PARTIAL_LABEL = "Partially delivered (cut off): ";
const OMITTED_LABEL = "Not delivered (request via evidenceRequests if needed): ";

export function formatEvidencePackForPrompt(
  pack: ProjectReviewEvidencePack,
  maxChars = 48_000,
): string {
  const md = evidencePackToMarkdown(pack);
  const files = [...pack.relevantFiles, ...pack.unchangedImportant];
  const sections = files.slice(0, MAX_INLINED_FILES).map((f) => {
    if (!f.content) return `- \`${f.path}\` (${f.role}) — content not inlined`;
    return [
      `### ${f.path} [${f.role}]`,
      "```",
      truncate(f.content, MAX_INLINED_FILE_CHARS),
      "```",
    ].join("\n");
  });

  const depExcerpt = pack.dependencies.manifestExcerpt
    ? `### package.json\n\`\`\`\n${truncate(pack.dependencies.manifestExcerpt, 3_000)}\n\`\`\``
    : "";

  const gitDiff = pack.git.diff
    ? `### Diff\n\`\`\`\n${truncate(pack.git.diff, 12_000)}\n\`\`\``
    : "";

  const beforeFiles = [md, "", "## File contents", ""].join("\n");
  const evidence = [
    beforeFiles + (sections.join("\n\n") || "(none)"),
    "",
    depExcerpt,
    gitDiff,
  ].join("\n");

  // Decision-critical sections sit outside the evidence budget so truncating
  // a large pack can never drop them. Reserve room for the longest possible
  // coverage report (every file listed once, both labels present).
  const reserve =
    decisionSections(pack, files.length, [], files.map((f) => f.path), true)
      .length +
    PARTIAL_LABEL.length +
    32;
  const budget = Math.max(0, maxChars - reserve);
  const evidenceTruncated = evidence.length > budget;
  const kept = evidenceTruncated ? budget : evidence.length;

  // Classify each file by how much of its body survived the budget.
  const partial: string[] = [];
  const omitted: string[] = [];
  let offset = beforeFiles.length;
  files.forEach((f, i) => {
    const section = sections[i];
    if (section === undefined || !f.content) {
      omitted.push(f.path);
    } else if (offset >= kept) {
      omitted.push(f.path);
    } else if (
      offset + section.length > kept ||
      f.truncated ||
      f.content.length > MAX_INLINED_FILE_CHARS
    ) {
      partial.push(f.path);
    }
    if (section !== undefined) offset += section.length + 2;
  });

  const evidenceBlock = evidenceTruncated ? truncate(evidence, budget) : evidence;
  return `${evidenceBlock}\n${decisionSections(pack, files.length, partial, omitted, evidenceTruncated)}`;
}

function decisionSections(
  pack: ProjectReviewEvidencePack,
  fileCount: number,
  partial: string[],
  omitted: string[],
  evidenceTruncated: boolean,
): string {
  const list = (paths: string[]) => paths.map((p) => `\`${p}\``).join(", ");
  const full = fileCount - partial.length - omitted.length;
  return [
    "",
    "## Evidence coverage",
    `File bodies for ${fileCount} collected files: ${full} delivered in full, ${partial.length} partially, ${omitted.length} not delivered.`,
    partial.length > 0 ? `${PARTIAL_LABEL}${list(partial)}` : "",
    omitted.length > 0 ? `${OMITTED_LABEL}${list(omitted)}` : "",
    evidenceTruncated
      ? "Evidence above was cut to fit the prompt budget; anything cut off was not reviewed."
      : "",
    "",
    "## Executor claims vs evidence",
    `Explanation source: ${pack.executorExplanation.source}`,
    pack.executorExplanation.whatChanged ||
      pack.executorExplanation.raw ||
      "(no executor explanation)",
    `Architecture source: ${pack.architecture.source}`,
    pack.architecture.summary || "(no architecture summary)",
    pack.executorStalledWaitingForConfirmation
      ? "\n## Stall signal\nExecutor appears stalled waiting for confirmation to proceed to the next phase. Do NOT PASS. Issue a nextPhaseDirective."
      : "",
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
    evidencePack: "evidencePack" in input ? input.evidencePack : undefined,
    phaseProgress: "phaseProgress" in input ? input.phaseProgress : undefined,
    autopilot: "autopilot" in input ? input.autopilot : undefined,
  };
}

/** Extract base64 screenshots for vision-capable reviewers (e.g. Gemini). */
export function extractReviewImages(input: {
  artifacts?: ReviewArtifactRef[];
}): AIImagePart[] {
  const images: AIImagePart[] = [];
  const seen = new Set<string>();
  for (const artifact of input.artifacts ?? []) {
    if (!isVisionArtifact(artifact) || !artifact.content) {
      continue;
    }
    const key = artifact.path ?? artifact.id;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const mimeType =
      typeof artifact.metadata?.mimeType === "string"
        ? artifact.metadata.mimeType
        : "image/png";
    images.push({
      mimeType,
      data: artifact.content,
      label: artifact.description ?? artifact.path ?? artifact.id,
    });
    if (images.length >= 6) {
      break;
    }
  }
  return images;
}

function isVisionArtifact(artifact: ReviewArtifactRef): boolean {
  if (artifact.type === ArtifactType.Screenshot) {
    return true;
  }
  return artifact.metadata?.encoding === "base64";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n…[truncated]`;
}

export type { ReviewResult };
