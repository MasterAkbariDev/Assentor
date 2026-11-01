import { useEffect, useRef, useState } from "react";
import type { UsageReport } from "#assentor/protocol/rpc.js";
import { useEngine } from "../../store/context.js";
import { useRpc } from "../../transport/context.js";
import { formatUsd, formatCount } from "../usage/UsagePage.js";
import { budgetBars, formatBudget } from "../usage/usageModel.js";

/** Share of a limit at which the bar turns to the warning colour. */
export const WARN_AT = 0.8;

/**
 * Header budget: used / limit for each session-wide budget that has warned (the report knows limits only through
 * warnings), warning colour from 80%, plus the cost when the ledger knows one. Reloads `usage.get` as tokens arrive
 * (one call at a time). Shows nothing until there is something to say; a failed call also shows nothing.
 */
export function BudgetBar({ sessionId }: { sessionId: string }) {
  const rpc = useRpc();
  const connection = useEngine((s) => s.connection);
  const tokenEvents = useEngine((s) => s.session?.tokenEvents ?? 0);
  const [report, setReport] = useState<UsageReport>();
  const busy = useRef(false);
  const dirty = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const load = (): void => {
      if (busy.current) {
        dirty.current = true;
        return;
      }
      busy.current = true;
      dirty.current = false;
      rpc
        .call("usage.get", { sessionId })
        .then(
          (next) => mounted.current && setReport(next),
          () => undefined,
        )
        .finally(() => {
          busy.current = false;
          if (dirty.current && mounted.current) load();
        });
    };
    load();
  }, [rpc, sessionId, connection, tokenEvents]);

  if (!report) return null;
  // Session-wide budgets only; a seat's budget is `session.tokens|<seatId>`.
  const bars = budgetBars(report, (id) => id).filter((bar) => bar.key.endsWith("|"));
  const cost = report.total.costUsd;
  const showCost = cost > 0 && !bars.some((bar) => bar.kind === "cost");
  if (bars.length === 0 && !showCost) return null;
  return (
    <div className="budget-bar" role="group" aria-label="Budget">
      {bars.map((bar) => {
        const warn = bar.pct >= WARN_AT;
        return (
          <div key={bar.key} className="budget-item" data-state={warn ? "warn" : "ok"}>
            <span className="budget-text">
              {bar.kind}: {formatBudget(bar.kind, bar.used, formatUsd, formatCount)} / {formatBudget(bar.kind, bar.limit, formatUsd, formatCount)} ({Math.round(bar.pct * 100)}%)
              {bar.pct >= 1 ? " · limit reached" : warn ? " · nearing the limit" : ""}
            </span>
            <progress max={bar.limit} value={Math.min(bar.used, bar.limit)} aria-label={`${bar.kind} budget used`} />
          </div>
        );
      })}
      {showCost ? <span className="budget-cost">Cost: {formatUsd(cost)}</span> : null}
    </div>
  );
}
