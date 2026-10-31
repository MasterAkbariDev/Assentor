import type { SeatProvider } from "#assentor/protocol/seats.js";
import type { CatalogEntry } from "../models/cli-catalog.js";
import {
  costRank,
  type CapabilityProfile,
  type CostTier,
  type ProviderAvailability,
  type RosterEntry,
  type RosterPolicy,
  type RosterScoreboard,
  type Speed,
  type Strength,
} from "./roster.js";

/** Catalog rows the roster needs. `CatalogEntry` satisfies this. */
export type RosterCatalogItem = Pick<CatalogEntry, "provider" | "id" | "label">;

export interface BuildRosterInput {
  catalog: readonly RosterCatalogItem[];
  availability: readonly ProviderAvailability[];
  /** Merged profiles (see `mergeCapabilities`). */
  capabilities: readonly CapabilityProfile[];
  scoreboard?: RosterScoreboard;
  policy: RosterPolicy;
}

const FALLBACK_PROFILE: { strengths: Strength[]; speed: Speed; cost: CostTier } = {
  strengths: [],
  speed: "medium",
  cost: "medium",
};

export function rosterKey(provider: SeatProvider, model: string): string {
  return `${provider}/${model}`;
}

/** Exact "provider/model" first, then "provider/*", else a neutral fallback. */
function profileFor(
  capabilities: readonly CapabilityProfile[],
  provider: SeatProvider,
  model: string,
): { strengths: Strength[]; speed: Speed; cost: CostTier } {
  const exactKey = rosterKey(provider, model);
  const anyKey = `${provider}/*`;
  let exact: CapabilityProfile | undefined;
  let any: CapabilityProfile | undefined;
  for (const profile of capabilities) {
    if (profile.key === exactKey) exact = profile;
    else if (profile.key === anyKey) any = profile;
  }
  return exact ?? any ?? FALLBACK_PROFILE;
}

/**
 * The hireable (provider, model) pairs the Lead sees. Only installed and
 * authenticated models pass, filtered by policy, sorted by free slots (desc),
 * cost (asc) and provider/model (asc).
 */
export function buildRoster(input: BuildRosterInput): RosterEntry[] {
  const { catalog, availability, capabilities, scoreboard, policy } = input;

  const status = new Map<string, ProviderAvailability>();
  for (const entry of availability) {
    const key = rosterKey(entry.provider, entry.model);
    if (!status.has(key)) status.set(key, entry);
  }

  const seen = new Set<string>();
  const entries: RosterEntry[] = [];
  for (const item of catalog) {
    const key = rosterKey(item.provider, item.id);
    if (seen.has(key)) continue;
    seen.add(key);

    const live = status.get(key);
    if (!live || !live.installed || !live.authenticated) continue;
    if (policy.allowedProviders && !policy.allowedProviders.includes(item.provider)) continue;

    const profile = profileFor(capabilities, item.provider, item.id);
    if (policy.maxCost && costRank(profile.cost) > costRank(policy.maxCost)) continue;

    const entry: RosterEntry = {
      provider: item.provider,
      model: item.id,
      label: item.label || item.id,
      strengths: [...profile.strengths],
      speed: profile.speed,
      cost: profile.cost,
      freeSlots: live.freeSlots,
    };
    if (live.rateLimitedUntil !== undefined) entry.rateLimitedUntil = live.rateLimitedUntil;
    const stats = scoreboard?.[key];
    if (stats) entry.stats = stats;
    entries.push(entry);
  }

  return entries.sort(
    (a, b) =>
      b.freeSlots - a.freeSlots ||
      costRank(a.cost) - costRank(b.cost) ||
      compareKeys(rosterKey(a.provider, a.model), rosterKey(b.provider, b.model)),
  );
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatRate(rate: number | undefined): string {
  return rate === undefined ? "-" : `${Math.round(rate * 100)}%`;
}

/** Compact markdown table for the Lead's prompt, cut to `maxRows` with a final "… N more" row. */
export function formatRosterForPrompt(
  entries: readonly RosterEntry[],
  options: { maxRows?: number } = {},
): string {
  const limit = Math.max(0, options.maxRows ?? 25);
  const lines = [
    "| provider/model | strengths | speed | cost | free slots | acceptance rate |",
    "|---|---|---|---|---|---|",
  ];
  for (const entry of entries.slice(0, limit)) {
    const strengths = entry.strengths.length > 0 ? entry.strengths.join(", ") : "-";
    lines.push(
      `| ${rosterKey(entry.provider, entry.model)} | ${strengths} | ${entry.speed} | ${entry.cost} | ${entry.freeSlots} | ${formatRate(entry.stats?.acceptanceRate)} |`,
    );
  }
  const hidden = entries.length - Math.min(entries.length, limit);
  if (hidden > 0) {
    lines.push(`| … ${hidden} more | | | | | |`);
  }
  return lines.join("\n");
}
