import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { parseAssentorConfig } from "#assentor/engine/config/load.js";
import { splitPromptFile } from "#assentor/engine/prompts/format.js";
import type { PromptLibrary } from "#assentor/engine/prompts/library.js";
import { templateVariables } from "#assentor/engine/prompts/template.js";
import { UsageLedger } from "#assentor/engine/usage/ledger.js";
import { estimateTokens } from "#assentor/engine/usage/tokens.js";
import { packPromptVariables } from "#assentor/engine/context/vars.js";
import { cliUsage } from "#assentor/engine/usage/cli-usage.js";
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
}

export interface Variant {
  name: string;
  /** Config overlay the variant stands for (applied by the features as they land). */
  overlay: { style?: string; profile?: string; skills?: string[]; context?: string };
  /** Text added to every seat prompt (style fragment, skills index, or a skill body). */
  alwaysOn: string;
  notes: string[];
  mock?: MockScript;
  /**
   * Task context goes through the engine's context packer (TE-03) before it is rendered into the role prompt:
   * the same `packPromptVariables` the engine uses. Without `budgetTokens` only the lossless part runs (identical
   * proposals / repeated test-output blocks once, which ships ON); with it, the budget cuts too (ships OFF).
   */
  packContext?: { budgetTokens?: number };
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

/** The skills index lines (name + description) for skills that exist; a note for each that does not. */
function skillsIndex(skills: string[], root: string, notes: string[]): string {
  return skills
    .flatMap((skill) => {
      const file = path.join(root, "skills", skill, "SKILL.md");
      if (!existsSync(file)) {
        notes.push(`skill ${skill} is not built yet (TE-07/08): no effect`);
        return [];
      }
      return [`- ${skill}: ${String(splitPromptFile(readFileSync(file, "utf8")).frontMatter.description ?? "")}`];
    })
    .join("\n");
}

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
  return joinParts(styleText(style, root, []), skillsIndex(skills, root, []));
}

/**
 * `baseline`, `style:<name>`, `profile:<name>`, `skills:<a>+<b>` or `context:packed[@<tokens>]`, each on top
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
    return { name, overlay: { style: value }, alwaysOn: joinParts(styleText(value, root, notes), skillsIndex(base.skills, root, [])), notes };
  }
  if (kind === "profile" && value) {
    notes.push("profiles are not built yet (TE-06): no effect in the mock; live runs need the feature");
    return { name, overlay: { profile: value }, alwaysOn: defaultAlwaysOn(root), notes };
  }
  if (kind === "skills" && value) {
    const skills = [...new Set([...base.skills, ...value.split("+")])];
    return { name, overlay: { skills }, alwaysOn: joinParts(styleText(base.style, root, []), skillsIndex(skills, root, notes)), notes };
  }
  if (kind === "context" && /^packed(@\d+)?$/.test(value)) {
    const budgetTokens = value.includes("@") ? Number(value.split("@")[1]) : undefined;
    return { name, overlay: { context: value }, alwaysOn: defaultAlwaysOn(root), notes, packContext: budgetTokens ? { budgetTokens } : {} };
  }
  throw new Error(`Unknown variant "${name}" (use baseline, style:<name>, profile:<name>, skills:<a>+<b> or context:packed[@<tokens>])`);
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

interface Attempt {
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

/** One task attempt with a scripted seat; usage goes through the TE-01 ledger as `seat.tokens` events. */
function mockAttempt(library: PromptLibrary, task: BenchTask, variant: Variant, run: number, model: string): Attempt {
  const script = variant.mock ?? {};
  const sessionId = `${variant.name}/${task.id}/${run}`;
  const ledger = new UsageLedger(sessionId);
  let seq = 0;
  const emit = (type: "seat.tokens" | "seat.retry", data: Record<string, unknown>) =>
    ledger.add({ seq: ++seq, sessionId, seatId: task.role, at: "", type, data } as EngineEvent);

  const contextScale = script.contextScale ?? 1;
  const base = (variant.alwaysOn ? `${variant.alwaysOn}\n\n` : "") + rolePrompt(library, task, contextScale, variant.packContext);
  // A seat that was not given what the task needs cannot answer it.
  const blind = !(task.needs ?? []).every((text) => base.includes(text));
  // The seat reads each project file in its own tool turn; extra turns re-read the first one.
  const reads = Object.values(task.files);
  const extra = reads.length ? Array.from({ length: script.extraTurns ?? 0 }, () => reads[0]!) : [];
  let history = "";
  let previous = "";
  const call = (prompt: string, output: string) => {
    emit("seat.tokens", {
      tokensIn: estimateTokens(prompt, model),
      tokensOut: estimateTokens(output, model),
      // The previous call (prompt + reply) is a prefix of this one, so a cache serves it.
      cachedTokens: previous && !script.unstablePrefix ? estimateTokens(previous, model) : 0,
    });
    previous = prompt + output;
  };

  for (const file of [...reads, ...extra]) {
    call(base + history, STEP);
    history += STEP + file.slice(0, Math.round(file.length * contextScale));
  }
  const u = noise(`${task.id}:${run}`);
  let output = mockReply(task, script, u, blind);
  call(base + history, output);
  history += output;
  const files = { ...task.files, ...task.mock.edits };
  let success = task.check({ output, files });
  for (let followUp = 1; !success && followUp <= MAX_FOLLOW_UPS; followUp += 1) {
    emit("seat.retry", { attempt: followUp + 1, maxAttempts: MAX_FOLLOW_UPS + 1, delayMs: 0, reason: "reply failed the task check" });
    output = mockReply(task, { ...script, dropHandoff: false }, u, blind);
    call(base + history + FOLLOW_UP, output);
    history += FOLLOW_UP + output;
    success = task.check({ output, files });
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
          const prompt = (variant.alwaysOn ? `${variant.alwaysOn}\n\n` : "") + rolePrompt(options.library, task, 1, variant.packContext);
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

function summarize(runner: BenchReport["runner"], options: BenchOptions, tasks: BenchTask[], model: string, attempts: Attempt[]): BenchReport {
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
    // newlines), nothing more. Note: the mock adds that text itself; it does not call the engine's prompt
    // assembly yet, so TE-03/04/05 must hook their packer, summaries and cache order into mockAttempt.
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
