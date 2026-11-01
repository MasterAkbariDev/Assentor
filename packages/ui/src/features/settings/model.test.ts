import { describe, expect, it } from "vitest";
import { buildPatch, LOGIN_HINTS, toForm, validate, type SettingsView } from "./model.js";

const view: SettingsView = {
  executor: { provider: "claude-code", model: "AUTO" },
  run: { autonomy: "supervised" },
  routing: { strategy: "BALANCED", reviewStrategy: "ADAPTIVE" },
  limits: { maxRounds: 3, maxMessages: 40, maxRuntimeMinutes: 60, maxToolCalls: 200 },
  git: { checkpoints: true, autoCommit: false },
  artifacts: { diff: true, tests: true, logs: false, screenshots: false },
};

describe("settings model", () => {
  it("builds a patch with only the fields that changed", () => {
    const original = toForm(view);
    const form = structuredClone(original);
    form.executor.model = " opus ";
    form.routing.strategy = "BEST";
    expect(buildPatch(form, original)).toEqual({ executor: { model: "opus" }, routing: { strategy: "BEST" } });
  });

  it("builds an empty patch when nothing changed", () => {
    const original = toForm(view);
    expect(buildPatch(structuredClone(original), original)).toEqual({});
  });

  it("sends the autonomy with a changed run section", () => {
    const original = toForm(view);
    const form = { ...original, run: { autonomy: "autopilot" as const } };
    expect(buildPatch(form, original)).toEqual({ run: { autonomy: "autopilot" } });
  });

  it("refuses a blank model when one is set, since the patch cannot unset it", () => {
    const original = toForm(view);
    const form = structuredClone(original);
    form.executor.model = "  ";
    expect(validate(form, original)["executor.model"]).toMatch(/Type AUTO/);
  });

  it("rejects a malformed model id with the engine's rule", () => {
    const original = toForm(view);
    const form = structuredClone(original);
    form.executor.model = "-flag";
    expect(validate(form, original)["executor.model"]).toMatch(/AUTO/);
  });

  it("requires every limit to be a whole number of at least 1", () => {
    const original = toForm(view);
    for (const bad of ["0", "1.5", "abc", "", "-2"]) {
      const form = structuredClone(original);
      form.limits.maxRounds = bad;
      expect(validate(form, original)["limits.maxRounds"]).toMatch(/whole number/);
    }
    expect(validate(structuredClone(original), original)).toEqual({});
  });

  it("does not validate a legacy model that was not changed, so other fields still save", () => {
    const loaded = { ...view, executor: { provider: "claude-code", model: "gpt 5" } };
    const original = toForm(loaded);
    const form = structuredClone(original);
    form.limits.maxRounds = "4";
    expect(validate(form, original)).toEqual({});
    expect(buildPatch(form, original)).toEqual({ limits: { maxRounds: 4 } });
  });

  it("validates a legacy model once the user changes it", () => {
    const original = toForm({ ...view, executor: { provider: "claude-code", model: "gpt 5" } });
    const form = structuredClone(original);
    form.executor.model = "gpt 6";
    expect(validate(form, original)["executor.model"]).toMatch(/AUTO/);
  });

  it("treats numerically equal limits as unchanged", () => {
    const original = toForm({ ...view, limits: { ...view.limits, maxRounds: 7 } });
    const form = structuredClone(original);
    form.limits.maxRounds = "007";
    expect(validate(form, original)).toEqual({});
    expect(buildPatch(form, original)).toEqual({});
  });

  it("names a login command only for CLIs the engine documents one for", () => {
    expect(LOGIN_HINTS["claude-code"]).toBe("claude");
    expect(LOGIN_HINTS.codex).toBeUndefined();
  });
});
