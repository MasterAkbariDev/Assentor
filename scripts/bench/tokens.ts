import { existsSync, readdirSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { parseAssentorConfig } from "#assentor/engine/config/load.js";
import { splitPromptFile } from "#assentor/engine/prompts/format.js";
import type { PromptLibrary } from "#assentor/engine/prompts/library.js";
import { templateVariables } from "#assentor/engine/prompts/template.js";
import { assembleSeatPrompt } from "#assentor/engine/prompts/assemble.js";
import { specialtyAddendum } from "#assentor/engine/review/specialty-prompts.js";
import { UsageLedger } from "#assentor/engine/usage/ledger.js";
import { estimateTokens } from "#assentor/engine/usage/tokens.js";
import { packPromptVariables } from "#assentor/engine/context/vars.js";
import { cliUsage } from "#assentor/engine/usage/cli-usage.js";
import {
  fenceSkill,
  MAX_SKILL_TOKENS_PER_SEAT,
  MAX_SKILLS_PER_SEAT,
  renderSkillsIndex,
  SKILL_PRESETS,
  validateSkillFrontMatter,
  type SkillDefinition,
} from "#assentor/engine/skills/index.js";
import { applyRunProfile, parseRunProfile, reviewNarrowing } from "#assentor/engine/config/profile.js";
import { BENCH_TASKS, type BenchTask, type TaskResult } from "./tasks.js";

/**
 * Token benchmark (TE-10). Measures NET tokens per successful task — every
 * call, follow-up turn and retry, plus any always-on text a variant adds to
 * every prompt — so a "token saver" that shortens replies but costs turns or
 * prompt size shows up as a loss. Dev-only: not part of the package.
 */

/** Hard cap for style + skills-index text sent with every seat prompt. */
export const ALWAYS_ON_CAP_TOKENS = 300;
/** Change (growth or shrink) of a role prompt's always-on part allowed before the snapshot must be updated. */
export const PROMPT_GROWTH_LIMIT = 0.05;
/** Largest drop in the cached share of prompt tokens (fraction points) a variant may cause. */
export const CACHE_DROP_LIMIT = 0.05;
/** A live variant must cut net tokens per success by this much. */
export const LIVE_MIN_SAVING = 0.1;
/** Follow-up turns a mock seat gets when its reply fails the task check. */
const MAX_FOLLOW_UPS = 1;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/** Scripted mock-seat behaviour, for proving what the gate catches. */
export interface MockScript {
  /** Fraction of the reply's prose kept; the final JSON block is always kept unless `dropHandoff`. */
  outputScale?: number;
  /** The reply loses its final JSON block (brevity broke the contract), so the task check fails. */
  dropHandoff?: boolean;
  /** Fraction of the task context (prompt variables and file reads) sent. */
  contextScale?: number;
  /** Extra tool turns before the answer (e.g. five small reads where one would do); needs a task with files. */
  extraTurns?: number;
  /** The prompt prefix changes per call, so nothing is served from the cache. */
  unstablePrefix?: boolean;
  /**
   * Seat prompt order (TE-05). `stable` (default, what the engine ships): `assembleSeatPrompt`'s
   * static → shared → per-seat delta. `legacy`: the per-seat text before the shared task, as review
   * prompts were before TE-05, so panel members share only the always-on text.
   */
  promptOrder?: "stable" | "legacy";
}

export interface Variant {
  name: string;
  /** Config overlay the variant stands for (applied by the features as they land). */
  overlay: { style?: string; profile?: string; skills?: string[]; context?: string };
  /** Text added to every seat prompt (style fragment, skills index, or a skill body). */
  alwaysOn: string;
  /**
   * Skills variants: what a seat of `role` gets. The index (plus style) is always on;
   * `loaded` holds the fenced bodies of the skills eligible for the role, present from
   * the first call (best case for cost: no extra `load_skill` turn).
   */
  perRole?: (role: string) => { alwaysOn: string; loaded: string };
  notes: string[];
  mock?: MockScript;
  /**
   * Task context goes through the engine's context packer (TE-03) before it is rendered into the role prompt:
   * the same `packPromptVariables` the engine uses. Without `budgetTokens` only the lossless part runs (identical
   * proposals / repeated test-output blocks once, which ships ON); with it, the budget cuts too (ships OFF).
   */
  packContext?: { budgetTokens?: number };
  /**
   * `context.summaries: auto` (TE-04): over-budget history is folded into digests by a (mock) summariser call
   * (`model`), or by the deterministic fallback with no summariser (`truncate`, the control that isolates the call's cost).
   */
  summaries?: "model" | "truncate";
  /** Today's Lead with `modes.lead.summarizer` set (its ad-hoc rolling summary). */
  leadSummarizer?: boolean;
  /** Members of a panel task that review under this variant (default all): the economy profile's one-or-all choice (TE-06). */
  panelFor?: (task: BenchTask) => number | undefined;
}

/** Everything a seat of `role` gets in front of its role prompt under `variant`. */
export function seatExtra(variant: Variant, role: string): string {
  const { alwaysOn, loaded } = variant.perRole?.(role) ?? { alwaysOn: variant.alwaysOn, loaded: "" };
  return joinParts(alwaysOn, loaded);
}

/** A style fragment as shipped (`prompts/builtin/style-<name>.md`); empty with a note when it does not exist. */
function styleText(style: string, root: string, notes: string[]): string {
  const file = path.join(root, "prompts", "builtin", `style-${style}.md`);
  if (!existsSync(file)) {
    if (style !== "normal") notes.push(`style-${style}.md is not built yet (TE-02): no effect`);
    return "";
  }
  const text = readFileSync(file, "utf8");
  return text.startsWith("---") ? splitPromptFile(text).body : text.trim();
}

/** Skill names with presets (`lean`) and `all` expanded. */
function expandNames(names: string[], root: string): string[] {
  const dir = path.join(root, "skills");
  const all = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(path.join(dir, d, "SKILL.md"))).sort() : [];
  return [...new Set(names.flatMap((name) => (name === "all" ? all : (SKILL_PRESETS[name] ?? [name]))))];
}

