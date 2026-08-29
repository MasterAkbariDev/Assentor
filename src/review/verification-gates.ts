import { redactSecrets } from "../security/redact.js";
import { runShellCommand } from "../process/run-shell.js";
import { ReviewStatus } from "../core/types.js";
import type { PhaseItem } from "../core/task-contract.js";
import {
  makeReviewResult,
  type PhaseProgress,
  type ReviewResultParsed,
} from "../protocol/review-result.js";
import type { ProjectReviewEvidencePack } from "./evidence-pack.js";
import type { RunStatusMarker } from "./evidence-pack.js";
import {
  commandForSlot,
  type VerificationCommands,
  type VerificationSlot,
} from "../config/detect-commands.js";
import type { AssentorConfig } from "../config/schema.js";

const OUTPUT_LIMIT = 8_000;

export interface GateRun {
  slot: VerificationSlot;
  command: string;
  status: "PASSED" | "FAILED" | "NOT_RUN";
  output?: string;
  exitCode?: number;
}

export interface VerificationGateResult {
  runs: GateRun[];
  hardFailures: GateRun[];
  passed: boolean;
}

export type RunVerificationCommand = (
  command: string,
  cwd: string,
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const SLOTS: VerificationSlot[] = ["typecheck", "build", "test", "lint"];

export async function runVerificationGates(input: {
  projectPath: string;
  commands: VerificationCommands;
  skipReviewOnFailure: AssentorConfig["verification"]["skipReviewOnFailure"];
  runCommand?: RunVerificationCommand;
}): Promise<VerificationGateResult> {
  const runner = input.runCommand ?? runShellCommand;
  const runs: GateRun[] = [];

  for (const slot of SLOTS) {
    const command = commandForSlot(input.commands, slot);
    if (!command) {
      runs.push({ slot, command: "", status: "NOT_RUN" });
      continue;
    }
    try {
      const result = await runner(command, input.projectPath);
      const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const capped = rawOutput.slice(0, OUTPUT_LIMIT * 2);
      const redacted = redactSecrets(capped);
      runs.push({
        slot,
        command,
        status: result.code === 0 ? "PASSED" : "FAILED",
        output: redacted.text.slice(0, OUTPUT_LIMIT),
        exitCode: result.code,
      });
    } catch (error) {
      runs.push({
        slot,
        command,
        status: "FAILED",
        output: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      });
    }
  }

  const hardFailures = runs.filter((run) => {
    if (run.status !== "FAILED") {
      return false;
    }
    return input.skipReviewOnFailure[run.slot] === true;
  });

  return {
    runs,
    hardFailures,
    passed: hardFailures.length === 0,
  };
}

export function applyGateRunsToPack(
  pack: ProjectReviewEvidencePack,
  runs: GateRun[],
): void {
  const bySlot = new Map(runs.map((run) => [run.slot, run]));
  const toCommand = (slot: VerificationSlot) => {
    const run = bySlot.get(slot);
    const status = (run?.status ?? "NOT_RUN") as RunStatusMarker;
    return {
      status,
      command: run?.command || undefined,
      output: run?.output,
      exitCode: run?.exitCode,
    };
  };
  pack.tests = {
    ...pack.tests,
    test: toCommand("test"),
    build: toCommand("build"),
    lint: toCommand("lint"),
    typecheck: toCommand("typecheck"),
  };
}

export function syntheticNeedsWorkFromGates(input: {
  failures: GateRun[];
  phases?: PhaseItem[];
  phaseProgress?: PhaseProgress;
}): ReviewResultParsed {
  const failureLines = input.failures.map((failure) => {
    const output = failure.output?.trim() || "(no output)";
    return `Command \`${failure.command}\` (${failure.slot}) failed (exit ${failure.exitCode ?? 1}):\n${output}`;
  });
  const remaining = remainingFrom(input.phases ?? [], input.phaseProgress);
  const next = remaining[0];
  const nextPhaseDirective = next
    ? [
        "Deterministic verification failed. Fix the failing commands using the stdout above.",
        `Then proceed immediately to ${next.title}. Do NOT stop or ask for confirmation.`,
      ].join(" ")
    : "Fix the failing verification commands using the exact stdout above. Do not ask whether to continue — apply the fixes immediately.";

  const statusFor = (slot: VerificationSlot): string => {
    const hit = input.failures.find((f) => f.slot === slot);
    return hit ? "FAILED" : "NOT_RUN";
  };

  return makeReviewResult({
    status: ReviewStatus.NeedsWork,
    confidence: 1,
    summary: `Deterministic verification failed (${input.failures.map((f) => f.slot).join(", ")}). Skipping LLM review.`,
    requiredChanges: failureLines,
    phaseProgress: {
      currentPhaseId: input.phaseProgress?.currentPhaseId,
      completedPhaseIds: input.phaseProgress?.completedPhaseIds ?? [],
      nextPhaseDirective,
      allPhasesComplete: false,
    },
    verification: {
      tests: statusFor("test"),
      build: statusFor("build"),
      lint: statusFor("lint"),
      typecheck: statusFor("typecheck"),
    },
  });
}

function remainingFrom(
  phases: PhaseItem[],
  progress?: PhaseProgress,
): PhaseItem[] {
  const completed = new Set(progress?.completedPhaseIds ?? []);
  return phases.filter(
    (phase) => !completed.has(phase.id) && phase.status !== "completed",
  );
}
