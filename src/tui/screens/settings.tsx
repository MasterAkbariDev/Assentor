import type { AssentorConfig } from "../../config/load.js";
import { cycle } from "./shared.js";

export const EXECUTOR_OPTIONS = ["mock", "cursor"] as const;
export const REVIEWER_OPTIONS = ["mock", "gemini", "openai"] as const;
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
  SINGLE: "One reviewer",
  ADAPTIVE: "Auto — pick by task",
  PANEL: "Small panel (3–4)",
  FULL: "All specialists",
};

const ROUTING_LABEL: Record<(typeof ROUTING_OPTIONS)[number], string> = {
  FREE_FIRST: "Prefer free models",
  CHEAPEST: "Cheapest",
  BALANCED: "Balanced (recommended)",
  BEST: "Best quality",
  CUSTOM: "Custom",
};

export function buildAiRows(config: AssentorConfig): string[] {
  return [
    `Executor             ${config.executor.provider}`,
    `Reviewer             ${config.reviewers[0]?.provider ?? "mock"}`,
    `Reviewer runs via    ${config.reviewers[0]?.transport ?? "api"}`,
    `Default model        ${config.models.default}`,
    `Gemini model         ${config.models.gemini}`,
    `OpenAI model         ${config.models.openai}`,
    "Save these defaults",
  ];
}

export function buildReviewRows(config: AssentorConfig): string[] {
  const strategy = config.routing.reviewStrategy;
  return [
    `Reviewers            ${REVIEW_STRATEGY_LABEL[strategy] ?? strategy}`,
    `Max rounds           ${config.limits.maxRounds}`,
    "Save these defaults",
  ];
}

export function buildAdvancedRows(config: AssentorConfig): string[] {
  const routing = config.routing.strategy;
  return [
    `Model routing        ${ROUTING_LABEL[routing] ?? routing}`,
    `Max messages         ${config.limits.maxMessages}`,
    "Save these defaults",
  ];
}

/** Combined list used by the overlay fallback. */
export function buildDefaultRows(config: AssentorConfig): string[] {
  return [...buildAiRows(config).slice(0, -1), ...buildReviewRows(config).slice(0, -1), "Save defaults"];
}

export function cycleAiField(
  config: AssentorConfig,
  idx: number,
  dir: 1 | -1,
  modelChoices: string[],
): AssentorConfig {
  const next = structuredClone(config);
  switch (idx) {
    case 0:
      next.executor.provider = cycle(
        EXECUTOR_OPTIONS,
        EXECUTOR_OPTIONS.includes(
          next.executor.provider as (typeof EXECUTOR_OPTIONS)[number],
        )
          ? (next.executor.provider as (typeof EXECUTOR_OPTIONS)[number])
          : "cursor",
        dir,
      );
      break;
    case 1: {
      const provider = cycle(
        REVIEWER_OPTIONS,
        (REVIEWER_OPTIONS.includes(
          (next.reviewers[0]?.provider ?? "mock") as (typeof REVIEWER_OPTIONS)[number],
        )
          ? next.reviewers[0]?.provider
          : "mock") as (typeof REVIEWER_OPTIONS)[number],
        dir,
      );
      next.reviewers = [
        {
          provider,
          role: next.reviewers[0]?.role ?? "general",
          transport: next.reviewers[0]?.transport ?? "api",
        },
      ];
      break;
    }
    case 2: {
      const transport = cycle(
        TRANSPORT_OPTIONS,
        (next.reviewers[0]?.transport ?? "api") as (typeof TRANSPORT_OPTIONS)[number],
        dir,
      );
      next.reviewers = [
        {
          ...(next.reviewers[0] ?? { provider: "mock", role: "general" }),
          transport,
        },
      ];
      break;
    }
    case 3:
      next.models.default = cycle(modelChoices, next.models.default, dir);
      break;
    case 4:
      next.models.gemini = cycle(modelChoices, next.models.gemini, dir);
      break;
    case 5:
      next.models.openai = cycle(modelChoices, next.models.openai, dir);
      break;
    default:
      break;
  }
  return next;
}

export function cycleReviewField(
  config: AssentorConfig,
  idx: number,
  dir: 1 | -1,
): AssentorConfig {
  const next = structuredClone(config);
  if (idx === 0) {
    next.routing.reviewStrategy = cycle(
      REVIEW_STRATEGY_OPTIONS,
      next.routing.reviewStrategy,
      dir,
    );
  } else if (idx === 1) {
    next.limits.maxRounds = cycle(
      ROUND_OPTIONS,
      (ROUND_OPTIONS.includes(next.limits.maxRounds as (typeof ROUND_OPTIONS)[number])
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
