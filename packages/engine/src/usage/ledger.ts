import type { EngineEvent } from "#assentor/protocol/events.js";
import type { UsageReport, UsageTotals } from "#assentor/protocol/rpc.js";
import type { PricingTable } from "../estimate/cost.js";

/**
 * Usage ledger (TE-01): folds `seat.tokens` into totals per seat, stage,
 * model and session. Pure; feed it events in log order.
 *
 * - `cachedTokens` (when a provider reports it) is a part of `tokensIn`.
 * - Cost is the event's `costUsd`; without one, the seat's `provider/model`
 *   price from `pricing` (`estimate/cost.ts`) when known (cached input at
 *   `cachedInPerMTok`, else at the full input price), else 0.
 * - `calls` counts model turns: a report's `turns` (a CLI run), else 1.
 * - A seat's model comes from `seat.spawned`, then `seat.model.changed`.
 * - Budget warnings are the scheduler's `session.warning` events of kind `budget`.
 * - The pre-run estimate is the run's `session.estimate` event (TE-09); last one wins.
 */
export class UsageLedger {
  private readonly report: UsageReport;
  private readonly seatModel = new Map<string, string>();
  private readonly costed = new Map<string, { costUsd: number; tokens: number }>();

  constructor(sessionId = "", private readonly pricing: PricingTable = {}) {
    this.report = { sessionId, total: zero(), bySeat: {}, byStage: {}, byModel: {}, retries: 0, warnings: [] };
  }

  add(event: EngineEvent): void {
    this.report.sessionId ||= event.sessionId;
    switch (event.type) {
      case "seat.spawned":
        this.seatModel.set(event.seatId ?? "", `${event.data.provider}/${event.data.model}`);
        return;
      case "seat.model.changed": {
        const current = this.seatModel.get(event.seatId ?? "");
        if (!event.data.pending && current) {
          this.seatModel.set(event.seatId ?? "", `${current.split("/")[0]}/${event.data.to}`);
        }
        return;
      }
      case "seat.retry":
        this.report.retries += 1;
        return;
      case "session.estimate": {
        const { tokens, usd } = event.data;
        this.report.estimate = { tokens: { ...tokens }, ...(usd ? { usd: { ...usd } } : {}) };
        return;
      }
      case "session.warning": {
        const data = event.data as Record<string, unknown>;
        if (data.kind === "budget" && typeof data.used === "number" && typeof data.limit === "number") {
          this.report.warnings.push({
            budget: String(data.budget ?? ""),
            threshold: Number(data.threshold ?? 0),
            used: data.used,
            limit: data.limit,
            ...(event.seatId ? { seatId: event.seatId } : {}),
          });
        }
        return;
      }
      case "seat.tokens": {
        const seatId = event.seatId ?? "-";
        const model = this.seatModel.get(seatId) ?? "unknown";
        const { tokensIn, tokensOut } = event.data;
        const cached = Math.min(tokensIn, event.data.cachedTokens ?? 0);
        const price = this.pricing[model];
        const costUsd =
          event.data.costUsd ??
          (price
            ? ((tokensIn - cached) * price.inPerMTok +
                cached * (price.cachedInPerMTok ?? price.inPerMTok) +
                tokensOut * price.outPerMTok) /
              1_000_000
            : 0);
        const delta: UsageTotals = {
          tokensIn,
          tokensOut,
          cachedTokens: cached,
          costUsd,
          calls: event.data.turns ?? 1,
        };
        add(this.report.total, delta);
        add((this.report.bySeat[seatId] ??= zero()), delta);
        add((this.report.byStage[event.stageId ?? "-"] ??= zero()), delta);
        add((this.report.byModel[model] ??= zero()), delta);
        if (event.data.costUsd !== undefined && model !== "unknown") {
          const sum = this.costed.get(model) ?? { costUsd: 0, tokens: 0 };
          sum.costUsd += event.data.costUsd;
          sum.tokens += tokensIn + tokensOut;
          this.costed.set(model, sum);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Reported dollars and tokens per `provider/model`, from the `seat.tokens` events that carry a `costUsd`. */
  costedByModel(): Record<string, { costUsd: number; tokens: number }> {
    return Object.fromEntries(this.costed);
  }

  /** A copy of the totals so far. */
  snapshot(): UsageReport {
    return structuredClone(this.report);
  }
}

export function usageFromEvents(events: readonly EngineEvent[], sessionId = "", pricing?: PricingTable): UsageReport {
  const ledger = new UsageLedger(sessionId, pricing);
  for (const event of events) ledger.add(event);
  return ledger.snapshot();
}

function zero(): UsageTotals {
  return { tokensIn: 0, tokensOut: 0, cachedTokens: 0, costUsd: 0, calls: 0 };
}

function add(into: UsageTotals, delta: UsageTotals): void {
  into.tokensIn += delta.tokensIn;
  into.tokensOut += delta.tokensOut;
  into.cachedTokens += delta.cachedTokens;
  into.costUsd += delta.costUsd;
  into.calls += delta.calls;
}
