import { z } from "zod";
import { packContext } from "./pack.js";

/** Roles whose prompts the context packer budgets (`context.budgetTokens.<role>`). */
export const CONTEXT_ROLES = ["reviewer", "negotiation", "lead", "coder"] as const;
export type ContextRole = (typeof CONTEXT_ROLES)[number];

/**
 * Optional `context.budgetTokens` per role: the most tokens of task context (diffs, test
 * output, excerpts, proposals, history) a seat in that role is sent. 0 turns packing off for
 * the role. Nothing is written on save: unset roles use DEFAULT_BUDGET_TOKENS.
 */
const budget = z.number().int().min(0).optional();
export const ContextConfigSchema = z.object({ budgetTokens: z.object({ reviewer: budget, negotiation: budget, lead: budget, coder: budget }).optional() });

/**
 * Defaults chosen from `pnpm bench:tokens --variants context:packed`: above what the fixture
 * tasks need (success unchanged, nothing cut) and below what a runaway pack costs.
 */
export const DEFAULT_BUDGET_TOKENS: Readonly<Partial<Record<ContextRole, number>>> = {
  reviewer: 12_000,
  negotiation: 8_000,
  lead: 6_000,
  coder: 2_000,
};

// shortcut: one process-wide setting, written by loadAssentorConfig (the last project loaded wins);
// pass budgets explicitly if a daemon ever serves several projects with different values.
let configured: Partial<Record<ContextRole, number>> = {};

export function setContextBudgets(budgets: Partial<Record<ContextRole, number>> | undefined): void {
  configured = { ...budgets };
}

/** Tokens of task context for `role`, or undefined when packing is off for it. */
export function contextBudget(role: ContextRole): number | undefined {
  const value = configured[role] ?? DEFAULT_BUDGET_TOKENS[role];
  return value && value > 0 ? value : undefined;
}

/** The role a built-in prompt belongs to for budgeting. */
export function roleOfPrompt(promptId: string): ContextRole {
  if (/^(negotiate-|judge$|moderator$|divide-plan$)/.test(promptId)) return "negotiation";
  if (/^lead/.test(promptId)) return "lead";
  if (/(reviewer|devils-advocate)$/.test(promptId)) return "reviewer";
  return "coder";
}

/**
 * Failing test or gate output sent to a coder, within `maxChars` (the caller's existing hard cap) and the role's
 * token budget: its first error and its tail, repeated blocks once, a marker for the cut. Undefined when packing
 * is off for the role: the caller keeps its own cut.
 */
export function packFailureOutput(output: string, maxChars: number, role: ContextRole = "coder"): string | undefined {
  const budgetTokens = contextBudget(role);
  if (budgetTokens === undefined) return undefined;
  return packContext([{ id: "output", kind: "failing-test", text: output }], { budgetTokens: Math.min(budgetTokens, Math.floor(maxChars / 4)) }).text;
}
