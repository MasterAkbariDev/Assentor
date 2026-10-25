import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SEAT_ROLE_PATTERN } from "../core/seats.js";

/**
 * Prompt file format (task T03-01): Markdown with YAML front-matter.
 *
 * ```markdown
 * ---
 * id: security-reviewer
 * role: reviewer
 * title: Security Reviewer
 * variables: [goal, diff]
 * output: review-result
 * version: 1
 * ---
 * You are a security reviewer… {{goal}}
 * ```
 */

export const PROMPT_ROLES = ["builder", "reviewer", "meta"] as const;
export const PROMPT_OUTPUTS = [
  "text",
  "review-result",
  "negotiation-proposal",
  "ranking",
  "synthesis",
  "subtasks",
] as const;

const PromptIdSchema = z
  .string()
  .regex(SEAT_ROLE_PATTERN, "id must be kebab-case (e.g. security-reviewer)");

/** Validated front-matter. Unknown keys are errors so typos don't pass silently. */
export const PromptFrontMatterSchema = z
  .object({
    id: PromptIdSchema,
    role: z.enum(PROMPT_ROLES),
    title: z.string().trim().min(1),
    icon: z.string().default(""),
    description: z.string().default(""),
    recommendedModels: z.array(z.string().min(1)).default([]),
    permissions: z.enum(["read-only", "edit"]).default("read-only"),
    variables: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
    output: z.enum(PROMPT_OUTPUTS).default("text"),
    version: z.number().int().positive(),
    extends: PromptIdSchema.optional(),
  })
  .strict();

export type PromptFrontMatter = z.infer<typeof PromptFrontMatterSchema>;

export type PromptLayer = "builtin" | "user" | "project";

export interface PromptDefinition extends PromptFrontMatter {
  /** Template text after the front-matter (trailing whitespace trimmed). */
  body: string;
  layer: PromptLayer;
  /** Absolute path of the file that defined it (the child, for `extends`). */
  file: string;
  /** Layer of the prompt with the same id that this one replaced, if any. */
  overrides?: PromptLayer;
}

export interface RawPromptFile {
  /** Front-matter as written (not yet validated; `extends` children may omit fields). */
  frontMatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a prompt file into front-matter and body. Accepts CRLF and a UTF-8
 * BOM. Throws when the file does not start with a `---` front-matter block or
 * the YAML is not a mapping.
 */
export function splitPromptFile(text: string): RawPromptFile {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new Error("missing YAML front-matter (file must start with a --- block)");
  }
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(`invalid YAML front-matter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("front-matter must be a YAML mapping");
  }
  return {
    frontMatter: data as Record<string, unknown>,
    body: (match[2] ?? "").trimEnd(),
  };
}

/** Validate front-matter, returning readable issues instead of a ZodError. */
export function validateFrontMatter(
  data: Record<string, unknown>,
): { ok: true; value: PromptFrontMatter } | { ok: false; message: string } {
  const result = PromptFrontMatterSchema.safeParse(data);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const message = result.error.issues
    .map((issue) => `${issue.path.join(".") || "front-matter"}: ${issue.message}`)
    .join("; ");
  return { ok: false, message: `invalid front-matter — ${message}` };
}
