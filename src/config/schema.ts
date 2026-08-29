import { z } from "zod";
import {
  DEFAULT_RUN_MODE,
  parseRunMode,
  RUN_MODES,
} from "../core/run-mode.js";
import {
  EXECUTOR_PROVIDER_IDS,
  normalizeExecutorProvider,
} from "../executors/providers.js";

const ExecutorProviderSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? normalizeExecutorProvider(value) : value,
  z.enum(EXECUTOR_PROVIDER_IDS),
);

const REVIEWER_PROVIDER_IDS = [
  "mock",
  "openai",
  "gemini",
  "claude",
  "antigravity",
  "cursor",
] as const;

function normalizeReviewerProvider(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const key = value.trim().toLowerCase();
  if (key === "gemini-cli" || key === "agy") {
    return "antigravity";
  }
  if (key === "cursor-agent" || key === "agent") {
    return "cursor";
  }
  return key;
}

const ReviewerProviderSchema = z.preprocess(
  normalizeReviewerProvider,
  z.enum(REVIEWER_PROVIDER_IDS),
);

export const AssentorConfigSchema = z.object({
  project: z
    .object({
      path: z.string().min(1).default("."),
    })
    .default({ path: "." }),
  executor: z
    .object({
      provider: ExecutorProviderSchema.default("mock"),
    })
    .default({ provider: "mock" }),
  run: z
    .object({
      /** Supervised is default; Autopilot auto-steers next phases. */
      mode: z.preprocess(parseRunMode, z.enum(RUN_MODES)).default(DEFAULT_RUN_MODE),
    })
    .default({ mode: DEFAULT_RUN_MODE }),
  reviewers: z
    .array(
      z.object({
        /** Logical/provider id used for the primary transport. */
        provider: ReviewerProviderSchema.default("mock"),
        role: z.string().default("general"),
        name: z.string().optional(),
        /** How Assentor reaches the reviewer — identity stays separate. */
        transport: z.enum(["api", "cli"]).default("api"),
        model: z.string().optional(),
        /** Optional vault key id when transport is API. */
        keyId: z.string().optional(),
        /** Optional fallback transport/provider if primary fails. */
        fallback: z
          .object({
            transport: z.enum(["api", "cli"]).optional(),
            provider: ReviewerProviderSchema.optional(),
            model: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([{ provider: "mock", role: "general", transport: "api" }]),
  routing: z
    .object({
      strategy: z
        .enum(["FREE_FIRST", "CHEAPEST", "BALANCED", "BEST", "CUSTOM"])
        .default("BALANCED"),
      reviewStrategy: z
        .enum(["SINGLE", "ADAPTIVE", "PANEL", "FULL"])
        .default("ADAPTIVE"),
    })
    .default({}),
  models: z
    .object({
      /** Preferred reviewer/model id or AUTO */
      default: z.string().default("AUTO"),
      gemini: z.string().default("AUTO"),
      openai: z.string().default("AUTO"),
    })
    .default({}),
  limits: z
    .object({
      maxRounds: z.number().int().positive().default(8),
      maxMessages: z.number().int().positive().default(50),
      maxRuntimeMinutes: z.number().int().positive().default(120),
      maxToolCalls: z.number().int().positive().default(200),
    })
    .default({}),
  binaries: z
    .object({
      cursor: z.string().optional(),
      claude: z.string().optional(),
      agy: z.string().optional(),
      codex: z.string().optional(),
      qwen: z.string().optional(),
      opencode: z.string().optional(),
    })
    .default({}),
  git: z
    .object({
      checkpoints: z.boolean().default(true),
      autoCommit: z.boolean().default(false),
    })
    .default({}),
  security: z
    .object({
      redactSecrets: z.boolean().default(true),
      allowExternalPaths: z.boolean().default(false),
    })
    .default({}),
  artifacts: z
    .object({
      diff: z.boolean().default(true),
      tests: z.boolean().default(true),
      logs: z.boolean().default(true),
      screenshots: z.boolean().default(false),
    })
    .default({}),
  verification: z
    .object({
      enabled: z.boolean().default(true),
      commands: z
        .object({
          typecheck: z.string().default(""),
          test: z.string().default(""),
          lint: z.string().default(""),
          build: z.string().default(""),
        })
        .default({}),
      skipReviewOnFailure: z
        .object({
          typecheck: z.boolean().default(true),
          build: z.boolean().default(true),
          test: z.boolean().default(true),
          lint: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
});

export type AssentorConfig = z.infer<typeof AssentorConfigSchema>;

export {
  EXECUTOR_PROVIDER_IDS,
  EXECUTOR_PROVIDER_LABELS,
  SELECTABLE_EXECUTOR_PROVIDERS,
  formatExecutorProvider,
  isSelectableExecutorProvider,
  normalizeExecutorProvider,
  type ExecutorProviderId,
  type SelectableExecutorProvider,
} from "../executors/providers.js";

export function parseAssentorConfig(input: unknown): AssentorConfig {
  return AssentorConfigSchema.parse(input ?? {});
}
