import { z } from "zod";
import { SEAT_PROVIDERS, type SeatProvider } from "#assentor/protocol/seats.js";

/**
 * Roster contract (task T02B-01a): what the Lead sees when it hires seats.
 * The builder (`buildRoster`, `formatRosterForPrompt`) is T02B-04. Design:
 * docs/plans/modes.md §4.4.
 */

export const STRENGTHS = ["coding", "reasoning", "ui", "tests", "docs", "review"] as const;
export type Strength = (typeof STRENGTHS)[number];

export const COST_TIERS = ["low", "medium", "high"] as const;
export const SPEEDS = ["fast", "medium", "slow"] as const;
export type CostTier = (typeof COST_TIERS)[number];
export type Speed = (typeof SPEEDS)[number];

/** Seed or user-provided profile. `key` is "provider/model" or "provider/*". */
export const CapabilityProfileSchema = z.object({
  key: z.string().regex(/^[a-z-]+\/(\*|[A-Za-z0-9][A-Za-z0-9._:/-]*)$/, 'key must be "provider/model" or "provider/*"'),
  strengths: z.array(z.enum(STRENGTHS)).default([]),
  speed: z.enum(SPEEDS).default("medium"),
  cost: z.enum(COST_TIERS).default("medium"),
});
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

/** Live availability for one provider/model (from CLI detection, auth and the scheduler). */
export interface ProviderAvailability {
  provider: SeatProvider;
  model: string;
  installed: boolean;
  authenticated: boolean;
  /** Concurrency slots free right now. */
  freeSlots: number;
  /** ISO time until which the provider is rate limited. */
  rateLimitedUntil?: string;
}

/** Past performance in this project (scoreboard, T06-01/T02B-19). */
export interface RosterStats {
  samples: number;
  /** 0..1 */
  acceptanceRate?: number;
  /** 0..1 */
  reviewPassRate?: number;
}

/** Scoreboard input for `buildRoster`, keyed "provider/model". */
export type RosterScoreboard = Readonly<Record<string, RosterStats>>;

/** User policy limiting who the Lead may hire. */
export const RosterPolicySchema = z.object({
  allowedProviders: z.array(z.enum(SEAT_PROVIDERS)).optional(),
  /** Highest cost tier allowed. */
  maxCost: z.enum(COST_TIERS).optional(),
});
export type RosterPolicy = z.infer<typeof RosterPolicySchema>;

/** One hireable provider/model, as shown to the Lead. */
export interface RosterEntry {
  provider: SeatProvider;
  model: string;
  /** The catalog label for the model (e.g. "Claude Opus 4.6"), else the model id. */
  label: string;
  strengths: Strength[];
  speed: Speed;
  cost: CostTier;
  freeSlots: number;
  rateLimitedUntil?: string;
  stats?: RosterStats;
}

/** Ordering helper for cost tiers: low < medium < high. */
export function costRank(cost: CostTier): number {
  return COST_TIERS.indexOf(cost);
}
