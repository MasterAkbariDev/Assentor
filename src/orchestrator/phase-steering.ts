import { ReviewStatus } from "../core/types.js";
import type { PhaseItem, TaskContract } from "../core/task-contract.js";
import type { ProtocolMessage } from "../protocol/messages.js";
import {
  makeReviewResult,
  type PhaseProgress,
  type ReviewResultParsed,
} from "../protocol/review-result.js";

const STALL_PATTERNS = [
  /should i (proceed|continue|start)/i,
  /would you like me to (proceed|continue|implement)/i,
  /let me know if you want me to/i,
  /shall i (go ahead|move to|proceed)/i,
  /ready to proceed to phase/i,
];

export function isStalledWaitingForConfirmation(rawOutput: string): boolean {
  if (!rawOutput.trim()) {
    return false;
  }
  return STALL_PATTERNS.some((pattern) => pattern.test(rawOutput));
}

export function remainingPhases(
  phases: PhaseItem[],
  progress?: PhaseProgress,
): PhaseItem[] {
  const completed = new Set(progress?.completedPhaseIds ?? []);
  return phases.filter((phase) => {
    if (completed.has(phase.id)) {
      return false;
    }
    return phase.status !== "completed";
  });
}

export function areAllPhasesComplete(
  phases: PhaseItem[],
  progress?: PhaseProgress,
): boolean {
  if (progress?.allPhasesComplete) {
    return true;
  }
  if (phases.length === 0) {
    return true;
  }
  return remainingPhases(phases, progress).length === 0;
}

export function buildNextPhaseDirective(
  completedTitle: string | undefined,
  next: PhaseItem,
): string {
  const completed =
    completedTitle?.trim() || "the previous phase";
  const criteria =
    next.acceptanceCriteria.length > 0
      ? ` Acceptance criteria: ${next.acceptanceCriteria.join("; ")}.`
      : "";
  const description = next.description?.trim()
    ? ` ${next.description.trim()}`
    : "";
  return [
    `${completed} verified. You are in autonomous execution mode.`,
    `Proceed immediately to ${next.title}:${description}${criteria}`,
    "Do NOT stop or ask for confirmation.",
  ].join(" ");
}

export function mergeContractPhases(
  contract: TaskContract,
  incoming: PhaseItem[],
): TaskContract {
  if (incoming.length === 0) {
    return contract;
  }
  const byId = new Map(contract.phases.map((phase) => [phase.id, phase]));
  for (const phase of incoming) {
    const existing = byId.get(phase.id);
    byId.set(phase.id, existing ? { ...existing, ...phase } : phase);
  }
  const merged: PhaseItem[] = [];
  const seen = new Set<string>();
  for (const phase of incoming) {
    const next = byId.get(phase.id);
    if (next && !seen.has(next.id)) {
      merged.push(next);
      seen.add(next.id);
    }
  }
  for (const phase of contract.phases) {
    if (!seen.has(phase.id)) {
      merged.push(phase);
      seen.add(phase.id);
    }
  }
  return { ...contract, phases: merged };
}

export function applyPhaseProgressToContract(
  contract: TaskContract,
  progress?: PhaseProgress,
): TaskContract {
  if (!progress || contract.phases.length === 0) {
    return contract;
  }
  const completed = new Set(progress.completedPhaseIds);
  const phases = contract.phases.map((phase) => {
    if (completed.has(phase.id)) {
      return { ...phase, status: "completed" as const };
    }
    if (progress.currentPhaseId && phase.id === progress.currentPhaseId) {
      return { ...phase, status: "in_progress" as const };
    }
    return phase;
  });
  return { ...contract, phases };
}

export function generateDirectiveForRemaining(
  contract: TaskContract,
  progress?: PhaseProgress,
): string | undefined {
  const remaining = remainingPhases(contract.phases, progress);
  const next = remaining[0];
  if (!next) {
    return undefined;
  }
  const completedIds = new Set(progress?.completedPhaseIds ?? []);
  const lastCompleted = [...contract.phases]
    .reverse()
    .find((phase) => completedIds.has(phase.id) || phase.status === "completed");
  return buildNextPhaseDirective(lastCompleted?.title, next);
}

