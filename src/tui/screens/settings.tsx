import type { AssentorConfig } from "../../config/load.js";
import {
  SELECTABLE_EXECUTOR_PROVIDERS,
  formatExecutorProvider,
  type SelectableExecutorProvider,
} from "../../executors/providers.js";
import { RUN_MODES, formatRunMode, type RunMode } from "../../core/run-mode.js";
import { formatReviewerBackend } from "../../review/backends.js";
import { cycle } from "./shared.js";

export const EXECUTOR_OPTIONS = SELECTABLE_EXECUTOR_PROVIDERS;
export const RUN_MODE_OPTIONS = RUN_MODES;
export const REVIEWER_OPTIONS = ["mock", "gemini", "openai", "claude", "cursor"] as const;
export const TRANSPORT_OPTIONS = ["api", "cli"] as const;
export const ROUTING_OPTIONS = [
  "FREE_FIRST",
  "CHEAPEST",
  "BALANCED",
  "BEST",
  "CUSTOM",
] as const;
export const REVIEW_STRATEGY_OPTIONS = [
  "SINGLE",
  "ADAPTIVE",
  "PANEL",
  "FULL",
] as const;
export const ROUND_OPTIONS = [4, 6, 8, 10, 12, 16] as const;

const REVIEW_STRATEGY_LABEL: Record<(typeof REVIEW_STRATEGY_OPTIONS)[number], string> = {
  SINGLE: "One reviewer (first in the list)",
  ADAPTIVE: "All you added",
  PANEL: "All you added",
  FULL: "All you added",
};

const ROUTING_LABEL: Record<(typeof ROUTING_OPTIONS)[number], string> = {
  FREE_FIRST: "Prefer free models",
  CHEAPEST: "Cheapest",
  BALANCED: "Balanced (recommended)",
  BEST: "Best quality",
  CUSTOM: "Custom",
};

export function buildAiRows(
  config: AssentorConfig,
  options: { installedIds?: ReadonlySet<string> } = {},
): string[] {
  const installed = options.installedIds;
  const executorMark =
    config.executor.provider === "mock"
      ? ""
      : installed
        ? installed.has(config.executor.provider)
          ? " ✓"
          : " ✗"
        : "";
  return [
    `Mode                 ${formatRunMode(config.run.mode)}`,
    `Executor             ${formatExecutorProvider(config.executor.provider)}${executorMark}`,
    `Default model        ${config.models.default}`,
    `Gemini model         ${config.models.gemini}`,
    `OpenAI model         ${config.models.openai}`,
    "Save these defaults",
  ];
}

export interface StructuredConfigField {
  label: string;
  value: string;
  description?: string;
  badge?: string;
  badgeTone?: "ok" | "warn" | "error" | "info" | "neutral";
  isAction?: boolean;
}

export function buildAiStructuredFields(
  config: AssentorConfig,
  options: { installedIds?: ReadonlySet<string> } = {},
): StructuredConfigField[] {
  const installed = options.installedIds;
  const isInstalled =
    config.executor.provider === "mock"
      ? true
      : installed
        ? installed.has(config.executor.provider)
        : true;

  return [
    {
      label: "Execution Mode",
      value: formatRunMode(config.run.mode),
      badge: config.run.mode === "autopilot" ? "Autopilot" : "Supervised",
      badgeTone: config.run.mode === "autopilot" ? "warn" : "info",
      description:
        config.run.mode === "autopilot"
          ? "Executor runs continuously through phases without pausing for approval"
          : "Executor halts at verification gates between phases for human sign-off",
    },
    {
      label: "Coding Executor",
      value: formatExecutorProvider(config.executor.provider),
      badge:
        config.executor.provider === "mock"
          ? undefined
          : isInstalled
            ? "Installed ✓"
            : "Missing ✗",
      badgeTone: isInstalled ? "ok" : "error",
      description:
        "Local coding agent CLI responsible for modifying source code in the repository",
    },
    {
      label: "Default Model",
      value: config.models.default,
      description: "Baseline model selected when agents specify AUTO routing",
    },
    {
      label: "Gemini Model",
      value: config.models.gemini,
      badge: "Google API",
      badgeTone: "info",
      description: "Model used for Google Gemini cloud reviewer agents",
    },
    {
      label: "OpenAI Model",
      value: config.models.openai,
      badge: "OpenAI API",
      badgeTone: "info",
      description: "Model used for OpenAI GPT cloud reviewer agents",
    },
    {
      label: "Save these defaults",
      value: "Press ↵ or 's'",
      isAction: true,
      description: "Persist the configured AI defaults to ~/.assentor/config.yaml",
    },
  ];
}

export type ReviewMenuRow =
  | { kind: "add"; label: string }
  | { kind: "member"; index: number; label: string }
  | { kind: "strategy"; label: string }
  | { kind: "rounds"; label: string }
  | { kind: "save"; label: string };

