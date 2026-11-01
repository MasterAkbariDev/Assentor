import { z } from "zod";
import { classifyRisk } from "../modes/danger.js";
import { costRank, type RosterEntry, type Strength } from "../modes/roster.js";
import type { ProjectReviewEvidencePack } from "../review/evidence-pack.js";
import type { AssentorConfig } from "./schema.js";

/**
 * Run profiles (TE-06): one switch for cost versus depth.
 *
 * HARD RULE: a profile may only switch ON a saving that the TE-10 benchmark has measured, or one with no
 * quality risk. A token saver once doubled usage, so `economy` leaves `output.style: concise` and
 * `context.budgetTokens` cuts alone: both are off until the owner's live A/B passes the gate. Their mock
 * numbers are in PENDING_LIVE_AB below and in docs/benchmarks/tokens.md.
 *
 * Profiles only set defaults. A key the user set wins: any non-default value, any key present in the config
 * files or given as a flag (the loader records those in `run.explicit`, so an explicit `ADAPTIVE` or
 * `maxRounds: 3` survives). `balanced` is today's behaviour: it changes nothing.
 */
export const RUN_PROFILES = ["economy", "balanced", "max"] as const;
export type RunProfile = (typeof RUN_PROFILES)[number];
export const DEFAULT_RUN_PROFILE: RunProfile = "balanced";
export const RunProfileSchema = z.enum(RUN_PROFILES);

/** `--profile` / `run.profile` text to a profile; throws a message naming the choices. */
export function parseRunProfile(value: string): RunProfile {
  const parsed = RunProfileSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) throw new Error(`Unknown profile "${value}". Use one of: ${RUN_PROFILES.join(", ")}.`);
  return parsed.data;
}

/** Built-in default of `modes.negotiate.maxRounds` (config/teams.ts). */
const DEFAULT_NEGOTIATE_ROUNDS = 3;
const DEFAULT_REVIEW_STRATEGY = "ADAPTIVE";

/** What each profile does, for `assentor modes` and `--help`. Keep in step with `applyRunProfile`. */
export const PROFILE_CHANGES: Record<RunProfile, { summary: string; changes: readonly string[] }> = {
  economy: {
    summary: "measured or no-risk savings only",
    changes: [
      "review: one reviewer (the first configured) unless the task text or the changed files and diff touch a danger area: then the full panel, decided at each review",
      "negotiation: modes.negotiate.maxRounds 2 (stops early on consensus in every profile)",
      "routing: Lead hires the cheapest capable model for planning, tests and docs seats",
      "cascade: starts at the cheapest tier (already so in every profile); danger still starts at the top tier",
      "skills.enabled: lean (an empty preset today, so it costs nothing)",
      "race: at most 2 candidates (modes.race.seats is capped)",
    ],
  },
  balanced: { summary: "today's behaviour (default)", changes: [] },
  max: {
    summary: "depth over cost",
    changes: [
      "review: full panel (routing.reviewStrategy FULL)",
      "output.style: verbose",
      "negotiation: modes.negotiate.maxRounds 5",
      "limits.maxRounds: 12",
    ],
  },
};

/** Savings `economy` does NOT turn on, with their mock numbers (docs/benchmarks/tokens.md); they need the live A/B. */
export const PENDING_LIVE_AB: readonly string[] = [
  "output.style: concise (mock: +7.8% net tokens, fails the gate; shorter replies need real models)",
  "context.budgetTokens cuts (mock: 0% on the fixtures, -8.5% at 2500 and -21.9% at 1000 on large fixtures; success unproven live)",
];

const ECONOMY_ROLE_STRENGTH: Readonly<Record<string, Strength>> = {
  planner: "reasoning",
  "requirements-analyst": "reasoning",
  "test-writer": "tests",
  "docs-writer": "docs",
};

/** The profile a run uses: the config's `run.profile`, else balanced. */
export function profileOf(config: AssentorConfig): RunProfile {
  return config.run.profile ?? DEFAULT_RUN_PROFILE;
}

/** Dotted keys a profile can fill. A key is "set by the user" when it holds a non-default value or is listed as explicit. */
export const PROFILE_KEYS = ["output.style", "skills.enabled", "modes.negotiate.maxRounds", "limits.maxRounds", "routing.reviewStrategy"] as const;

/** Which of `PROFILE_KEYS` are present in the raw config (before defaults), for the loader. */
export function explicitProfileKeys(raw: Record<string, unknown>): string[] {
  return PROFILE_KEYS.filter((key) => {
    let at: unknown = raw;
    for (const part of key.split(".")) {
      if (!at || typeof at !== "object" || !Object.hasOwn(at, part) || (at as Record<string, unknown>)[part] === undefined) return false;
      at = (at as Record<string, unknown>)[part];
    }
    return true;
  });
}

/**
 * `config` with the profile's defaults filled in, as a new object (nothing is written to disk).
 * `profile` (the `--profile` flag) beats `run.profile`. A key the user set is never overridden: that is a
 * non-default value, a key in `config.run.explicit` (the loader lists the keys present in the config files
 * and the flags `--style` / `--max-rounds`), or one in `options.explicit`. Balanced returns `config` as it is.
 */
