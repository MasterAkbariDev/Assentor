import { z } from "zod";
import { packContext } from "./pack.js";

/** Roles whose prompts the context packer can budget (`context.budgetTokens.<role>`). */
export const CONTEXT_ROLES = ["reviewer", "negotiation", "lead", "coder"] as const;
export type ContextRole = (typeof CONTEXT_ROLES)[number];
export type ContextBudgets = Partial<Record<ContextRole, number>>;

const budget = z.number().int().min(0).optional();
/**
 * Optional `context.budgetTokens` per role: the most tokens of task context (diffs, test output, excerpts,
 * proposals, history) a seat in that role is sent. Unset or 0 = no budget cuts for the role (the lossless
 * merging of identical blocks and the old hard caps always apply). Nothing is written on save.
 *
 * Budget cuts ship OFF: they need the owner's live A/B (`bench:tokens --live`) before any default is set.
 * The budgets are passed to each call site from the loaded config; there is no process-wide state.
 */
export const ContextConfigSchema = z.object({
  budgetTokens: z.object({ reviewer: budget, negotiation: budget, lead: budget, coder: budget }).optional(),
  /**
   * Rolling summaries (TE-04): `auto` folds what is over a role's budget into a digest made by a model call
   * instead of cutting it. Unset = `off`. Ships OFF: on the mock bench a digest saves less than truncation at the
   * same budget (its call costs tokens) and its quality gain needs the owner's live A/B (docs/benchmarks/tokens.md).
   */
  summaries: z.enum(["off", "auto"]).optional(),
});

/** The token budget for `role`, or undefined when cuts are off for it. */
export const roleBudget = (budgets: ContextBudgets | undefined, role: ContextRole): number | undefined => {
  const value = budgets?.[role];
  return value && value > 0 ? value : undefined;
};

/**
 * Failing test or gate output sent to a coder, at most `maxChars` (the caller's hard cap). Always: identical repeated
 * blocks once, then the caller's own cut (`keep` the end or the start). With a coder budget: its first error and its
 * tail within the cap and the budget instead.
 */
export function fitFailureOutput(output: string, maxChars: number, coderBudget: number | undefined, keep: "start" | "end" = "end"): string {
  if (coderBudget && coderBudget > 0) {
    return packContext([{ id: "output", kind: "failing-test", text: output }], { budgetTokens: Math.min(coderBudget, Math.floor(maxChars / 4)) }).text;
  }
  // Merging looks at the part the cut would keep, with room for the repeats that make it shrink.
  const window = maxChars * 8;
  const merged = packContext([{ id: "output", kind: "failing-test", text: keep === "end" ? output.slice(-window) : output.slice(0, window) }]).text;
  return keep === "end" ? merged.slice(-maxChars) : merged.slice(0, maxChars);
}