export function buildReviewMenu(config: AssentorConfig): ReviewMenuRow[] {
  const strategy = config.routing.reviewStrategy;
  return [
    { kind: "add", label: "+ Add reviewer" },
    ...config.reviewers.map((entry, index) => ({
      kind: "member" as const,
      index,
      label: formatReviewerBackend(entry),
    })),
    {
      kind: "strategy",
      label: `How many              ${REVIEW_STRATEGY_LABEL[strategy] ?? strategy}`,
    },
    {
      kind: "rounds",
      label: `Max rounds           ${config.limits.maxRounds}`,
    },
    { kind: "save", label: "Save these reviewers" },
  ];
}

export function buildReviewRows(config: AssentorConfig): string[] {
  return buildReviewMenu(config).map((row) => row.label);
}

export function buildAdvancedRows(config: AssentorConfig): string[] {
  const routing = config.routing.strategy;
  return [
    `Model routing        ${ROUTING_LABEL[routing] ?? routing}`,
    `Max messages         ${config.limits.maxMessages}`,
    "Save these defaults",
  ];
}

export function buildAdvancedStructuredFields(
  config: AssentorConfig,
): StructuredConfigField[] {
  const routing = config.routing.strategy;
  return [
    {
      label: "Model Routing Strategy",
      value: ROUTING_LABEL[routing] ?? routing,
      badge: routing,
      badgeTone: routing === "BALANCED" ? "ok" : "info",
      description: "Balancing formula for speed, cost, and LLM reasoning depth",
    },
    {
      label: "Max Messages Limit",
      value: `${config.limits.maxMessages} messages`,
      description:
        "Context threshold before truncating or warning on runaway sessions",
    },
    {
      label: "Save advanced defaults",
      value: "Press ↵ or 's'",
      isAction: true,
      description:
        "Persist routing thresholds and message constraints to ~/.assentor/config.yaml",
    },
  ];
}

/** Combined list used by the overlay fallback. */
export function buildDefaultRows(config: AssentorConfig): string[] {
  return [
    ...buildAiRows(config).slice(0, -1),
    ...buildReviewRows(config).slice(0, -1),
    "Save defaults",
  ];
}

export function cycleAiField(
  config: AssentorConfig,
  idx: number,
  dir: 1 | -1,
  modelChoices: string[],
  availableExecutors?: readonly string[],
): AssentorConfig {
  const next = structuredClone(config);
  switch (idx) {
    case 0:
      next.run.mode = cycle(RUN_MODE_OPTIONS, next.run.mode, dir);
      break;
    case 1: {
      const options =
        availableExecutors && availableExecutors.length > 0
          ? (availableExecutors as readonly SelectableExecutorProvider[])
          : EXECUTOR_OPTIONS;
      const current = options.includes(
        next.executor.provider as SelectableExecutorProvider,
      )
        ? (next.executor.provider as SelectableExecutorProvider)
        : (options[0] ?? "cursor");
      next.executor.provider = cycle(options, current, dir);
      break;
    }
    case 2:
      next.models.default = cycle(modelChoices, next.models.default, dir);
      break;
    case 3:
      next.models.gemini = cycle(modelChoices, next.models.gemini, dir);
      break;
    case 4:
      next.models.openai = cycle(modelChoices, next.models.openai, dir);
      break;
    default:
      break;
  }
  return next;
}

export function cycleRunMode(config: AssentorConfig, dir: 1 | -1 = 1): AssentorConfig {
  const next = structuredClone(config);
  next.run.mode = cycle(RUN_MODE_OPTIONS, next.run.mode as RunMode, dir);
  return next;
}

export function cycleReviewField(
  config: AssentorConfig,
  idx: number,
  dir: 1 | -1,
): AssentorConfig {
  const row = buildReviewMenu(config)[idx];
  if (!row) {
    return config;
  }
  const next = structuredClone(config);
  if (row.kind === "strategy") {
    next.routing.reviewStrategy = cycle(
      REVIEW_STRATEGY_OPTIONS,
      next.routing.reviewStrategy,
      dir,
    );
  } else if (row.kind === "rounds") {
    next.limits.maxRounds = cycle(
      ROUND_OPTIONS,
      (ROUND_OPTIONS.includes(
        next.limits.maxRounds as (typeof ROUND_OPTIONS)[number],
      )
        ? next.limits.maxRounds
        : 8) as (typeof ROUND_OPTIONS)[number],
      dir,
    );
  }
  return next;
}

export function cycleAdvancedField(
  config: AssentorConfig,
  idx: number,
  dir: 1 | -1,
): AssentorConfig {
  const next = structuredClone(config);
  if (idx === 0) {
    next.routing.strategy = cycle(
      ROUTING_OPTIONS,
      next.routing.strategy,
      dir,
    );
  }
  return next;
}

export function removeReviewerAt(
  config: AssentorConfig,
  index: number,
): AssentorConfig {
  const next = structuredClone(config);
  if (index < 0 || index >= next.reviewers.length) {
    return next;
  }
  next.reviewers.splice(index, 1);
  return next;
}
