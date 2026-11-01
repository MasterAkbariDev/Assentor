import { describe, expect, it } from "vitest";
import type { UsageReport, UsageTotals } from "#assentor/protocol/rpc.js";
import { budgetBars, budgetState, cachedShare, formatBudget, sortedRows } from "./usageModel.js";

const totals = (tokensIn: number, tokensOut: number, costUsd = 0, cachedTokens = 0): UsageTotals => ({ tokensIn, tokensOut, cachedTokens, costUsd, calls: 1 });

describe("budgetState", () => {
  it("changes state at 50%, 80% and the limit", () => {
    expect(budgetState(0.49)).toBe("below");
    expect(budgetState(0.5)).toBe("warn50");
    expect(budgetState(0.79)).toBe("warn50");
    expect(budgetState(0.8)).toBe("warn80");
    expect(budgetState(0.99)).toBe("warn80");
    expect(budgetState(1)).toBe("limit");
  });
});

describe("budgetBars", () => {
  const report: UsageReport = {
    sessionId: "s",
    total: totals(7000, 1500, 0.9),
    bySeat: { executor: totals(6000, 1000, 0.8), "reviewer-1": totals(1000, 500, 0.1) },
    byStage: {},
    byModel: {},
    retries: 0,
    warnings: [
      { budget: "session.tokens", threshold: 0.5, used: 5200, limit: 10000 },
      { budget: "session.tokens", threshold: 0.8, used: 8100, limit: 10000 },
      { budget: "seat.cost", threshold: 0.5, used: 0.5, limit: 1, seatId: "executor" },
    ],
  };
  const name = (id: string) => (id === "executor" ? "Executor" : id);

  it("has no bars without warnings, since the report carries limits only through them", () => {
    expect(budgetBars({ ...report, warnings: [] }, name)).toEqual([]);
  });

  it("keeps the latest warning per budget and uses the current total for used", () => {
    const bars = budgetBars(report, name);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ key: "session.tokens|", label: "session tokens", kind: "tokens", used: 8500, limit: 10000, state: "warn80" });
    expect(bars[1]).toMatchObject({ label: "seat Executor cost", kind: "cost", used: 0.8, limit: 1, state: "warn80" });
  });

  it("reports the limit state once used reaches the limit", () => {
    const [bar] = budgetBars({ ...report, total: totals(10000, 0) }, name);
    expect(bar).toMatchObject({ used: 10000, state: "limit" });
  });
});

describe("formatting and small helpers", () => {
  it("formats budget values by kind", () => {
    const usd = (n: number) => `$${n}`;
    const count = (n: number) => String(n);
    expect(formatBudget("tokens", 1200, usd, count)).toBe("1200");
    expect(formatBudget("cost", 0.5, usd, count)).toBe("$0.5");
    expect(formatBudget("runtime", 90_000, usd, count)).toBe("1.5 min");
  });

  it("gives the cached share, or nothing without input tokens", () => {
    expect(cachedShare(totals(0, 10))).toBeUndefined();
    expect(cachedShare(totals(12000, 0, 0, 3000))).toBe(0.25);
  });

  it("sorts rows by tokens, most first", () => {
    const rows = sortedRows({ a: totals(1, 1), b: totals(10, 5), c: totals(3, 0) });
    expect(rows.map(([id]) => id)).toEqual(["b", "c", "a"]);
  });
});
