import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAssentorConfig } from "../../packages/engine/src/config/load.js";
import { PanelReviewer } from "../../packages/engine/src/review/coordinator.js";
import { estimateRun } from "../../packages/engine/src/estimate/cost.js";
import {
  applyRunProfile,
  formatProfiles,
  parseRunProfile,
  profileNote,
  reviewNarrowing,
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
/** An evidence pack with these changes. */
const pack = (changedFiles: string[], diff = "") => ({ evidencePack: { git: { isRepo: true, changedFiles, diff } } });

/** The effective config of a profile, as the columns of the table. */
function effective(profile: RunProfile, extra: Record<string, unknown> = {}) {
  const c = applyRunProfile(config(extra), { profile });
  return {
    style: c.output.style,
    skills: c.skills.enabled,
    contextBudgets: c.context?.budgetTokens,
    negotiateRounds: c.modes.negotiate?.maxRounds,
    maxRounds: c.limits.maxRounds,
    reviewStrategy: c.routing.reviewStrategy,
    narrowsReview: Boolean(reviewNarrowing(c, SAFE)),
  };
}

describe("run profile -> effective config", () => {
  it("table", () => {
    expect({ balanced: effective("balanced"), economy: effective("economy"), max: effective("max") }).toEqual({
      balanced: { style: "normal", skills: [], contextBudgets: undefined, negotiateRounds: 3, maxRounds: 8, reviewStrategy: "ADAPTIVE", narrowsReview: false },
      // economy never turns on concise or context cuts: both are pending the live A/B
      economy: { style: "normal", skills: ["lean"], contextBudgets: undefined, negotiateRounds: 2, maxRounds: 8, reviewStrategy: "ADAPTIVE", narrowsReview: true },
      max: { style: "verbose", skills: [], contextBudgets: undefined, negotiateRounds: 5, maxRounds: 12, reviewStrategy: "FULL", narrowsReview: false },
    });
  });

  it("balanced is today's behaviour: the same config, untouched", () => {
    const c = config();
    expect(applyRunProfile(c)).toBe(c);
    expect(applyRunProfile(c, { profile: "balanced" })).toEqual({ ...c, run: { ...c.run, profile: "balanced" } });
    expect(reviewNarrowing(c, DANGER)).toBeUndefined();
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

  it("economy picks one reviewer or the whole panel at each review, from the changes", () => {
    const economy = applyRunProfile(config(), { profile: "economy" });
    const narrow = reviewNarrowing(economy, SAFE)!;
    expect(narrow(pack(["src/average.ts"], "+const total = items.length + 1;"))).toBe(true);
    // A safe-sounding task whose changed file or diff touches a danger area gets the full panel.
    expect(narrow(pack(["src/process/kill-tree.ts"]))).toBe(false);
    expect(narrow(pack(["src/average.ts"], '+++ b/src/average.ts\n+const child = spawn("codex", args, { detached: true });'))).toBe(false);
    // A danger task gets it too, and so do changes it cannot see.
    expect(reviewNarrowing(economy, DANGER)!(pack(["src/average.ts"]))).toBe(false);
    expect(narrow({})).toBe(false);
    expect(narrow({ evidencePack: { git: { isRepo: false, changedFiles: [], diff: "" } } })).toBe(false);
    // The same call decides again for the next review of the same task.
    expect([narrow(pack(["a.ts"])), narrow(pack(["src/keys/vault.ts"])), narrow(pack(["b.ts"]))]).toEqual([true, false, true]);
  });

  it("a panel under economy sends the review to one member, or all of them on danger", async () => {
    const calls: string[] = [];
    const member = (name: string) => ({
      name,
      review: async () => (calls.push(name), { result: { status: "PASS", confidence: 0.9, summary: "ok", issues: [], requiredChanges: [], optionalChanges: [], evidenceRequests: [] } }),
      continue: async () => ({ error: "unused" }),
    });
    const economy = applyRunProfile(config(), { profile: "economy" });
    const panel = new PanelReviewer({ reviewers: [member("a"), member("b"), member("c")] as never, narrow: reviewNarrowing(economy, SAFE)! });
    const input = (changedFiles: string[]) => ({ taskId: "t", projectPath: ".", contract: {}, round: 1, artifacts: [], ...pack(changedFiles) }) as never;
    await panel.review(input(["src/average.ts"]));
    expect(calls.splice(0)).toEqual(["a"]);
    await panel.review(input(["src/keys/vault.ts"]));
    expect(calls.splice(0).sort()).toEqual(["a", "b", "c"]);
    // Without narrowing (balanced), every review is the whole panel.
    await new PanelReviewer({ reviewers: [member("a"), member("b")] as never }).review(input(["src/average.ts"]));
    expect(calls.splice(0).sort()).toEqual(["a", "b"]);
  });

  it("the estimate counts the first reviewer low and the whole panel high under economy", () => {
    const plain = () => parseAssentorConfig({ reviewers: [{ provider: "mock", name: "a" }, { provider: "mock", name: "b" }] });
    const low = (c: ReturnType<typeof plain>) => estimateRun(c, { prompt: SAFE, modeId: "review" });
    const balanced = low(plain());
    const economy = low(applyRunProfile(plain(), { profile: "economy" }));
    expect(economy.totalLow).toBeLessThan(balanced.totalLow);
    expect(economy.totalHigh).toBe(balanced.totalHigh);
  });

  it("explicit config and flags win", () => {
    const own = config({ routing: { reviewStrategy: "PANEL" }, output: { style: "concise" }, skills: { enabled: ["answer-first"] }, modes: { negotiate: { ...TEAM, maxRounds: 4 } }, limits: { maxRounds: 3 } });
    for (const profile of ["economy", "max"] as const) {
      const c = applyRunProfile(own, { profile });
      expect(c.output.style).toBe("concise");
      expect(c.skills.enabled).toEqual(["answer-first"]);
      expect(c.modes.negotiate?.maxRounds).toBe(4);
      expect(c.limits.maxRounds).toBe(3);
      expect(c.routing.reviewStrategy).toBe("PANEL");
      expect(c.run.narrowReview).toBeUndefined();
    }
    // Keys listed as explicit win even at their built-in value.
    const same = applyRunProfile(config(), { profile: "max", explicit: ["output.style", "limits.maxRounds", "routing.reviewStrategy"] });
    expect([same.output.style, same.limits.maxRounds, same.routing.reviewStrategy]).toEqual(["normal", 8, "ADAPTIVE"]);
    const kept = applyRunProfile(config(), { profile: "economy", explicit: ["routing.reviewStrategy", "modes.negotiate.maxRounds", "skills.enabled"] });
    expect([kept.run.narrowReview, kept.modes.negotiate?.maxRounds, kept.skills.enabled]).toEqual([undefined, 3, []]);
    // An explicit SINGLE stays SINGLE: one member always, no narrowing to decide.
    expect(applyRunProfile(config({ routing: { reviewStrategy: "SINGLE" } }), { profile: "economy" }).run.narrowReview).toBeUndefined();
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

describe("the loader records what the user set", () => {
  const dirs: string[] = [];
  beforeEach(() => {
    process.env.ASSENTOR_USER_DIR = path.join(os.tmpdir(), "assentor-profile-no-user");
  });
  afterEach(async () => {
    delete process.env.ASSENTOR_USER_DIR;
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });
  async function project(yaml: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-profile-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(dir, ".assentor", "config.yaml"), yaml);
    return dir;
  }

  it("a key written at its default value survives economy; unwritten keys take the profile", async () => {
    const dir = await project("routing:\n  reviewStrategy: ADAPTIVE\nmodes:\n  negotiate:\n    team: t\n    maxRounds: 3\nrun:\n  profile: economy\n");
    const loaded = await loadAssentorConfig(dir);
    expect(loaded.run.explicit).toEqual(["modes.negotiate.maxRounds", "routing.reviewStrategy"]);
    const c = applyRunProfile(loaded);
    expect(c.run.narrowReview).toBeUndefined();
    expect(c.modes.negotiate?.maxRounds).toBe(3);
    expect(c.skills.enabled).toEqual(["lean"]);
    const bare = applyRunProfile(await loadAssentorConfig(await project("modes:\n  negotiate:\n    team: t\n")), { profile: "economy" });
    expect([bare.run.narrowReview, bare.modes.negotiate?.maxRounds]).toEqual([true, 2]);
  });

  it("--style and --max-rounds win over a profile, even at the default value", async () => {
    const dir = await project("");
    const c = applyRunProfile(await loadAssentorConfig(dir, { style: "normal", maxRounds: 8, profile: "max" }));
    expect([c.run.profile, c.output.style, c.limits.maxRounds]).toEqual(["max", "normal", 8]);
    const free = applyRunProfile(await loadAssentorConfig(dir, { profile: "max" }));
    expect([free.output.style, free.limits.maxRounds]).toEqual(["verbose", 12]);
  });

  it("runtime fields are never saved", async () => {
    const { saveAssentorConfig } = await import("../../packages/engine/src/config/load.js");
    const dir = await project("");
    const c = applyRunProfile(await loadAssentorConfig(dir, { profile: "economy" }));
    const file = await saveAssentorConfig(dir, c, { scope: "project" });
    const text = await fs.readFile(file, "utf8");
    expect(text).not.toMatch(/explicit|narrowReview/);
  });
});
