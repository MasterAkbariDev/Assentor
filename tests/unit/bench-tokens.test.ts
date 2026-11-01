import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PromptLibrary } from "../../packages/engine/src/prompts/library.js";
import { BENCH_TASKS, BENCH_TASKS_LARGE, type BenchTask } from "../../scripts/bench/tasks.js";
import { cliUsage } from "../../packages/engine/src/usage/cli-usage.js";
import {
  gateVariant,
  renderReport,
  resolveVariant,
  runLive,
  runMock,
  seatExtra,
  type BenchReport,
  type MockScript,
  type Variant,
  type VariantResult,
} from "../../scripts/bench/tokens.js";
import { main } from "../../scripts/bench/cli.js";

const library = PromptLibrary.loadBuiltinSync();
const baseline = resolveVariant("baseline");
const variant = (name: string, mock: MockScript, alwaysOn = ""): Variant => ({ name, overlay: {}, alwaysOn, notes: [], mock });
/** A "be brief" token saver whose ~600-token body is sent with every call: the owner's failure mode. */
const BLOATED_SAVER = `## Token saver\n${"- Be brief: answer first, no preamble, no restating the task, no closing summary.\n".repeat(30)}`;

const bench = (...variants: Variant[]) => runMock({ library, runs: 3, variants: [baseline, ...variants] });
const result = (report: BenchReport, name: string) => report.variants.find((v) => v.name === name)!;

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("fixture tasks", () => {
  it("each check passes with the competent mock reply and fails on the untouched project", () => {
    for (const task of BENCH_TASKS) {
      expect(task.check({ output: task.mock.output, files: { ...task.files, ...task.mock.edits } }), task.id).toBe(true);
      expect(task.check({ output: "", files: task.files }), task.id).toBe(false);
    }
    expect(BENCH_TASKS.map((t) => t.id)).toEqual(["bug-fix", "add-test", "refactor", "review", "plan"]);
  });
});

describe("mock runner", () => {
  it("is deterministic on repeat, with a spread over runs", () => {
    const first = bench(variant("short", { outputScale: 0.5 }));
    expect(bench(variant("short", { outputScale: 0.5 }))).toEqual(first);
    const base = result(first, "baseline");
    expect(base.successRate).toBe(1);
    expect(base.netPerSuccess.min).toBeLessThan(base.netPerSuccess.max);
    expect(base.cachedTokens).toBeGreaterThan(0); // multi-turn seats reuse their prefix
  });

  it("a bloated always-on saver shortens replies but raises net tokens, and the gate rejects it", () => {
    const report = bench(variant("bloated-saver", { outputScale: 0.6 }, BLOATED_SAVER));
    const base = result(report, "baseline");
    const saver = result(report, "bloated-saver");
    expect(saver.outputTokens).toBeLessThan(base.outputTokens);
    expect(saver.netPerSuccess.mean).toBeGreaterThan(base.netPerSuccess.mean * 1.3);
    const gate = gateVariant(report, "bloated-saver");
    expect(gate.pass).toBe(false);
    // Mock: its growth is exactly its always-on text on every call, so the cap is what rejects it.
    expect(gate.reasons).toEqual([expect.stringMatching(/^always-on text is \d+ tokens per seat prompt, over the 300-token cap$/)]);
    expect(gateVariant({ ...report, runner: "live" }, "bloated-saver").reasons[1]).toMatch(
      /^net tokens per successful task \+\d+(\.\d)?% vs baseline; needs -10% or better$/,
    );
  });

  it("the owner's case: an injected saver body plus extra reads about doubles net tokens per task", () => {
    const report = bench(variant("saver-skill", { outputScale: 0.6, extraTurns: 2 }, BLOATED_SAVER));
    expect(result(report, "saver-skill").netPerSuccess.mean / result(report, "baseline").netPerSuccess.mean).toBeGreaterThan(1.9);
    expect(gateVariant(report, "saver-skill").pass).toBe(false);
  });

  it("judges by net tokens, not reply length: shorter replies that cost a turn fail", () => {
    const report = bench(variant("short-extra-turn", { outputScale: 0.5, extraTurns: 1 }));
    const base = result(report, "baseline");
    const v = result(report, "short-extra-turn");
    expect(v.outputTokens).toBeLessThan(base.outputTokens);
    expect(v.calls).toBeGreaterThan(base.calls);
    expect(v.netPerSuccess.mean).toBeGreaterThan(base.netPerSuccess.mean);
    for (const runner of ["mock", "live"] as const) {
      expect(gateVariant({ ...report, runner }, "short-extra-turn").reasons).toEqual([
        expect.stringMatching(/^net tokens per successful task \+/),
      ]);
    }
  });

  it("a reply too short to keep its handoff costs a follow-up turn, counted as a retry", () => {
    const report = bench(variant("drops-handoff", { outputScale: 0.5, dropHandoff: true }));
    const v = result(report, "drops-handoff");
    // One follow-up per seat run: a panel task runs once per member.
    expect(v.retries).toBe(BENCH_TASKS.reduce((n, t) => n + (t.panel?.length ?? 1), 0));
    expect(v.successRate).toBe(1);
    expect(gateVariant(report, "drops-handoff").pass).toBe(false);
  });

  it("reports cached tokens, and the gate fails a variant whose changing prefix loses the cache", () => {
    const report = bench(variant("unstable", { unstablePrefix: true }));
    expect(result(report, "unstable").cachedTokens).toBe(0);
    expect(result(report, "baseline").cachedShare).toBeGreaterThan(0.3);
    for (const runner of ["mock", "live"] as const) {
      expect(gateVariant({ ...report, runner }, "unstable").reasons[0]).toMatch(
        /^cached share of prompt tokens fell to 0% from the baseline's \d+(\.\d)?% .*prefix is no longer stable$/,
      );
    }
  });

  it("the mock allowance is the variant's own always-on text: within the cap is not a free pass", () => {
    const small = "- answer-first: lead with the result.\n".repeat(4); // about 40 tokens
    const report = bench(variant("small", {}, small), variant("small-extra-turn", { extraTurns: 1 }, small));
    expect(gateVariant(report, "small")).toEqual({ pass: true, reasons: [] });
    expect(gateVariant(report, "small-extra-turn").reasons).toEqual([expect.stringMatching(/^net tokens per successful task \+/)]);
  });

  it("prompt order (TE-05): the shipped stable order keeps panel prefixes cached; the pre-TE-05 order loses them", () => {
    const report = bench(resolveVariant("cache:stable"), resolveVariant("cache:legacy"));
    const [base, stable, legacy] = (["baseline", "cache:stable", "cache:legacy"] as const).map((name) => result(report, name)) as [VariantResult, VariantResult, VariantResult];
    expect({ ...stable, name: "baseline", notes: [] }).toEqual({ ...base, notes: [] });
    // Same tokens, only where the cache can serve them differs.
    expect(legacy.promptTokens).toBe(base.promptTokens);
    expect(legacy.netPerSuccess).toEqual(base.netPerSuccess);
    expect(legacy.cachedShare).toBeLessThan(base.cachedShare - 0.05);
    expect(gateVariant(report, "cache:stable")).toEqual({ pass: true, reasons: [] });
    expect(gateVariant(report, "cache:legacy").reasons).toEqual([expect.stringMatching(/^cached share of prompt tokens fell/)]);
  });

  it("a no-op variant passes the mock gate", () => {
    const report = bench(resolveVariant("style:normal"));
    expect(gateVariant(report, "style:normal")).toEqual({ pass: true, reasons: [] });
    expect(renderReport(report)).toContain("| style:normal | 0 |");
  });

  it("style:concise pays its fragment on every call in the mock: no output saving is modelled", () => {
    const report = bench(resolveVariant("style:concise"));
    expect(renderReport(report)).toMatch(/\| style:concise \| [1-9]\d* \|/);
    expect(result(report, "style:concise").promptTokens).toBeGreaterThan(result(report, "baseline").promptTokens);
  });
});

