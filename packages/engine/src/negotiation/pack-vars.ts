import { roleBudget, type ContextBudgets } from "../context/budget.js";
import { summarizeHistory, type DigestCache, type Summarize } from "../context/summary.js";
import { packPromptVariables } from "../context/vars.js";
import { estimateTokens } from "../usage/tokens.js";

/**
 * The variables a negotiation step's prompt is rendered with (TE-03): identical proposals are sent once (always);
 * with `budgets.negotiation` the other seats' proposals also shrink before the seat's own proposal and the
 * critiques it must answer. The transcript keeps the full variables.
 */
export function packStepVars<V extends Readonly<Record<string, unknown>>>(vars: V, budgets?: ContextBudgets): V {
  const budgetTokens = roleBudget(budgets, "negotiation");
  return packPromptVariables(vars as Record<string, unknown>, budgetTokens ? { budgetTokens } : {}) as V;
}

export interface StepSummaryOptions {
  /** `context.summaries`; anything but `auto` returns the variables unchanged. */
  summaries?: "off" | "auto";
  summarize?: Summarize;
  /** One per session, so a digest is made once and shared by every step that shows the same proposal. */
  cache: DigestCache;
  scope: string;
  model?: string;
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof (value as { text?: unknown } | null)?.text === "string" ? (value as { text: string }).text : undefined;

/**
 * Rolling summaries for negotiations (TE-04). Only from round 3, with `context.summaries: auto`, a negotiation
 * budget, and step context over that budget: each entry of `proposals` larger than its share of the budget is
 * replaced by a digest (one call per proposal text, cached). In revise and critique that list holds only the other
 * seats' proposals (the seat's own `proposal` stays verbatim); in negotiate-agree it holds every proposal, the
 * voter's own included, so all of them may be digested. Critiques stay verbatim, and steps without `round` — the
 * moderator and judge rulings — are never touched. `packStepVars`
 * stays the outer bound. Everything else returns `vars` itself, so prompts are byte-identical when off.
 */
export async function summarizeStepVars<V extends Readonly<Record<string, unknown>>>(vars: V, budgets: ContextBudgets | undefined, options: StepSummaryOptions): Promise<V> {
  const budgetTokens = roleBudget(budgets, "negotiation");
  const { round, proposals } = vars as { round?: unknown; proposals?: unknown };
  if (options.summaries !== "auto" || !budgetTokens || typeof round !== "number" || round < 3 || !Array.isArray(proposals)) return vars;
  // Sizes as sent: after the lossless merge of identical blocks.
  const tokens = (picked: Record<string, unknown>) =>
    estimateTokens(
      Object.values(packStepVars(picked))
        .flatMap((value) => (Array.isArray(value) ? value.map(textOf) : [textOf(value)]))
        .filter((t): t is string => t !== undefined)
        .join("\n\n"),
      options.model,
    );
  if (tokens(vars) <= budgetTokens) return vars;
  // What stays verbatim (goal, `proposal` when the step has one, critiques) is paid first; `proposals` share the rest.
  const { proposals: _others, ...fixed } = vars as Record<string, unknown>;
  const share = Math.floor((budgetTokens - tokens(fixed)) / proposals.length);
  if (share <= 0) return vars;
  const digested = await Promise.all(
    proposals.map(async (item: unknown) => {
      const text = textOf(item);
      if (text === undefined || typeof item === "string") return item;
      const { digest } = await summarizeHistory([text], {
        keepLast: 0,
        budgetTokens: share,
        digestTokens: share,
        cache: options.cache,
        scope: `${options.scope}:proposal`,
        ...(options.summarize ? { summarize: options.summarize } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      return digest === undefined ? item : { ...(item as object), text: digest };
    }),
  );
  return { ...vars, proposals: digested };
}