export function applyRunProfile(
  config: AssentorConfig,
  options: { profile?: RunProfile; explicit?: readonly string[] } = {},
): AssentorConfig {
  const profile = options.profile ?? profileOf(config);
  if (profile === "balanced") return options.profile ? { ...config, run: { ...config.run, profile } } : config;
  const explicit = new Set([...(config.run.explicit ?? []), ...(options.explicit ?? [])]);
  const unset = (key: (typeof PROFILE_KEYS)[number], value: unknown, builtin: unknown) => value === builtin && !explicit.has(key);
  const next: AssentorConfig = { ...config, run: { ...config.run, profile } };

  if (profile === "max") {
    if (unset("output.style", config.output.style, "normal")) next.output = { ...config.output, style: "verbose" };
    if (unset("limits.maxRounds", config.limits.maxRounds, 8)) next.limits = { ...config.limits, maxRounds: 12 };
    if (unset("routing.reviewStrategy", config.routing.reviewStrategy, DEFAULT_REVIEW_STRATEGY)) next.routing = { ...config.routing, reviewStrategy: "FULL" };
  } else {
    if (!explicit.has("skills.enabled") && config.skills.enabled.length === 0) next.skills = { ...config.skills, enabled: ["lean"] };
    // The panel stays configured; `reviewNarrowing` picks one member or all at each review.
    if (unset("routing.reviewStrategy", config.routing.reviewStrategy, DEFAULT_REVIEW_STRATEGY)) next.run = { ...next.run, narrowReview: true };
  }
  const negotiate = config.modes.negotiate;
  if (negotiate && unset("modes.negotiate.maxRounds", negotiate.maxRounds, DEFAULT_NEGOTIATE_ROUNDS)) {
    next.modes = { ...config.modes, negotiate: { ...negotiate, maxRounds: profile === "max" ? 5 : 2 } };
  }
  return next;
}

/**
 * Economy review narrowing: undefined unless the profile owns the review strategy (economy, the strategy
 * not set by the user, no review team: a team defines its own panel). Otherwise a function a panel calls at
 * each review: true = one member is enough, false = the whole panel. It runs `classifyRisk` on the task
 * text plus the changed files and diff in the review's evidence pack, so a task that sounds safe but touches
 * a danger area still gets the full panel. Without a readable pack (no evidence, not a git repo) it
 * returns false: unknown changes get the full panel.
 */
export function reviewNarrowing(
  config: AssentorConfig,
  taskText: string,
  projectRoot?: string,
): ((input: { evidencePack?: { git?: Partial<Pick<ProjectReviewEvidencePack["git"], "isRepo" | "changedFiles" | "diff">> } }) => boolean) | undefined {
  if (!config.run.narrowReview || config.modes.review) return undefined;
  const options = { ...(projectRoot ? { projectRoot } : {}), extraRules: config.modes.cascade?.dangerAreas };
  return ({ evidencePack }) => {
    const git = evidencePack?.git;
    if (!git?.isRepo) return false;
    return classifyRisk({ taskText, paths: git.changedFiles ?? [], diff: git.diff ?? "" }, options).level !== "danger";
  };
}

/**
 * Model for a Lead seat. Under `economy`, a planning, tests or docs seat moves to the cheapest roster model
 * of the same provider that lists the matching strength, when that is cheaper than what was asked for
 * (`AUTO` counts as unknown, so any capable model is cheaper). Other profiles, other roles and
 * providers without a cheaper capable model keep `model`.
 */
export function routeSeatModel(
  config: AssentorConfig,
  roster: readonly RosterEntry[],
  seat: { role: string; provider: string; model: string },
): string {
  const strength = ECONOMY_ROLE_STRENGTH[seat.role];
  if (profileOf(config) !== "economy" || !strength) return seat.model;
  const now = Date.now();
  const asked = roster.find((e) => e.provider === seat.provider && e.model === seat.model);
  const cheapest = roster
    .filter((e) => e.provider === seat.provider && e.strengths.includes(strength) && !(e.rateLimitedUntil && Date.parse(e.rateLimitedUntil) > now))
    .sort((a, b) => costRank(a.cost) - costRank(b.cost) || (a.model < b.model ? -1 : 1))[0];
  return cheapest && (!asked || costRank(cheapest.cost) < costRank(asked.cost)) ? cheapest.model : seat.model;
}

/** One line for the run banner when a profile other than balanced is active; undefined for balanced. */
export function profileNote(config: AssentorConfig): string | undefined {
  const profile = profileOf(config);
  return profile === "balanced" ? undefined : `profile: ${profile} (${PROFILE_CHANGES[profile].summary})`;
}

/** Text for `assentor modes` and `--help`: what each profile changes. */
export function formatProfiles(): string {
  const lines = ["Run profiles (--profile, run.profile; explicit config and flags always win):"];
  for (const profile of RUN_PROFILES) {
    const { summary, changes } = PROFILE_CHANGES[profile];
    lines.push(`  ${profile}: ${summary}`, ...changes.map((c) => `    - ${c}`));
  }
  lines.push(
    "  economy does NOT turn on, pending the live A/B (bench:tokens --live):",
    ...PENDING_LIVE_AB.map((c) => `    - ${c}`),
  );
  return lines.join("\n");
}
