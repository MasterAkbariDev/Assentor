import { z } from "zod";
import { BUILTIN_REVIEW_ROLES, SEAT_ROLE_PATTERN, SeatRoleSchema } from "#assentor/protocol/seats.js";

/**
 * Skill file format (task TE-07): `<layer>/<name>/SKILL.md`, Markdown with YAML
 * front-matter (split by the prompt library's `splitPromptFile`).
 *
 * ```markdown
 * ---
 * name: targeted-reading
 * description: Use when exploring code — search first, read line ranges.
 * roles: [engineer, debugger]
 * autoload: { keywords: [grep], globs: ["src/**"] }
 * version: 1
 * ---
 * Body: loaded only when a trigger matches or a seat asks for it.
 * ```
 */

export const SKILL_PROFILES = ["economy", "balanced", "max"] as const;
export const MAX_SKILL_DESCRIPTION_CHARS = 200;

const KebabSchema = z.string().regex(SEAT_ROLE_PATTERN, "must be kebab-case (e.g. targeted-reading)");

/** Validated front-matter. Unknown keys are errors so typos don't pass silently. */
export const SkillFrontMatterSchema = z
  .object({
    name: KebabSchema.max(48),
    /** One line in every eligible seat's index: say *when* to load it. */
    description: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SKILL_DESCRIPTION_CHARS)
      .regex(/^[^\r\n]*$/, "description must be one line"),
    /** Seat roles that may load it; omitted = any role. */
    roles: z.array(SeatRoleSchema).min(1).optional(),
    /** Mode ids it is offered in; omitted = every mode. */
    modes: z.array(KebabSchema).min(1).optional(),
    profiles: z.array(z.enum(SKILL_PROFILES)).min(1).optional(),
    /** Loads it without a request when a keyword is in the task or a changed file matches a glob. */
    autoload: z
      .object({
        keywords: z.array(z.string().trim().min(2).max(100)).max(20).default([]),
        globs: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
      })
      .strict()
      .optional(),
    version: z.number().int().positive(),
  })
  .strict();

export type SkillFrontMatter = z.infer<typeof SkillFrontMatterSchema>;

/**
 * Roles a project-layer skill may not reach. The project is the code under
 * review: its files must not be able to instruct the seats that judge it.
 * Built-in review/meta roles plus the legacy reviewer specialties.
 */
export const PROJECT_SKILL_FORBIDDEN_ROLES: ReadonlySet<string> = new Set([
  ...BUILTIN_REVIEW_ROLES,
  "general",
  "architecture",
  "code",
  "testing",
  "security",
  "performance",
  "ui",
  "adjudicator",
]);

export function validateSkillFrontMatter(
  data: Record<string, unknown>,
): { ok: true; value: SkillFrontMatter } | { ok: false; message: string } {
  const result = SkillFrontMatterSchema.safeParse(data);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const message = result.error.issues
    .map((issue) => `${issue.path.join(".") || "front-matter"}: ${issue.message}`)
    .join("; ");
  return { ok: false, message: `invalid front-matter — ${message}` };
}

/** Rough token count (≈4 chars per token); no tokenizer dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
