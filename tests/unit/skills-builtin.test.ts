import { describe, expect, it } from "vitest";
import { BUILTIN_BUILDER_ROLES, BUILTIN_REVIEW_ROLES, BUILTIN_SEAT_ROLES } from "../../packages/protocol/src/seats.js";
import { parseAssentorConfig } from "../../packages/engine/src/config/load.js";
import { PromptLibrary } from "../../packages/engine/src/prompts/library.js";
import {
  expandSkillPresets,
  renderSkillsIndex,
  SKILL_PRESETS,
  SKILLS_INDEX_MAX_TOKENS,
  SkillLibrary,
  SkillSession,
} from "../../packages/engine/src/skills/index.js";
import { gateVariant, resolveVariant, runMock } from "../../scripts/bench/tokens.js";

/** TE-08: the eight built-in token-saver skills, their on/off status, and the `lean` preset. */

const NAMES = [
  "answer-first",
  "compact-handoff",
  "minimal-diff-edits",
  "plan-in-bullets",
  "review-signal-only",
  "smallest-solution",
  "targeted-reading",
  "test-triage",
];
const words = (text: string) => text.trim().split(/\s+/).length;

describe("built-in skills", () => {
  it("all eight load with zero errors, each body at most 400 words", async () => {
    const library = await SkillLibrary.load({ userDir: "/nonexistent-user-dir" });
    expect(library.errors).toEqual([]);
    expect(library.list().map((s) => s.name)).toEqual(NAMES);
    for (const skill of library.list()) {
      expect(words(skill.body), skill.name).toBeLessThanOrEqual(400);
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(200);
      expect(skill.description, skill.name).toMatch(/^Use when /);
      expect(skill.layer).toBe("builtin");
    }
  });

  it("targets only built-in roles, and reviewers get only the review and answer skills", async () => {
    const library = await SkillLibrary.load({ userDir: "/nonexistent-user-dir" });
    const prompts = PromptLibrary.loadBuiltinSync();
    const all = [...NAMES];
    for (const skill of library.list()) {
      for (const role of skill.roles ?? []) expect(BUILTIN_SEAT_ROLES as readonly string[], `${skill.name}: ${role}`).toContain(role);
      for (const role of skill.roles ?? []) expect(prompts.get(role), `${skill.name}: ${role}`).toBeTruthy();
    }
    const enabled = { enabled: all };
    for (const role of BUILTIN_REVIEW_ROLES) {
      const names = library.eligible({ role, permissions: "read-only", ...enabled }).map((s) => s.name);
      expect(names.every((n) => n === "answer-first" || n === "review-signal-only"), role).toBe(true);
    }
    for (const role of BUILTIN_BUILDER_ROLES) {
      expect(library.eligible({ role, permissions: "edit", ...enabled }).map((s) => s.name), role).not.toContain("review-signal-only");
    }
  });

  it("states that the role prompt's output format wins where a skill touches the output", async () => {
    const library = await SkillLibrary.load({ userDir: "/nonexistent-user-dir" });
    for (const name of ["answer-first", "compact-handoff", "review-signal-only", "plan-in-bullets"]) {
      expect(library.get(name)!.body, name).toMatch(/role prompt/i);
    }
    // Reviewer JSON, planner JSON and the Lead report block must survive.
    expect(library.get("review-signal-only")!.body).toMatch(/JSON/);
    expect(library.get("compact-handoff")!.body).toMatch(/Lead task report/);
    expect(library.get("test-triage")!.body).toMatch(/full suite/);
  });

  it("is off by default and on only through skills.enabled", async () => {
    const library = await SkillLibrary.load({ userDir: "/nonexistent-user-dir" });
    expect(library.list().every((s) => s.optIn)).toBe(true);
    const seat = { id: "s1", role: "engineer", permissions: "edit" as const };
    const off = new SkillSession(library, { sessionId: "x" });
    expect(off.index(seat)).toBe("");
    expect(off.load(seat, ["test-triage"], "request")).toEqual([]);
    const on = new SkillSession(library, { sessionId: "x", enabled: ["test-triage"] });
    expect(on.index(seat)).toContain("- test-triage:");
    expect(on.load(seat, ["test-triage"], "request")).toEqual(["test-triage"]);
    expect(parseAssentorConfig({}).skills.enabled).toEqual([]);
  });

  it("keeps the index under its cap with all eight, and each role's own index untruncated", async () => {
    const library = await SkillLibrary.load({ userDir: "/nonexistent-user-dir" });
    const tokens = (text: string) => Math.ceil(text.length / 4);
    expect(tokens(renderSkillsIndex(library.list()))).toBeLessThanOrEqual(SKILLS_INDEX_MAX_TOKENS);
    for (const role of BUILTIN_SEAT_ROLES) {
      const index = renderSkillsIndex(library.eligible({ role, permissions: role === "planner" ? "read-only" : "edit", enabled: NAMES }));
      expect(tokens(index), role).toBeLessThanOrEqual(SKILLS_INDEX_MAX_TOKENS);
      expect(index, role).not.toMatch(/\+\d+ more/);
    }
  });
});

describe("lean preset", () => {
  const variants = ["baseline", ...NAMES.map((n) => `skills:${n}`), "skills:all", "skills:lean"].map((n) => resolveVariant(n));
  const report = runMock({ library: PromptLibrary.loadBuiltinSync(), variants, runs: 5 });
  const net = (name: string) => report.variants.find((v) => v.name === name)!.netPerSuccess.mean;
  const change = (name: string) => net(`skills:${name}`) / net("baseline") - 1;

  it("contains only skills that passed: gate pass, no success drop, net tokens down at least 10%", () => {
    for (const name of SKILL_PRESETS.lean!) {
      expect(NAMES, name).toContain(name);
      expect(gateVariant(report, `skills:${name}`).pass, name).toBe(true);
      expect(change(name), name).toBeLessThanOrEqual(-0.1);
    }
    expect(expandSkillPresets(["lean", "x", "x"])).toEqual([...SKILL_PRESETS.lean!, "x"]);
    // The lean variant is exactly what the preset lists.
    expect(report.variants.find((v) => v.name === "skills:lean")!.overlay.skills).toEqual([...SKILL_PRESETS.lean!]);
  });

  it("every skill outside it says it is off, with its measured mock number", async () => {
    const library = await SkillLibrary.load({ userDir: "/nonexistent-user-dir" });
    for (const skill of library.list().filter((s) => !SKILL_PRESETS.lean!.includes(s.name))) {
      expect(skill.optIn, skill.name).toBe(true);
      const measured = `${change(skill.name) >= 0 ? "+" : ""}${Math.round(change(skill.name) * 100)}%`;
      expect(skill.description, skill.name).toContain(`Off, mock bench ${measured} tokens`);
    }
  });

  it("loading all eight is the owner's failure mode: net tokens more than double and the gate fails", () => {
    expect(net("skills:all") / net("baseline")).toBeGreaterThan(2);
    expect(gateVariant(report, "skills:all").pass).toBe(false);
    expect(report.variants.every((v) => v.successRate === 1)).toBe(true);
  });
});