/** Built-in skills read from `skills/<name>/SKILL.md`; a note for each missing. */
function readSkills(names: string[], root: string, notes: string[]): SkillDefinition[] {
  const dir = path.join(root, "skills");
  return expandNames(names, root).flatMap((name) => {
    const file = path.join(dir, name, "SKILL.md");
    if (!existsSync(file)) {
      notes.push(`skill ${name} is not built yet (TE-07/08): no effect`);
      return [];
    }
    const { frontMatter, body } = splitPromptFile(readFileSync(file, "utf8"));
    const checked = validateSkillFrontMatter(frontMatter);
    if (!checked.ok) throw new Error(`${file}: ${checked.message}`);
    return [{ ...checked.value, body, layer: "builtin", file, tokens: estimateTokens(body) } as SkillDefinition];
  });
}

const eligibleFor = (skills: SkillDefinition[], role: string) => skills.filter((s) => !s.roles || s.roles.includes(role));

/** Style and skills of the default config (`output.style`, `skills.enabled` once TE-02/TE-07 add them). */
function defaults(): { style: string; skills: string[] } {
  const config = parseAssentorConfig({}) as { output?: { style?: string }; skills?: { enabled?: string[] } };
  return { style: config.output?.style ?? "normal", skills: config.skills?.enabled ?? [] };
}

const joinParts = (...parts: string[]) => parts.filter(Boolean).join("\n\n");

/**
 * What the default config sends with every seat prompt besides the role text:
 * its style fragment plus its skills index, read from the shipped files.
 * shortcut: rebuilt here from config + files because the engine has no seat-prompt
 * assembly for styles/skills yet; TE-02/TE-07 must expose theirs and this must call it.
 */
export function defaultAlwaysOn(root = REPO_ROOT): string {
  const { style, skills } = defaults();
  return joinParts(styleText(style, root, []), renderSkillsIndex(readSkills(skills, root, [])));
}

/** The evidence pack a review of `task` would carry: its diff and the files the diff changes. */
function fixturePack(task: BenchTask): { git: { isRepo: true; changedFiles: string[]; diff: string } } {
  const diff = task.variables.diff ?? "";
  const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!);
  return { git: { isRepo: true, changedFiles, diff } };
}

