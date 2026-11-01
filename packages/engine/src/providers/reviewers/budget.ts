import type { Reviewer } from "./types.js";

/**
 * The reviewer, with `context.budgetTokens.reviewer` (TE-03) attached to every turn it is asked to take. The host
 * wraps the reviewers it builds from the config it loaded, so no budget lives outside that config.
 */
export function withReviewBudget(reviewer: Reviewer, contextBudgetTokens: number): Reviewer {
  return {
    name: reviewer.name,
    review: (input) => reviewer.review({ ...input, contextBudgetTokens }),
    continue: (input) => reviewer.continue({ ...input, contextBudgetTokens }),
    ...(reviewer.setModel ? { setModel: (model: string) => reviewer.setModel!(model) } : {}),
  };
}
