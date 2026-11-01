import { describe, expect, it } from "vitest";
import {
  applyRunProfile,
  formatProfiles,
  parseRunProfile,
  profileNote,
  reviewStrategyFor,
  routeSeatModel,
  PENDING_LIVE_AB,
  RUN_PROFILES,
  type RunProfile,
} from "../../packages/engine/src/config/profile.js";
import { parseAssentorConfig } from "../../packages/engine/src/config/schema.js";
import { selectReviewerBackends } from "../../packages/engine/src/review/backends.js";
import type { RosterEntry } from "../../packages/engine/src/modes/roster.js";

const TEAM = { team: "t" };
const config = (extra: Record<string, unknown> = {}) =>
  parseAssentorConfig({
    reviewers: [{ provider: "mock", name: "a" }, { provider: "mock", name: "b" }],
    modes: { negotiate: TEAM },
    ...extra,
  });
const SAFE = "Fix the off-by-one in the average() helper";
const DANGER = "Rebase the feature branch and force-push it";

/** The effective config of a profile, as the columns of the table. */
function effective(profile: RunProfile, task = SAFE, extra: Record<string, unknown> = {}) {
  const base = config(extra);
  const c = applyRunProfile(base, { profile });
  return {
    style: c.output.style,
    skills: c.skills.enabled,
    contextBudgets: c.context?.budgetTokens,
    negotiateRounds: c.modes.negotiate?.maxRounds,
    maxRounds: c.limits.maxRounds,
    reviewStrategy: reviewStrategyFor(c, task),
  };
}

describe("run profile -> effective config", () => {
  it("table", () => {
    expect({
      balanced: effective("balanced"),
      economy: effective("economy"),
      "economy, danger task": effective("economy", DANGER),
      max: effective("max"),
    }).toEqual({
      balanced: { style: "normal", skills: [], contextBudgets: undefined, negotiateRounds: 3, maxRounds: 8, reviewStrategy: "ADAPTIVE" },
      // economy never turns on concise or context cuts: both are pending the live A/B
      economy: { style: "normal", skills: ["lean"], contextBudgets: undefined, negotiateRounds: 2, maxRounds: 8, reviewStrategy: "SINGLE" },
      "economy, danger task": { style: "normal", skills: ["lean"], contextBudgets: undefined, negotiateRounds: 2, maxRounds: 8, reviewStrategy: "ADAPTIVE" },
      max: { style: "verbose", skills: [], contextBudgets: undefined, negotiateRounds: 5, maxRounds: 12, reviewStrategy: "FULL" },
    });
  });

  it("balanced is today's behaviour: the same config, untouched", () => {
    const c = config();
    expect(applyRunProfile(c)).toBe(c);
    expect(applyRunProfile(c, { profile: "balanced" })).toEqual({ ...c, run: { ...c.run, profile: "balanced" } });
    expect(reviewStrategyFor(c, DANGER)).toBe("ADAPTIVE");
    expect(profileNote(c)).toBeUndefined();
  });

  it("run.profile in the config is used; the flag beats it", () => {
    const c = config({ run: { profile: "max" } });
    expect(c.run.profile).toBe("max");
    expect(applyRunProfile(c).output.style).toBe("verbose");
    expect(applyRunProfile(c, { profile: "economy" }).output.style).toBe("normal");
    expect(() => config({ run: { profile: "turbo" } })).toThrow();
    expect(parseRunProfile(" Economy ")).toBe("economy");
    expect(() => parseRunProfile("turbo")).toThrow(/Use one of: economy, balanced, max/);
  });

  it("danger keeps the full panel under economy, and one reviewer is cut only without it", () => {
    const economy = applyRunProfile(config(), { profile: "economy" });
    const panel = (task: string) => selectReviewerBackends(economy, reviewStrategyFor(economy, task)).map((b) => b.name);
    expect(panel(SAFE)).toEqual(["a"]);
    expect(panel(DANGER)).toEqual(["a", "b"]);
    // Today's behaviour for the same task, unchanged: the whole configured panel.
    expect(selectReviewerBackends(config()).map((b) => b.name)).toEqual(["a", "b"]);
  });

  it("explicit config and flags win", () => {
    const own = config({ routing: { reviewStrategy: "PANEL" }, output: { style: "concise" }, skills: { enabled: ["answer-first"] }, modes: { negotiate: { ...TEAM, maxRounds: 4 } }, limits: { maxRounds: 3 } });
    for (const profile of ["economy", "max"] as const) {
      const c = applyRunProfile(own, { profile });
      expect(c.output.style).toBe("concise");
      expect(c.skills.enabled).toEqual(["answer-first"]);
      expect(c.modes.negotiate?.maxRounds).toBe(4);
      expect(c.limits.maxRounds).toBe(3);
      expect(reviewStrategyFor(c, DANGER)).toBe("PANEL");
      expect(reviewStrategyFor(c, SAFE)).toBe("PANEL");
    }
    // An explicit SINGLE stays SINGLE even for a danger task (the user asked for it).
    const single = applyRunProfile(config({ routing: { reviewStrategy: "SINGLE" } }), { profile: "economy" });
    expect(reviewStrategyFor(single, DANGER)).toBe("SINGLE");
    // A flag set to the built-in default value still wins, when the caller says it was a flag.
    expect(applyRunProfile(config(), { profile: "max", explicit: ["output.style"] }).output.style).toBe("normal");
  });

  it("negotiation is untouched when modes.negotiate is not configured", () => {
    const c = applyRunProfile(parseAssentorConfig({}), { profile: "economy" });
    expect(c.modes.negotiate).toBeUndefined();
  });

  it("lists every profile and what economy leaves off", () => {
    const text = formatProfiles();
    for (const profile of RUN_PROFILES) expect(text).toContain(`  ${profile}:`);
    expect(PENDING_LIVE_AB.join("\n")).toMatch(/concise.*\+7\.8%/);
    expect(PENDING_LIVE_AB.join("\n")).toMatch(/context\.budgetTokens/);
  });
});

