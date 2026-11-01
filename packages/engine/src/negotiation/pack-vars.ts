import { roleBudget, type ContextBudgets } from "../context/budget.js";
import { packPromptVariables } from "../context/vars.js";

/**
 * The variables a negotiation step's prompt is rendered with (TE-03): identical proposals are sent once (always);
 * with `budgets.negotiation` the other seats' proposals also shrink before the seat's own proposal and the
 * critiques it must answer. The transcript keeps the full variables.
 */
export function packStepVars<V extends Readonly<Record<string, unknown>>>(vars: V, budgets?: ContextBudgets): V {
  const budgetTokens = roleBudget(budgets, "negotiation");
  return packPromptVariables(vars as Record<string, unknown>, budgetTokens ? { budgetTokens } : {}) as V;
}
