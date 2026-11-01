import { z } from "zod";
import {
  AutonomySchema,
  blankToUndefined,
  DEFAULT_RUN_MODE,
  parseRunMode,
  RUN_MODES,
  runModeForAutonomy,
  type Autonomy,
  type RunMode,
} from "../core/run-mode.js";
import {
  EXECUTOR_PROVIDER_IDS,
  normalizeExecutorProvider,
} from "../executors/providers.js";
import { CascadeTierSchema, NegotiateModeSchema, ReviewModeSchema } from "./teams.js";
import { SEAT_PROVIDERS, TeamSchema } from "#assentor/protocol/seats.js";
import { MODE_ALIASES, MODE_IDS } from "../modes/registry.js";
import { DangerAreaRuleSchema } from "../modes/danger.js";
import { DEFAULT_OUTPUT_STYLE, OutputStyleSchema } from "../output/style.js";

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
      /** Model id for the executor CLI. `AUTO` or unset means the CLI default. */
      model: z.string().optional(),
    })
    .default({ provider: "mock" }),
  /** How verbose seats and the CLI are (TE-02). `normal` is unchanged; `concise` is opt-in. */
  output: z
    .object({
      style: OutputStyleSchema.default(DEFAULT_OUTPUT_STYLE),
    })
    .default({}),
  run: z
    .object({
      /** Supervised is default; Autopilot auto-steers next phases. */
      mode: z.preprocess(parseRunMode, z.enum(RUN_MODES)).default(DEFAULT_RUN_MODE),
      /**
       * manual | supervised | autopilot. When set it wins over `mode`, and `mode` is
       * rewritten to match so the engine (and older Assentor versions, which drop this
       * field) keep reading `mode`.
       */
      autonomy: z.preprocess(blankToUndefined, AutonomySchema.optional()),
    })
    .transform(({ autonomy, ...run }): { mode: RunMode; autonomy?: Autonomy } =>
      autonomy ? { ...run, mode: runModeForAutonomy(autonomy), autonomy } : run,
    )
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
  teams: z.record(z.string().min(1), TeamSchema).default({}),
  /**
   * `modes.<modeId>`: per-mode settings. `negotiate` and `review` (T00-02) are typed
   * here; any other mode's section is kept as written and checked by that mode's
   * `validate` before it runs. Unknown mode ids are rejected.
   */
  modes: z
    .object({
      negotiate: NegotiateModeSchema.optional(),
      review: ReviewModeSchema.optional(),
      /**
       * Cascade mode (T02B-06). `tiers` run cheapest first; `dangerAreas` add to the built-in
       * danger rules, never remove them. Every field is optional (no defaults are written on save).
       */
      cascade: z
        .object({
          tiers: z.array(CascadeTierSchema).min(1).max(6).optional(),
          dangerAreas: z.array(DangerAreaRuleSchema).max(50).optional(),
        })
        // Keep untyped cascade keys so a config save never drops them.
        .passthrough()
        .optional(),
    })
    // `.optional()` so `config.modes.lead.x` needs a guard in TypeScript; YAML null is still refused.
    .catchall(z.record(z.unknown()).optional())
    .superRefine((modes, ctx) => {
      for (const key of Object.keys(modes)) {
        if (!(MODE_IDS as readonly string[]).includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: Object.hasOwn(MODE_ALIASES, key)
              ? `unknown mode "${key}"; did you mean modes.${MODE_ALIASES[key]}?`
              : `unknown mode "${key}" (modes: ${MODE_IDS.join(", ")})`,
          });
        }
      }
    })
    .default({}),
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
      /** Seat scheduler (T02-02): parallel jobs per provider; unset = CLI 2, API 4. */
      concurrency: z.record(z.enum(SEAT_PROVIDERS), z.number().int().min(1).max(16)).default({}),
      /** Seat scheduler: parallel jobs across all providers. */
      globalConcurrency: z.number().int().min(1).max(32).default(6),
      /** Seat scheduler: whole-session budget across all seats (unset = no limit). */
      session: z
        .object({
          maxTokens: z.number().int().positive().optional(),
          maxCostUsd: z.number().positive().optional(),
          maxRuntimeMinutes: z.number().int().positive().optional(),
        })
        .default({}),
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