/** A variant with these skills (names or presets) on top of `style`: the index is always on, the bodies load per role. */
function skillsVariant(name: string, styleName: string, skillNames: string[], root: string, notes: string[]): Variant {
  const names = expandNames(skillNames, root);
  const skills = readSkills(names, root, notes);
  const style = styleText(styleName, root, []);
  const perRole = (role: string) => {
    const eligible = eligibleFor(skills, role);
    // A seat loads at most MAX_SKILLS_PER_SEAT skills / MAX_SKILL_TOKENS_PER_SEAT body tokens (first by name).
    let tokens = 0;
    const bodies = eligible.filter((s) => (tokens += s.tokens) <= MAX_SKILL_TOKENS_PER_SEAT).slice(0, MAX_SKILLS_PER_SEAT);
    return { alwaysOn: joinParts(style, renderSkillsIndex(eligible)), loaded: bodies.map(fenceSkill).join("\n\n") };
  };
  // The report's always-on size is the largest index any fixture role sees.
  const alwaysOn = BENCH_TASKS.map((t) => perRole(t.role).alwaysOn).reduce((a, b) => (b.length > a.length ? b : a), "");
  return { name, overlay: { skills: names }, alwaysOn, perRole, notes };
}

/**
 * `baseline`, `style:<name>`, `profile:<name>`, `cache:stable|legacy`, `skills:<a>+<b>` or `context:packed[@<tokens>]`, each on top
 * of the default config. Features that are not built yet resolve to a no-op
 * with a note, so the harness never depends on them.
 */
