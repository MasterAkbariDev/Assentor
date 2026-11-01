import { contextBudget } from "../context/budget.js";
import { packPromptVariables } from "../context/vars.js";
import type { NegotiationStep } from "./strategy.js";

/**
 * The variables a negotiation step's prompt is rendered with, packed under `context.budgetTokens.negotiation`
 * (TE-03): identical proposals are sent once, and when the debate grows the other seats' proposals shrink
 * before the seat's own proposal and the critiques it must answer. The transcript keeps the full variables.
 */
export function packStepVars<V extends Readonly<Record<string, unknown>>>(step: NegotiationStep, vars: V): V {
  const budgetTokens = contextBudget("negotiation");
  if (budgetTokens === undefined) return vars;
  // In a revision the other proposals are context; everywhere else the proposals are what the seat works on.
  return packPromptVariables(vars as Record<string, unknown>, { budgetTokens, ...(step === "negotiate-revise" ? { kinds: { proposals: "summary" } } : {}) }) as V;
}