describe("gate thresholds (live)", () => {
  const row = (name: string, net: number, successRate = 1): VariantResult => ({
    name,
    overlay: {},
    notes: [],
    alwaysOnTokens: 0,
    promptTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cachedShare: 0,
    calls: 5,
    retries: 0,
    successRate,
    netPerSuccess: { mean: net, min: net, max: net },
  });
  const report = (...rows: VariantResult[]): BenchReport => ({ runner: "live", runs: 1, tasks: ["a"], model: "", variants: [row("baseline", 1000), ...rows] });

  it("needs net tokens per success down at least 10% with no success drop", () => {
    expect(gateVariant(report(row("v", 900)), "v")).toEqual({ pass: true, reasons: [] });
    expect(gateVariant(report(row("v", 910)), "v").reasons).toEqual(["net tokens per successful task -9% vs baseline; needs -10% or better"]);
    expect(gateVariant(report(row("v", 500, 0.8)), "v").reasons).toEqual(["success rate 80% is below the baseline's 100%"]);
    expect(gateVariant(report(), "missing").pass).toBe(false);
  });
});

describe("variants", () => {
  it("resolves overlays, with no-ops for features not built yet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-root-"));
    dirs.push(root);
    expect(resolveVariant("profile:economy", root)).toMatchObject({ overlay: { profile: "economy" }, alwaysOn: "" });
    expect(resolveVariant("style:concise", root).notes[0]).toMatch(/not built yet/);
    expect(() => resolveVariant("nonsense", root)).toThrow(/Unknown variant/);

    await fs.mkdir(path.join(root, "prompts/builtin"), { recursive: true });
    await fs.writeFile(path.join(root, "prompts/builtin/style-concise.md"), "---\nid: style-concise\n---\nAnswer first.\n");
    await fs.mkdir(path.join(root, "skills/answer-first"), { recursive: true });
    await fs.writeFile(path.join(root, "skills/answer-first/SKILL.md"), "---\nname: answer-first\ndescription: Lead with the result.\nversion: 1\n---\nBody that loads on demand.\n");
    expect(resolveVariant("style:concise", root).alwaysOn).toBe("Answer first.");
    const withSkill = resolveVariant("skills:answer-first+missing", root);
    expect(withSkill).toMatchObject({ overlay: { skills: ["answer-first", "missing"] } });
    expect(withSkill.alwaysOn).toContain("- answer-first: Lead with the result.");
    expect(withSkill.notes[0]).toMatch(/missing is not built yet/);
    // The body is loaded text, not always-on: it is in the seat's extra, not in the index.
    expect(withSkill.alwaysOn).not.toContain("Body that loads on demand");
    expect(seatExtra(withSkill, "engineer")).toContain("Body that loads on demand");
  });
});