export function resolveVariant(name: string, root = REPO_ROOT): Variant {
  const [kind, value = ""] = name.split(":", 2) as [string, string?];
  const base = defaults();
  const notes: string[] = [];
  if (name === "baseline") {
    return { name, overlay: {}, alwaysOn: defaultAlwaysOn(root), notes };
  }
  if (kind === "style" && value) {
    return { name, overlay: { style: value }, alwaysOn: joinParts(styleText(value, root, notes), renderSkillsIndex(readSkills(base.skills, root, []))), notes };
  }
  if (kind === "profile" && value) {
    // The real resolver (TE-06): what the profile sets for style and skills is what the variant sends.
    const effective = applyRunProfile(parseAssentorConfig({}), { profile: parseRunProfile(value) });
    const skills = effective.skills.enabled;
    // The review task is a three-member panel: the real narrowing decides, from the task's changed files and diff, whether one member is enough.
    const narrows = Boolean(reviewNarrowing(effective, ""));
    notes.push(
      narrows
        ? "review panel: one member when classifyRisk finds no danger area in the task's changed files and diff, else all (the real narrowing, on the fixture diff)"
        : "review panel: unchanged (this profile does not narrow it)",
      "not modelled: negotiation rounds and Lead model routing (the bench has no negotiation or Lead seats)",
    );
    const panelFor = narrows ? (task: BenchTask) => (task.panel && reviewNarrowing(effective, task.variables.goal ?? "")?.({ evidencePack: fixturePack(task) }) ? 1 : undefined) : undefined;
    return {
      ...(skills.length ? skillsVariant(name, effective.output.style, skills, root, notes) : { name, alwaysOn: joinParts(styleText(effective.output.style, root, notes), renderSkillsIndex([])), notes }),
      overlay: { profile: value, style: effective.output.style, skills },
      ...(panelFor ? { panelFor } : {}),
    };
  }
  if (kind === "cache" && (value === "stable" || value === "legacy")) {
    notes.push(
      value === "stable"
        ? "TE-05 prompt order (static → shared → per-seat delta), the shipped default: the same as baseline"
        : "pre-TE-05 order: each panel member's specialty before the shared task, so members share only the always-on text",
      "mock panels assume a warm cache (same model, after the first member's call); live runs use the engine's order",
    );
    return { name, overlay: {}, alwaysOn: defaultAlwaysOn(root), notes, mock: { promptOrder: value } };
  }
  if (kind === "skills" && value) {
    return skillsVariant(name, base.style, [...base.skills, ...value.split("+")], root, notes);
  }
  if (kind === "context" && /^(summaries|truncate)(@\d+)?$/.test(value)) {
    const budgetTokens = value.includes("@") ? Number(value.split("@")[1]) : undefined;
    notes.push("acts on long conversations only (--fixtures long); single-seat tasks keep their CLI's own conversation");
    return { name, overlay: { context: value }, alwaysOn: defaultAlwaysOn(root), notes, packContext: budgetTokens ? { budgetTokens } : {}, summaries: value.startsWith("summaries") ? "model" : "truncate" };
  }
  if (name === "lead:summarizer") {
    notes.push("today's Lead with modes.lead.summarizer set; acts on the lead-long fixture only");
    return { name, overlay: {}, alwaysOn: defaultAlwaysOn(root), notes, leadSummarizer: true };
  }
  if (kind === "context" && /^packed(@\d+)?$/.test(value)) {
    const budgetTokens = value.includes("@") ? Number(value.split("@")[1]) : undefined;
    return { name, overlay: { context: value }, alwaysOn: defaultAlwaysOn(root), notes, packContext: budgetTokens ? { budgetTokens } : {} };
  }
  throw new Error(`Unknown variant "${name}" (use baseline, style:<name>, profile:<name>, cache:stable|legacy, skills:<a>+<b>, context:packed[@<tokens>], context:summaries[@<tokens>], context:truncate[@<tokens>] or lead:summarizer)`);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Every variable of a prompt empty (`{{#each}}` lists as []). */
function emptyVariables(library: PromptLibrary, id: string): Record<string, string | string[]> {
  const body = library.get(id)?.body ?? "";
  const lists = new Set([...body.matchAll(/\{\{#each\s+([^\s}]+)\s*\}\}/g)].map((m) => m[1]));
  return Object.fromEntries(templateVariables(body).map((name) => [name, lists.has(name) ? [] : ""]));
}

/** A role prompt rendered with the task's variables (each cut to `contextScale`); unset variables are empty. */
export function rolePrompt(library: PromptLibrary, task: BenchTask, contextScale = 1, pack?: Variant["packContext"]): string {
  const vars: Record<string, string | string[]> = emptyVariables(library, task.role);
  for (const [name, value] of Object.entries(task.variables)) {
    vars[name] = value.slice(0, Math.round(value.length * contextScale));
  }
  if (!pack) return library.render(task.role, vars);
  return library.render(task.role, packPromptVariables(vars, pack.budgetTokens ? { budgetTokens: pack.budgetTokens } : {}));
}

/** The always-on part of a prompt: its text with every variable empty, after `extra` (style + skills index). */
export function alwaysOnPrompt(library: PromptLibrary, id: string, extra = ""): string {
  const text = library.render(id, emptyVariables(library, id));
  return extra ? `${extra}\n\n${text}` : text;
}

export interface PromptSizes {
  /** Prompt id → always-on tokens (role + extra). */
  prompts: Record<string, number>;
  /** Tokens of the style + skills-index text alone. */
  extra: number;
}

export function promptSizes(library: PromptLibrary, extra = ""): PromptSizes {
  const prompts: Record<string, number> = {};
  for (const prompt of library.list()) {
    prompts[prompt.id] = estimateTokens(alwaysOnPrompt(library, prompt.id, extra));
  }
  return { prompts, extra: estimateTokens(extra) };
}

/** Problems with `current` against the pinned `snapshot`; empty means it passes. */
export function checkPromptSizes(current: PromptSizes, snapshot: PromptSizes): string[] {
  const problems: string[] = [];
  if (current.extra > ALWAYS_ON_CAP_TOKENS) {
    problems.push(`style + skills index is ${current.extra} tokens per seat prompt, over the ${ALWAYS_ON_CAP_TOKENS}-token cap`);
  }
  for (const [id, tokens] of Object.entries(current.prompts)) {
    const pinned = snapshot.prompts[id];
    if (pinned === undefined) {
      problems.push(`${id}: not in the snapshot (${tokens} tokens) — update it`);
    } else if (tokens > pinned * (1 + PROMPT_GROWTH_LIMIT)) {
      problems.push(`${id}: ${tokens} tokens, +${pct(tokens / pinned - 1)} over the snapshot (${pinned}); more than +${pct(PROMPT_GROWTH_LIMIT)}`);
    } else if (tokens < pinned * (1 - PROMPT_GROWTH_LIMIT)) {
      // A smaller prompt is good; pin it so later growth is measured from there.
      problems.push(`${id}: ${tokens} tokens, ${pct(tokens / pinned - 1)} under the snapshot (${pinned}) — update it to tighten the pin`);
    }
  }
  for (const id of Object.keys(snapshot.prompts)) {
    if (!(id in current.prompts)) problems.push(`${id}: in the snapshot but no longer a prompt — update it`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface Attempt {
  variant: string;
  run: number;
  task: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  calls: number;
  retries: number;
  success: boolean;
  estimated?: boolean;
}

export interface VariantResult {
  name: string;
  overlay: Variant["overlay"];
  notes: string[];
  alwaysOnTokens: number;
  /** Means per run (one run = every task once). */
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** cachedTokens / promptTokens: prompt tokens served from the cache. */
  cachedShare: number;
  calls: number;
  retries: number;
  successRate: number;
  /** (prompt + output tokens) / successful tasks, per run: mean, min, max. Infinity when nothing succeeded. */
  netPerSuccess: { mean: number; min: number; max: number };
}

export interface BenchReport {
  runner: "mock" | "live";
  runs: number;
  tasks: string[];
  model: string;
  variants: VariantResult[];
  /** Set when a live run stopped early. */
  stopped?: string;
}

const FILLER = "Checked the change against each criterion and the surrounding code. ";
const STEP = "Reading the next file the task names.";
const FOLLOW_UP = "\n\nYour reply is missing the required final JSON block. Reply again in the required format.";

/** Deterministic 0 ≤ u < 1 per task and run (the same for every variant, so noise cancels in comparisons). */
function noise(key: string): number {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  // Final mix, so keys that differ in one character land far apart.
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

function mockReply(task: BenchTask, script: MockScript, u: number, blind = false): string {
  if (blind) return "I could not find the code or output this task refers to in the context I was given.";
  const full = task.mock.output;
  const at = full.lastIndexOf("```json");
  const prose = at >= 0 ? full.slice(0, at) : full;
  const block = at >= 0 ? full.slice(at) : "";
  const scale = Math.min(1, script.outputScale ?? 1);
  // Replies vary by up to 15% of their prose between runs.
  const extra = FILLER.repeat(8).slice(0, Math.round(prose.length * 0.15 * u * scale));
  return prose.slice(0, Math.round(prose.length * scale)) + extra + (script.dropHandoff ? "" : block);
}

/** One task attempt with a scripted seat (each member of a panel task in turn); usage goes through the TE-01 ledger as `seat.tokens` events. */
function mockAttempt(library: PromptLibrary, task: BenchTask, variant: Variant, run: number, model: string): Attempt {
  const script = variant.mock ?? {};
  const sessionId = `${variant.name}/${task.id}/${run}`;
  const ledger = new UsageLedger(sessionId);
  let seq = 0;
  const emit = (type: "seat.tokens" | "seat.retry", data: Record<string, unknown>) =>
    ledger.add({ seq: ++seq, sessionId, seatId: task.role, at: "", type, data } as EngineEvent);

  const contextScale = script.contextScale ?? 1;
  const prefix = seatExtra(variant, task.role);
  const role = rolePrompt(library, task, contextScale, variant.packContext);
  // A seat that was not given what the task needs cannot answer it.
  const blind = !(task.needs ?? []).every((text) => role.includes(text) || prefix.includes(text));
  // A panel task runs once per member, each with its own specialty (the per-seat delta).
  const deltas = (task.panel?.map((specialty) => specialtyAddendum(specialty)) ?? [""]).slice(0, variant.panelFor?.(task));
  const bases = deltas.map((delta) =>
    script.promptOrder === "legacy"
      ? [prefix, delta, role].filter(Boolean).join("\n\n")
      : assembleSeatPrompt({ static: [prefix], shared: [role], delta: [delta] }).text,
  );
  // The seat reads each project file in its own tool turn; extra turns re-read the first one.
  const reads = Object.values(task.files);
  const extra = reads.length ? Array.from({ length: script.extraTurns ?? 0 }, () => reads[0]!) : [];
  const u = noise(`${task.id}:${run}`);
  const files = { ...task.files, ...task.mock.edits };
  /** The first member's first prompt: what a warm cache holds when the next member starts. */
  let first = "";
  let success = true;
  for (const base of bases) {
    let history = "";
    let previous = "";
    const call = (prompt: string, output: string) => {
      emit("seat.tokens", {
        tokensIn: estimateTokens(prompt, model),
        tokensOut: estimateTokens(output, model),
        // The previous call (prompt + reply) is a prefix of this one, so a cache serves it; a later
        // panel member's first call gets the prefix it shares with the first member's.
        cachedTokens: script.unstablePrefix ? 0 : estimateTokens(previous || commonPrefix(prompt, first), model),
      });
      previous = prompt + output;
      first ||= prompt;
    };

    for (const file of [...reads, ...extra]) {
      call(base + history, STEP);
      history += STEP + file.slice(0, Math.round(file.length * contextScale));
    }
    let output = mockReply(task, script, u, blind);
    call(base + history, output);
    history += output;
    let passed = task.check({ output, files });
    for (let followUp = 1; !passed && followUp <= MAX_FOLLOW_UPS; followUp += 1) {
      emit("seat.retry", { attempt: followUp + 1, maxAttempts: MAX_FOLLOW_UPS + 1, delayMs: 0, reason: "reply failed the task check" });
      output = mockReply(task, { ...script, dropHandoff: false }, u, blind);
      call(base + history + FOLLOW_UP, output);
      history += FOLLOW_UP + output;
      passed = task.check({ output, files });
    }
    success &&= passed;
  }

  const usage = ledger.snapshot();
  return {
    variant: variant.name,
    run,
    task: task.id,
    tokensIn: usage.total.tokensIn,
    tokensOut: usage.total.tokensOut,
    cachedTokens: usage.total.cachedTokens,
    calls: usage.total.calls,
    retries: usage.retries,
    success,
  };
}

export interface BenchOptions {
  library: PromptLibrary;
  variants: Variant[];
  runs: number;
  tasks?: BenchTask[];
  model?: string;
}

export function runMock(options: BenchOptions): BenchReport {
  const tasks = options.tasks ?? BENCH_TASKS;
  const model = options.model ?? "";
  const attempts: Attempt[] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    for (const task of tasks) {
      for (const variant of options.variants) attempts.push(mockAttempt(options.library, task, variant, run, model));
    }
  }
  return summarize("mock", options, tasks, model, attempts);
}

export interface LiveOptions extends BenchOptions {
  /** Must be true: live runs spend real tokens. */
  live: boolean;
  /** Stop once this many tokens are spent. Required. */
  budgetTokens: number;
  /** Executor provider (claude-code, codex, …). */
  executor: string;
  executorModel?: string;
}

/** Real CLI seats on temp copies of the fixture projects. Never in CI. */
export async function runLive(options: LiveOptions): Promise<BenchReport> {
  if (!options.live) throw new Error("Live runs spend real tokens: pass --live to confirm.");
  if (!(options.budgetTokens > 0)) throw new Error("Live runs need a token budget: --budget <tokens>.");
  if (process.env.CI) throw new Error("Live runs never run in CI.");
  const { createExecutor, buildContract } = await import("../../packages/cli/src/cli/commands.js");
  const { createId } = await import("#assentor/engine/core/ids.js");
  const tasks = options.tasks ?? BENCH_TASKS;
  const model = options.executorModel ?? options.executor;
  const attempts: Attempt[] = [];
  let spent = 0;
  let stopped: string | undefined;
  outer: for (let run = 1; run <= options.runs; run += 1) {
    for (const task of tasks) {
      for (const variant of options.variants) {
        if (spent >= options.budgetTokens) {
          stopped = `budget of ${options.budgetTokens} tokens spent after ${attempts.length} attempts`;
          break outer;
        }
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-bench-"));
        try {
          for (const [file, text] of Object.entries(task.files)) {
            await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
            await fs.writeFile(path.join(dir, file), text);
          }
          const extra = seatExtra(variant, task.role);
          const prompt = (extra ? `${extra}\n\n` : "") + rolePrompt(options.library, task, 1, variant.packContext);
          const executor = await createExecutor(options.executor, dir, { model: options.executorModel, timeoutMs: 15 * 60_000 });
          const result = await executor.run({ taskId: createId(), projectPath: dir, contract: buildContract(task.variables.goal ?? task.id), prompt });
          const output = result.summary;
          const reported = cliUsage(result.rawOutput ?? "");
          const usage = reported
            ? { tokensIn: reported.tokensIn, tokensOut: reported.tokensOut, cachedTokens: reported.cachedTokens, calls: reported.turns }
            : {
            tokensIn: estimateTokens(prompt, model),
            tokensOut: estimateTokens(result.rawOutput ?? output, model),
            cachedTokens: 0,
            calls: 1,
          };
          const files = await readTree(dir);
          const success = result.status === "completed" && task.check({ output, files } satisfies TaskResult);
          spent += usage.tokensIn + usage.tokensOut;
          attempts.push({ variant: variant.name, run, task: task.id, ...usage, retries: 0, success, ...(reported ? {} : { estimated: true }) });
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
    }
  }
  const report = summarize("live", options, tasks, model, attempts);
  for (const v of report.variants) {
    const estimated = attempts.filter((a) => a.variant === v.name && a.estimated).length;
    if (estimated > 0) {
      v.notes.push(`${estimated} attempts had no usage from the CLI; their tokens are estimated from text (inner tool turns not counted)`);
    }
  }
  return stopped ? { ...report, stopped } : report;
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full);
    if (entry.isFile() && !/(^|[\\/])(\.git|\.assentor|node_modules)([\\/]|$)/.test(rel)) {
      files[rel.split(path.sep).join("/")] = await fs.readFile(full, "utf8");
    }
  }
  return files;
}

export function summarize(runner: BenchReport["runner"], options: BenchOptions, tasks: Array<Pick<BenchTask, "id">>, model: string, attempts: Attempt[]): BenchReport {
  const variants = options.variants.map((variant): VariantResult => {
    const mine = attempts.filter((a) => a.variant === variant.name);
    const runs = [...new Set(mine.map((a) => a.run))];
    const perRun = runs.map((run) => mine.filter((a) => a.run === run));
    const mean = (pick: (a: Attempt) => number) =>
      perRun.length ? perRun.reduce((sum, list) => sum + list.reduce((s, a) => s + pick(a), 0), 0) / perRun.length : 0;
    const net = perRun.map((list) => {
      const successes = list.filter((a) => a.success).length;
      return successes ? list.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0) / successes : Infinity;
    });
    return {
      name: variant.name,
      overlay: variant.overlay,
      notes: [...variant.notes],
      alwaysOnTokens: estimateTokens(variant.alwaysOn, model),
      promptTokens: mean((a) => a.tokensIn),
      outputTokens: mean((a) => a.tokensOut),
      cachedTokens: mean((a) => a.cachedTokens),
      cachedShare: mean((a) => a.tokensIn) > 0 ? mean((a) => a.cachedTokens) / mean((a) => a.tokensIn) : 0,
      calls: mean((a) => a.calls),
      retries: mean((a) => a.retries),
      successRate: mine.length ? mine.filter((a) => a.success).length / mine.length : 0,
      netPerSuccess: {
        mean: net.length ? net.reduce((s, x) => s + x, 0) / net.length : Infinity,
        min: Math.min(...net),
        max: Math.max(...net),
      },
    };
  });
  return { runner, runs: options.runs, tasks: tasks.map((t) => t.id), model, variants };
}

// ---------------------------------------------------------------------------
// Gate and report
// ---------------------------------------------------------------------------

/**
 * Live: net tokens per success down ≥ 10%, no success-rate drop, always-on text within the cap.
 * Mock (structure only): always-on text within the cap, no success-rate drop, and net tokens per
 * success up by no more than the variant's own extra always-on text explains (its tokens × baseline
 * calls per success) — so extra turns, retries or longer prompts fail even when replies get shorter.
 * Both: the cached share of prompt tokens may not drop more than CACHE_DROP_LIMIT points.
 */
export function gateVariant(report: BenchReport, name: string): { pass: boolean; reasons: string[] } {
  const base = report.variants.find((v) => v.name === "baseline");
  const variant = report.variants.find((v) => v.name === name);
  if (!base || !variant || name === "baseline") {
    return { pass: false, reasons: [`the report needs a baseline and the variant "${name}"`] };
  }
  const reasons: string[] = [];
  if (variant.alwaysOnTokens > ALWAYS_ON_CAP_TOKENS) {
    reasons.push(`always-on text is ${variant.alwaysOnTokens} tokens per seat prompt, over the ${ALWAYS_ON_CAP_TOKENS}-token cap`);
  }
  if (variant.cachedShare < base.cachedShare - CACHE_DROP_LIMIT) {
    reasons.push(
      `cached share of prompt tokens fell to ${pct(variant.cachedShare)} from the baseline's ${pct(base.cachedShare)} (more than ${pct(CACHE_DROP_LIMIT)} points): the prompt prefix is no longer stable`,
    );
  }
  if (variant.successRate < base.successRate) {
    reasons.push(`success rate ${pct(variant.successRate)} is below the baseline's ${pct(base.successRate)}`);
  }
  const change = variant.netPerSuccess.mean / base.netPerSuccess.mean - 1;
  if (report.runner === "live") {
    if (!(change <= -LIVE_MIN_SAVING + 1e-9)) {
      reasons.push(`net tokens per successful task ${signed(change)} vs baseline; needs ${signed(-LIVE_MIN_SAVING)} or better`);
    }
  } else {
    // The variant may cost what its own extra always-on text costs on every call (+1 per call for the joining
    // newlines), nothing more. Note: the mock orders prompts with the engine's `assembleSeatPrompt` (TE-05);
    // TE-03/04 must still hook their packer and summaries into mockAttempt.
    const successes = base.successRate * report.tasks.length;
    const extraPerCall = Math.max(0, variant.alwaysOnTokens - base.alwaysOnTokens) + 1;
    const allowance = successes > 0 ? (extraPerCall * base.calls) / successes : 0;
    const growth = variant.netPerSuccess.mean - base.netPerSuccess.mean;
    if (!(growth <= allowance)) {
      reasons.push(
        `net tokens per successful task ${signed(change)} (+${Math.round(growth)}) vs baseline, more than its always-on text explains (+${Math.round(allowance)}): extra turns, retries or prompt growth`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

export function renderReport(report: BenchReport, gate?: { name: string; pass: boolean; reasons: string[] }): string {
  const base = report.variants.find((v) => v.name === "baseline");
  const n = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "∞");
  const lines = [
    `Runner: ${report.runner} · ${report.runs} runs × ${report.tasks.length} tasks (${report.tasks.join(", ")})${report.model ? ` · model ${report.model}` : ""}`,
    ...(report.stopped ? [`Stopped early: ${report.stopped}`] : []),
    "",
    "| variant | always-on | prompt | output | cached | calls | retries | success | net tokens / success (min–max) | vs baseline |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.variants.map((v) => {
      const change = base && v !== base ? signed(v.netPerSuccess.mean / base.netPerSuccess.mean - 1) : "—";
      return `| ${v.name} | ${v.alwaysOnTokens} | ${n(v.promptTokens)} | ${n(v.outputTokens)} | ${n(v.cachedTokens)} | ${v.calls.toFixed(1)} | ${v.retries.toFixed(1)} | ${pct(v.successRate)} | ${n(v.netPerSuccess.mean)} (${n(v.netPerSuccess.min)}–${n(v.netPerSuccess.max)}) | ${change} |`;
    }),
  ];
  const notes = report.variants.flatMap((v) => v.notes.map((note) => `- ${v.name}: ${note}`));
  if (notes.length) lines.push("", ...notes);
  if (gate) {
    lines.push("", `Gate ${gate.name} (${report.runner}): ${gate.pass ? "PASS" : "FAIL"}`, ...gate.reasons.map((r) => `- ${r}`));
  }
  return `${lines.join("\n")}\n`;
}

function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}

function signed(x: number): string {
  return Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${pct(x)}` : "∞";
}
