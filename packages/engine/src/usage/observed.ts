import type { PricingTable } from "../estimate/cost.js";
import { listSessions } from "../rpc/sessions.js";
import { UsageLedger } from "./ledger.js";
import { readSessionLogInto } from "./read.js";

/** Newest sessions whose logs are read for prices. */
export const PRICE_SESSIONS = 50;

/**
 * Prices observed in this project's recent runs (TE-09): the dollars a CLI
 * reported (`costUsd`) over the tokens of the same turns, blended into one rate
 * per `provider/model`. A model with no reported cost, or zero, has no price:
 * nothing is invented. Read-only; no model calls.
 */
export async function observedPricing(projectPath: string, maxSessions = PRICE_SESSIONS): Promise<PricingTable> {
  const totals = new Map<string, { costUsd: number; tokens: number }>();
  const sessions = (await listSessions(projectPath)).filter((s) => s.hasLiveLog).slice(0, maxSessions);
  for (const session of sessions) {
    const ledger = new UsageLedger(session.id);
    await readSessionLogInto(ledger, projectPath, session.id);
    for (const [model, observed] of Object.entries(ledger.costedByModel())) {
      const sum = totals.get(model) ?? { costUsd: 0, tokens: 0 };
      sum.costUsd += observed.costUsd;
      sum.tokens += observed.tokens;
      totals.set(model, sum);
    }
  }
  const table: PricingTable = {};
  for (const [model, sum] of totals) {
    if (sum.tokens > 0 && sum.costUsd > 0) {
      const perMTok = (sum.costUsd / sum.tokens) * 1_000_000;
      table[model] = { inPerMTok: perMTok, outPerMTok: perMTok };
    }
  }
  return table;
}
