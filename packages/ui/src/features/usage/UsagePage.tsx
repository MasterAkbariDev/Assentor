import { useEffect, useRef, useState } from "react";
import type { UsageReport, UsageTotals } from "#assentor/protocol/rpc.js";
import { useEngine } from "../../store/context.js";
import { useRpc } from "../../transport/context.js";
import {
  budgetBars,
  cachedShare,
  compareEstimate,
  formatBudget,
  sortedRows,
  sortedSkills,
  type BudgetBar,
  type BudgetState,
  type RangeCompare,
} from "./usageModel.js";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const count = new Intl.NumberFormat("en-US");
/** Costs too small to show to the cent read "<$0.01" rather than rounding to $0.00. */
const formatUsd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : usd.format(n));
const formatCount = (n: number) => count.format(n);

const STATE_TEXT: Record<BudgetState, string> = {
  below: "under 50%",
  warn50: "past the 50% warning",
  warn80: "past the 80% warning",
  limit: "limit reached",
};

/** Sidebar "Usage" section: the selected run's token use, read-only. */
export function UsagePage() {
  const selectedId = useEngine((s) => s.selectedId);
  const title = useEngine(
    (s) => s.sessions.find((x) => x.id === s.selectedId)?.title,
  );
  return (
    <section className="usage-page" aria-label="Usage">
      <h1 className="session-heading">
        Usage
        {title ? <span className="session-state"> · {title}</span> : null}
      </h1>
      {selectedId ? (
        <UsagePanel key={selectedId} sessionId={selectedId} />
      ) : (
        <p className="empty">
          Select a run in the sidebar to see its token use.
        </p>
      )}
    </section>
  );
}

/** Totals, per seat / stage / model tables and budget bars for one run. Reloads when its `seat.tokens` events arrive. */
export function UsagePanel({ sessionId }: { sessionId: string }) {
  const rpc = useRpc();
  const connection = useEngine((s) => s.connection);
  const tokenEvents = useEngine((s) => s.session?.tokenEvents ?? 0);
  const seats = useEngine((s) => s.session?.seats);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  // At most one `usage.get` in flight. Events that arrive meanwhile set `dirty`, and one more call follows the settled one.
  const busy = useRef(false);
  const dirty = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
        (next) => {
          // Every result is applied, even when newer events arrived while it was in flight.
          if (!mounted.current) return;
          setReport(next);
          setError(undefined);
        },
        (e: unknown) => {
          if (mounted.current)
            setError(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => {
        busy.current = false;
        if (dirty.current) load();
      });
  };

  useEffect(() => {
    load();
  }, [rpc, sessionId, connection, tokenEvents]);

  if (!report) {
    return error ? (
      <p className="notice error">Could not load usage: {error}</p>
    ) : (
      <p className="empty">Loading usage…</p>
    );
  }
  const seatName = (id: string) => seats?.[id]?.displayName ?? id;
  return (
    <div className="usage-panel">
      {error ? (
        <p className="notice error">Could not refresh usage: {error}</p>
      ) : null}
      {report.truncated ? (
        <p className="notice warn">
          The log is longer than the reader's limit, so these totals cover only
          its start.
        </p>
      ) : null}
      {report.skippedLines ? (
        <p className="notice warn">
          {formatCount(report.skippedLines)} log lines could not be read and
          were skipped.
        </p>
      ) : null}
      {report.total.calls === 0 ? (
        <p className="empty">No token counts reported for this run yet.</p>
      ) : (
        <>
          <Totals report={report} />
          <UsageTable
            caption="By seat"
            label="Seat"
            rows={sortedRows(report.bySeat).map(([id, totals]) => ({
              id,
              name: id === "-" ? "(no seat)" : seatName(id),
              totals,
            }))}
          />
          <UsageTable
            caption="By stage"
            label="Stage"
            rows={sortedRows(report.byStage).map(([id, totals]) => ({
              id,
              name: id === "-" ? "(outside a stage)" : id,
              totals,
            }))}
          />
          <UsageTable
            caption="By model"
            label="Model"
            rows={sortedRows(report.byModel).map(([id, totals]) => ({
              id,
              name: id,
              totals,
            }))}
          />
          <Budgets bars={budgetBars(report, seatName)} />
        </>
      )}
      <EstimateVsActual report={report} />
      <Skills skills={report.skills} seatName={seatName} />
    </div>
  );
}

function Totals({ report }: { report: UsageReport }) {
  const { total } = report;
  const share = cachedShare(total);
  return (
    <dl className="usage-totals">
      <div>
        <dt>Tokens in</dt>
        <dd>{formatCount(total.tokensIn)}</dd>
      </div>
      <div>
        <dt>Tokens out</dt>
        <dd>{formatCount(total.tokensOut)}</dd>
      </div>
      <div>
        <dt>Cached share</dt>
        <dd>{share === undefined ? "—" : `${Math.round(share * 100)}%`}</dd>
      </div>
      <div>
        <dt>Cost</dt>
        <dd>{formatUsd(total.costUsd)}</dd>
      </div>
      <div>
        <dt>Model calls</dt>
        <dd>{formatCount(total.calls)}</dd>
      </div>
      <div>
        <dt>Retries</dt>
        <dd>{formatCount(report.retries)}</dd>
      </div>
    </dl>
  );
}