describe("live runner", () => {
  const options = { library, variants: [baseline], runs: 1, executor: "claude-code" };

  it("refuses without --live, without a budget, and in CI", async () => {
    await expect(runLive({ ...options, live: false, budgetTokens: 1000 })).rejects.toThrow(/pass --live/);
    await expect(runLive({ ...options, live: true, budgetTokens: 0 })).rejects.toThrow(/--budget/);
    vi.stubEnv("CI", "true");
    await expect(runLive({ ...options, live: true, budgetTokens: 1000 })).rejects.toThrow(/never run in CI/);
  });

  it("the CLI refuses live flags without --live and a budget", async () => {
    const err: string[] = [];
    const io = { out: () => true, err: (s: string) => (err.push(s), true) };
    expect(await main(["--executor", "claude-code", "--budget", "1000"], io)).toBe(2);
    expect(await main(["--live"], io)).toBe(2);
    expect(err.join("")).toMatch(/pass --live[\s\S]*--budget/);
  });

  it("reads usage from Claude Code and OpenAI-style output", () => {
    const claude = [
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "result", num_turns: 4, usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 200 } }),
    ].join("\n");
    expect(cliUsage(claude)).toEqual({ tokensIn: 1050, tokensOut: 200, cachedTokens: 900, turns: 4 });
    expect(cliUsage(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }))).toEqual({
      tokensIn: 10,
      tokensOut: 2,
      cachedTokens: 4,
      turns: 1,
    });
    expect(cliUsage("plain text\n")).toBeUndefined();
  });
});

describe("bench:tokens CLI", () => {
  it("exits 0 when the gate passes and 1 when it fails", async () => {
    let out = "";
    const io = { out: (s: string) => ((out += s), true), err: () => true };
    expect(await main(["--runs", "1", "--variants", "style:concise", "--gate", "style:concise"], io)).toBe(0);
    expect(out).toContain("Gate style:concise (mock): PASS");
    expect(await main(["--runs", "1", "--gate", "baseline"], io)).toBe(1);
  });
});

describe("context:packed (TE-03)", () => {
  const run = (tasks: BenchTask[], ...names: string[]) => runMock({ library, variants: [baseline, ...names.map((n) => resolveVariant(n))], runs: 2, tasks });
  const row = (report: BenchReport, name: string) => report.variants.find((v) => v.name === name)!;

  it("the lossless part (ships on) changes nothing on fixtures without exact repeats, and never costs tokens or success", () => {
    for (const tasks of [BENCH_TASKS, BENCH_TASKS_LARGE]) {
      const report = run(tasks, "context:packed");
      expect(row(report, "context:packed").promptTokens).toBe(row(report, "baseline").promptTokens);
      expect(row(report, "context:packed").successRate).toBe(row(report, "baseline").successRate);
      expect(gateVariant(report, "context:packed").pass).toBe(true);
    }
  });

  it("the large refactor fixture is a passing run whose repeats differ", () => {
    const refactor = BENCH_TASKS_LARGE.find((t) => t.id === "refactor")!;
    expect(refactor.variables.testOutput).not.toMatch(/FAIL|AssertionError/);
    expect(new Set(refactor.variables.testOutput!.split("\n\n")).size).toBeGreaterThan(10);
  });

  it("budget cuts (ship off) cut prompt tokens on the large fixtures with success unchanged", () => {
    const report = run(BENCH_TASKS_LARGE, "context:packed@2500", "context:packed@300");
    expect(row(report, "context:packed@2500").promptTokens).toBeLessThan(row(report, "baseline").promptTokens * 0.95);
    expect(row(report, "context:packed@2500").successRate).toBe(1);
    expect(row(report, "context:packed@300").successRate).toBe(1);
  });

  it("the mock seat is blind when a needed line is gone, so a blunt cut fails the review", () => {
    const blunt = runMock({ library, variants: [baseline, { ...variant("blunt", { contextScale: 0.2 }) }], runs: 1 });
    expect(row(blunt, "blunt").successRate).toBeLessThan(1);
  });

  it("rejects a malformed packed variant", () => {
    expect(() => resolveVariant("context:everything")).toThrow(/Unknown variant/);
  });
});