describe("economy routing", () => {
  const entry = (provider: string, model: string, cost: RosterEntry["cost"], strengths: RosterEntry["strengths"], over: Partial<RosterEntry> = {}): RosterEntry =>
    ({ provider, model, label: model, strengths, speed: "fast", cost, freeSlots: 1, ...over }) as RosterEntry;
  const roster = [
    entry("claude-code", "opus", "high", ["coding", "reasoning", "tests"]),
    entry("claude-code", "haiku", "low", ["tests", "docs"]),
    entry("gemini", "pro", "medium", ["reasoning", "docs"]),
  ];
  const economy = applyRunProfile(config(), { profile: "economy" });
  const route = (cfg: typeof economy, role: string, provider: string, model: string) => routeSeatModel(cfg, roster, { role, provider, model });

  it("moves planning, tests and docs seats to the cheapest capable model of the provider", () => {
    expect(route(economy, "test-writer", "claude-code", "opus")).toBe("haiku");
    expect(route(economy, "docs-writer", "claude-code", "AUTO")).toBe("haiku");
    expect(route(economy, "planner", "gemini", "AUTO")).toBe("pro");
  });

  it("keeps the model when nothing capable is cheaper, for other roles, and outside economy", () => {
    expect(route(economy, "planner", "claude-code", "opus")).toBe("opus"); // only opus lists reasoning
    expect(route(economy, "engineer", "claude-code", "opus")).toBe("opus");
    expect(route(economy, "test-writer", "claude-code", "haiku")).toBe("haiku");
    expect(route(config(), "test-writer", "claude-code", "opus")).toBe("opus");
    expect(route(applyRunProfile(config(), { profile: "max" }), "test-writer", "claude-code", "opus")).toBe("opus");
  });

  it("skips a rate-limited model", () => {
    const limited = [entry("claude-code", "haiku", "low", ["tests"], { rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() }), entry("claude-code", "opus", "high", ["tests"])];
    expect(routeSeatModel(economy, limited, { role: "test-writer", provider: "claude-code", model: "opus" })).toBe("opus");
  });
});