export function downgradePassIfPhasesRemain(
  review: ReviewResultParsed,
  contract: TaskContract,
  stalled: boolean,
): ReviewResultParsed {
  const phases = review.phases?.length ? review.phases : contract.phases;
  const progress = review.phaseProgress;
  const incomplete = !areAllPhasesComplete(phases, progress);
  if (!incomplete) {
    return review;
  }

  const nextDirective =
    progress?.nextPhaseDirective?.trim() ||
    generateDirectiveForRemaining({ ...contract, phases }, progress) ||
    "Autonomous mode active. Remaining phases are incomplete. Proceed immediately with the next phase. Do NOT ask for confirmation.";

  return makeReviewResult({
    ...review,
    status: ReviewStatus.NeedsWork,
    summary: stalled
      ? `${review.summary} Executor asked for confirmation before remaining phases were complete.`
      : `${review.summary} Remaining phases are incomplete — continuing autonomously.`,
    requiredChanges: review.requiredChanges ?? [],
    issues: review.issues ?? [],
    evidenceRequests: [],
    phaseProgress: {
      currentPhaseId: progress?.currentPhaseId,
      completedPhaseIds: progress?.completedPhaseIds ?? [],
      nextPhaseDirective: nextDirective,
      allPhasesComplete: false,
    },
  });
}

export function buildSupervisedContinuationPrompt(
  messages: ProtocolMessage[],
): string {
  if (messages.length === 0) {
    return "Continue the current task. Apply any outstanding required changes and report what you did.";
  }

  const parts = messages.map((message) => {
    return `[${message.type} from ${message.from}]\n${JSON.stringify(message.content, null, 2)}`;
  });

  return [
    "Address the reviewer feedback below:",
    ...parts,
    "",
    "Make the requested changes and summarize what you did.",
  ].join("\n");
}

export function buildAutonomousTaskPrompt(
  goal: string,
  contract: TaskContract,
): string {
  const phaseLines =
    contract.phases.length > 0
      ? [
          "",
          "Roadmap (complete every phase; do not stop between them):",
          ...contract.phases.map(
            (phase, index) =>
              `- Phase ${index + 1} [${phase.status}] ${phase.title}${
                phase.description ? `: ${phase.description}` : ""
              }`,
          ),
        ]
      : [
          "",
          "If this task has multiple phases, complete them all in this session.",
        ];

  return [
    "=== ASSENTOR AUTONOMOUS SUPERVISOR DIRECTIVE ===",
    "You are operating under an automated supervisor. DO NOT pause or ask the user 'Should I continue?'.",
    "Do not stop after an intermediate milestone. Implement until the full goal is done.",
    "",
    `Task: ${goal}`,
    ...phaseLines,
    "",
    "Make all necessary code changes, run tests if applicable, and summarize what was completed.",
  ].join("\n");
}

export function buildAutonomousContinuationPrompt(
  messages: ProtocolMessage[],
  nextPhaseDirective?: string,
): string {
  if (messages.length === 0 && !nextPhaseDirective) {
    return [
      "=== ASSENTOR AUTONOMOUS SUPERVISOR DIRECTIVE ===",
      "You are operating under an automated supervisor. DO NOT pause or ask the user 'Should I continue?'.",
      "Continue the current task. Apply any outstanding required changes and report what you did.",
    ].join("\n");
  }

  const parts = messages.map((message) => {
    return `[${message.type} from ${message.from}]\n${JSON.stringify(message.content, null, 2)}`;
  });

  return [
    "=== ASSENTOR AUTONOMOUS SUPERVISOR DIRECTIVE ===",
    "You are operating under an automated supervisor. DO NOT pause or ask the user 'Should I continue?'.",
    nextPhaseDirective ? `\n>>> ACTIVE DIRECTIVE <<<\n${nextPhaseDirective}\n` : "",
    "Address the supervisor/reviewer feedback below and proceed immediately with the implementation:",
    ...parts,
    "",
    "Make all necessary code changes, run tests if applicable, and summarize what was completed in this phase.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
