import { z } from "zod";

export const AssentorConfigSchema = z.object({
  project: z
    .object({
      path: z.string().min(1).default("."),
    })
    .default({ path: "." }),
  executor: z
    .object({
      provider: z.enum(["mock", "cursor", "project-mutating"]).default("mock"),
    })
    .default({ provider: "mock" }),
  reviewers: z
    .array(
      z.object({
        /** Logical/provider id used for the primary transport. */
        provider: z
          .enum(["mock", "openai", "gemini", "claude", "gemini-cli"])
          .default("mock"),
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
            provider: z
              .enum(["mock", "openai", "gemini", "claude", "gemini-cli"])
              .optional(),
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
});

export type AssentorConfig = z.infer<typeof AssentorConfigSchema>;

export function parseAssentorConfig(input: unknown): AssentorConfig {
  return AssentorConfigSchema.parse(input ?? {});
}
