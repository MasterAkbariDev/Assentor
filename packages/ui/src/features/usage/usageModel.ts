import type { UsageReport, UsageTotals } from "#assentor/protocol/rpc.js";

/** Pure helpers for the usage panel (TE-01 report, T04-18). */

export type BudgetState = "below" | "warn50" | "warn80" | "limit";

export interface BudgetBar {
  key: string;
  kind: string;
  label: string;
  used: number;
  limit: number;
  pct: number;
  state: BudgetState;
}

/** Share of input tokens served from the prompt cache, or undefined when there were no input tokens. */
export function cachedShare(totals: UsageTotals): number | undefined {
  return totals.tokensIn > 0 ? totals.cachedTokens / totals.tokensIn : undefined;
}

export function budgetState(pct: number): BudgetState {
  if (pct >= 1) return "limit";
  if (pct >= 0.8) return "warn80";
  if (pct >= 0.5) return "warn50";
  return "below";
}

/**
 * One bar per budget that has a warning (the report carries limits only through
 * warnings). `used` is the ledger's current total for that budget, so a bar moves
 * as tokens arrive. Runtime budgets are not in the report; they show the figure
 * from the last warning.
 * shortcut: the ledger also counts mode-run executor tokens the scheduler does not budget, so this can run ahead of the scheduler's own figure; upgrade if that matters.
 */
export function budgetBars(report: UsageReport, seatName: (seatId: string) => string): BudgetBar[] {
  // Warnings come in log order, so the last one per budget and seat is the latest.
  const latest = new Map<string, UsageReport["warnings"][number]>();
  for (const warning of report.warnings) latest.set(`${warning.budget}|${warning.seatId ?? ""}`, warning);
  return [...latest].map(([key, warning]) => {
    const kind = warning.budget.split(".")[1] ?? "";
    const { seatId } = warning;
    const totals = seatId !== undefined ? report.bySeat[seatId] : report.total;
    const current = totals && kind === "tokens" ? totals.tokensIn + totals.tokensOut : totals && kind === "cost" ? totals.costUsd : undefined;
    const used = current ?? warning.used;
    const pct = warning.limit > 0 ? used / warning.limit : 0;
    const who = seatId !== undefined ? `seat ${seatName(seatId)}` : "session";
    return { key, kind, label: `${who} ${kind}`, used, limit: warning.limit, pct, state: budgetState(pct) };
  });
}

/** A budget value as text: tokens as a count, cost in dollars, runtime (ms) in minutes. */
export function formatBudget(kind: string, value: number, usd: (n: number) => string, count: (n: number) => string): string {
  if (kind === "cost") return usd(value);
  if (kind === "runtime") return `${(value / 60_000).toFixed(1)} min`;
  return count(value);
}

/** Totals for a report's rows, most tokens first (ties keep their order). */
export function sortedRows(rows: Record<string, UsageTotals>): Array<[string, UsageTotals]> {
  const size = (t: UsageTotals) => t.tokensIn + t.tokensOut;
  return Object.entries(rows).sort(([, a], [, b]) => size(b) - size(a));
}

export interface RangeCompare {
  low: number;
  high: number;
  actual: number;
  /** 0 inside the estimated range; otherwise how far actual is above `high` (+) or below `low` (-). */
  diff: number;
}

export interface EstimateCompare {
  tokens: RangeCompare;
  /** Undefined when the estimate had no price or the ledger has no cost (show "unknown"). */
  usd?: RangeCompare;
}

function compare(low: number, high: number, actual: number): RangeCompare {
  return { low, high, actual, diff: actual > high ? actual - high : actual < low ? actual - low : 0 };
}

/** Estimate (TE-09) against the ledger's actuals; undefined when the run logged no estimate. */
export function compareEstimate(report: UsageReport): EstimateCompare | undefined {
  const { estimate, total } = report;
  if (!estimate) return undefined;
  const tokens = compare(estimate.tokens.low, estimate.tokens.high, total.tokensIn + total.tokensOut);
  // A zero ledger cost means no seat reported or had a price, so it is not an actual of $0.
  const usd = estimate.usd && total.costUsd > 0 ? compare(estimate.usd.low, estimate.usd.high, total.costUsd) : undefined;
  return { tokens, ...(usd ? { usd } : {}) };
}

/** Skills loaded, most tokens first. */
export function sortedSkills(skills: UsageReport["skills"]): Array<[string, NonNullable<UsageReport["skills"]>[string]]> {
  return Object.entries(skills ?? {}).sort(([, a], [, b]) => b.tokens - a.tokens);
}