function UsageTable({
  caption,
  label,
  rows,
}: {
  caption: string;
  label: string;
  rows: Array<{ id: string; name: string; totals: UsageTotals }>;
}) {
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">Calls</th>
            <th scope="col">Tokens in</th>
            <th scope="col">Tokens out</th>
            <th scope="col">Cached</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, name, totals }) => {
            const share = cachedShare(totals);
            return (
              <tr key={id}>
                <th scope="row">{name}</th>
                <td>{formatCount(totals.calls)}</td>
                <td>{formatCount(totals.tokensIn)}</td>
                <td>{formatCount(totals.tokensOut)}</td>
                <td>
                  {share === undefined ? "—" : `${Math.round(share * 100)}%`}
                </td>
                <td>{formatUsd(totals.costUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Budgets are known only through their warnings (the report has no limits), so a bar appears once one has warned. */
function Budgets({ bars }: { bars: BudgetBar[] }) {
  return (
    <section className="usage-budgets" aria-labelledby="usage-budgets-title">
      <h2 id="usage-budgets-title">Budgets</h2>
      {bars.length === 0 ? (
        <p className="empty">No budget has reached 50%.</p>
      ) : null}
      {bars.map((bar) => (
        <div key={bar.key} className="usage-budget" data-state={bar.state}>
          <p className="usage-budget-text">
            {bar.label}:{" "}
            {formatBudget(bar.kind, bar.used, formatUsd, formatCount)} of{" "}
            {formatBudget(bar.kind, bar.limit, formatUsd, formatCount)} (
            {Math.round(bar.pct * 100)}%), {STATE_TEXT[bar.state]}
          </p>
          <progress
            max={bar.limit}
            value={Math.min(bar.used, bar.limit)}
            aria-hidden="true"
          />
        </div>
      ))}
    </section>
  );
}

const rangeText = (
  r: { low: number; high: number },
  f: (n: number) => string,
) => (r.low === r.high ? f(r.low) : `${f(r.low)}–${f(r.high)}`);
const diffText = (r: RangeCompare, f: (n: number) => string) =>
  r.diff === 0
    ? "within the estimate"
    : r.diff > 0
      ? `${f(r.diff)} over the high end`
      : `${f(-r.diff)} under the low end`;

/** The pre-run estimate (TE-09) beside what the ledger counted. */
function EstimateVsActual({ report }: { report: UsageReport }) {
  const cmp = compareEstimate(report);
  return (
    <section className="usage-estimate" aria-labelledby="usage-estimate-title">
      <h2 id="usage-estimate-title">Estimate vs actual</h2>
      {!cmp ? (
        <p className="empty">This run logged no pre-run estimate.</p>
      ) : (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption>Estimate vs actual</caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Estimated</th>
                <th scope="col">Actual</th>
                <th scope="col">Difference</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Tokens</th>
                <td>{rangeText(cmp.tokens, formatCount)}</td>
                <td>{formatCount(cmp.tokens.actual)}</td>
                <td>{diffText(cmp.tokens, formatCount)}</td>
              </tr>
              <tr>
                <th scope="row">Cost</th>
                <td>
                  {report.estimate?.usd
                    ? rangeText(report.estimate.usd, formatUsd)
                    : "unknown"}
                </td>
                <td>
                  {cmp.usd
                    ? report.unpricedCalls
                      ? `≥ ${formatUsd(cmp.usd.actual)} (some calls unpriced)`
                      : formatUsd(cmp.usd.actual)
                    : "unknown"}
                </td>
                <td>
                  {cmp.usd
                    ? report.unpricedCalls
                      ? "unknown (actual is partial)"
                      : diffText(cmp.usd, formatUsd)
                    : "unknown"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Skill bodies sent to seats (TE-07), each delivery counted. */
function Skills({
  skills,
  seatName,
}: {
  skills: UsageReport["skills"];
  seatName: (id: string) => string;
}) {
  const rows = sortedSkills(skills);
  return (
    <section className="usage-skills" aria-labelledby="usage-skills-title">
      <h2 id="usage-skills-title">Skills loaded</h2>
      {rows.length === 0 ? (
        <p className="empty">No skills were loaded in this run.</p>
      ) : (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption>Skills loaded</caption>
            <thead>
              <tr>
                <th scope="col">Skill</th>
                <th scope="col">Seats</th>
                <th scope="col">Loads</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, skill]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>
                    {skill.seats
                      .map((id) => (id === "-" ? "(no seat)" : seatName(id)))
                      .join(", ")}
                  </td>
                  <td>{formatCount(skill.loads)}</td>
                  <td>{formatCount(skill.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
