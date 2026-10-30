import type { AssentorConfig } from "../config/schema.js";
import type { CascadeTier } from "../config/teams.js";
import { expandSeatSpecs, StageSpecSchema, type Seat, type StageSpec } from "../core/seats.js";
import type { EngineEventDraft } from "../protocol/events.js";
import { DEFAULT_CAPABILITIES } from "./capabilities.js";
import { classifyRisk, MAX_RISK_DIFF_CHARS, RISK_UNSCANNED, type RiskAssessment } from "./danger.js";
import type { ModeController, ModeControllerInput, ModeControllerResult } from "./registry.js";
import { costRank } from "./roster.js";

/**
 * Cascade mode (T02B-06): start on the cheap tier and escalate on failure or
 * risk. Design: docs/plans/modes.md §5.
 *
 * A dynamic mode: a plain controller loop (no LLM decides) over the built-in
 * execute ⇄ review stage runner, one tier at a time. Each tier is a pair of
 * teams from `modes.cascade.tiers`: `team` (edit seat implements) and
 * `reviewTeam` (read-only panel judges). Tiers are listed cheapest first.
 *
 * Escalation only goes up. A later tier continues from the files the earlier
 * tier left in the project (there is no rollback) and is told what went wrong.
 * - needs work: the tier's review still says NEEDS_WORK after its `maxRounds`
 *   (this includes failed verification gates, which become NEEDS_WORK) -> next tier;
 * - blocked: the tier's agent or review reports it cannot go on -> next tier;
 * - tier failure: the tier's seats threw (crash, auth, scheduler) -> next tier;
 *   a failure at the top tier fails the session;
 * - danger: `classifyRisk` (T02B-07, plus `modes.cascade.dangerAreas`) on the
 *   task text before anything runs, and on the changes since the start after
 *   every tier below the top, whatever its outcome (untracked files included).
 *   A danger task starts on the TOP tier (event trigger `danger_start`, no
 *   `fromTier`, not counted as an escalation); danger found later jumps
 *   straight to the top tier (trigger `danger`). `unscanned`, a truncated
 *   reasons list and a failure to read the changes all count as danger. Danger
 *   already in the working tree at the start is not blamed on a tier: only
 *   reasons that were not in the start's assessment count;
 * - a budget stop ends the session `budget_exceeded`; it never escalates.
 * Each tier gets fresh budgets (every `stages.execute` builds its own), so the
 * worst case is tiers x maxRounds rounds.
 * shortcut: no session-wide round or token cap, upgrade when the host needs one.
 * Not implemented: "low confidence" (stage results carry none) and a separate
 * "reviewer flags danger" signal (the diff check covers it).
 *
 * Never self-review (`cascadeProblems`): a tier's reviewer team is a different
 * team from its implementer team, read-only, and no cheaper than the implementer
 * by the seed capability costs (a seat the profiles do not know is not rank-checked).
 *
 * Autonomy: `autopilot` asks nothing. `supervised` asks before a danger start or
 * a danger escalation. `manual` asks before every tier starts. Until the
 * controller contract has an approval channel (T02B-02) the host passes
 * `extras.approve`; without it a step that needs approval ends the session
 * `blocked` (manual refuses before anything runs).
 */

const DEFAULT_MAX_ROUNDS = 2;

export interface CascadeExtras {
  /**
   * Asks the user before a step that needs approval (see the module doc).
   * Resolves true to go ahead.
   */
  approve?: (summary: string) => Promise<boolean>;
  /** Files and diff changed since the session started; default reads git in `deps.projectPath`. */
  readChanges?: () => Promise<{ files: string[]; diff: string }>;
  /**
   * The tier that finally succeeded. The same record is emitted as `cascade.tier_succeeded`
   * (the scoreboard, T02B-19, reads the log). A throwing callback is ignored.
   */
  onTierSucceeded?: (record: { tier: number; team: string; reviewTeam: string; escalations: number }) => void;
}

interface ResolvedTier {
  team: string;
  reviewTeam: string;
  maxRounds: number;
}

function tiersOf(config: AssentorConfig): CascadeTier[] {
  return config.modes.cascade?.tiers ?? [];
}

function resolveTiers(config: AssentorConfig): ResolvedTier[] {
  return tiersOf(config).map((t) => ({
    team: t.team,
    reviewTeam: t.reviewTeam ?? config.modes.review?.team ?? "",
    maxRounds: t.maxRounds ?? DEFAULT_MAX_ROUNDS,
  }));
}

function seatsOf(config: AssentorConfig, name: string): Seat[] | undefined {
  return Object.hasOwn(config.teams, name) ? expandSeatSpecs(config.teams[name]!.seats, { teamName: name }) : undefined;
}

/** Cost rank from the seed capability profiles; undefined when the seat is not profiled. */
function seatCost(seat: Seat): number | undefined {
  const profile =
    DEFAULT_CAPABILITIES.find((p) => p.key === `${seat.provider}/${seat.model}`) ??
    DEFAULT_CAPABILITIES.find((p) => p.key === `${seat.provider}/*`);
  return profile ? costRank(profile.cost) : undefined;
}

/** Problems with `modes.cascade`; `[]` when it can run. */
export function cascadeProblems(config: AssentorConfig): string[] {
  const tiers = resolveTiers(config);
  if (tiers.length < 2) return ["cascade mode needs modes.cascade.tiers with at least two tiers (cheapest first)"];
  const problems: string[] = [];
  tiers.forEach((tier, index) => {
    const label = `modes.cascade.tiers[${index}]`;
    if (!tier.reviewTeam) {
      problems.push(`${label}: no reviewTeam, and modes.review.team is not set`);
    }
    const implementers = seatsOf(config, tier.team);
    const reviewers = tier.reviewTeam ? seatsOf(config, tier.reviewTeam) : undefined;
    if (!implementers) problems.push(`${label}: unknown team "${tier.team}"`);
    else if (!implementers.some((s) => s.permissions === "edit")) problems.push(`${label}: team "${tier.team}" has no edit seat`);
    if (tier.reviewTeam && !reviewers) problems.push(`${label}: unknown reviewTeam "${tier.reviewTeam}"`);
    if (!implementers || !reviewers) return;
    if (tier.reviewTeam === tier.team) problems.push(`${label}: a tier cannot review its own team "${tier.team}"`);
    for (const seat of reviewers.filter((s) => s.permissions !== "read-only")) {
      problems.push(`${label}: reviewer seat "${seat.id}" must be read-only`);
    }
    const built = Math.max(-1, ...implementers.filter((s) => s.permissions === "edit").map((s) => seatCost(s) ?? -1));
    for (const seat of reviewers) {
      const cost = seatCost(seat);
      if (cost !== undefined && built >= 0 && cost < built) {
        problems.push(`${label}: reviewer seat "${seat.id}" is cheaper than the implementers of team "${tier.team}"; a reviewer must be at least as strong`);
      }
    }
  });
  return problems;
}

/** Run state the engine itself writes into the project; not a change the tier made. */
const ENGINE_STATE = /^\.assentor\/(tasks|sessions|worktrees)(\/|$)/;

/**
 * The default `readChanges`: git changes (committed, staged, unstaged, untracked) since the first call.
 * `git diff <head>` leaves out untracked files, so each gets a read-only `--no-index` diff against
 * /dev/null (exit 1 is how git says "differs"); the total stops at the classifier's cap, which then
 * reports `unscanned`. Nothing is staged or written.
 */
function gitChanges(cwd: string): () => Promise<{ files: string[]; diff: string }> {
  let head: string | null | undefined;
  return async () => {
    // Loaded on use: the registry (and the config schema) must stay free of node-only imports.
    const [{ LocalGitService }, { execFile }] = await Promise.all([import("../git/local.js"), import("node:child_process")]);
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile("git", args, { cwd, maxBuffer: 2 * MAX_RISK_DIFF_CHARS, encoding: "utf8" }, (error, stdout) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (!error || (code === 1 && args.includes("--no-index"))) resolve(stdout);
          else reject(error);
        }),
      );
    const git = new LocalGitService({ cwd });
    if (head === undefined) {
      head = null;
      head = (await git.status()).head;
    }
    const tracked = await git.changesSince(head);
    const untracked = (await run(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((f) => f && !ENGINE_STATE.test(f));
    let diff = tracked.diff;
    for (const file of untracked) {
      if (diff.length > MAX_RISK_DIFF_CHARS) break;
      const part = await run(["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file]);
      diff += `${diff && !diff.endsWith("\n") ? "\n" : ""}${part}`;
    }
    return { files: [...new Set([...tracked.files.map((f) => f.replace(/\/$/, "")), ...untracked])].filter((f) => !ENGINE_STATE.test(f)).sort(), diff };
  };
}

/** A note when a tier's reviewer shares a provider/model with one of its implementers, else undefined. */
function sharedSeats(config: AssentorConfig, tier: ResolvedTier): string | undefined {
  const impl = seatsOf(config, tier.team) ?? [];
  const same = (seatsOf(config, tier.reviewTeam) ?? []).find((r) => impl.some((i) => i.provider === r.provider && i.model === r.model));
  return same ? `reviewer seat "${same.id}" uses the same ${same.provider}/${same.model} as an implementer of team "${tier.team}"` : undefined;
}

class Stop extends Error {
  constructor(readonly result: ModeControllerResult) {
    super(result.reason ?? result.status);
  }
}

export function createCascadeController(input: ModeControllerInput, extras: CascadeExtras = {}): ModeController {
  return { run: () => runCascade(input, extras) };
}

async function runCascade(input: ModeControllerInput, extras: CascadeExtras): Promise<ModeControllerResult> {
  const { sessionId, stages, signal, goal, config, autonomy } = input;
  const problems = cascadeProblems(config);
  if (problems.length > 0) throw new Error(problems.join("; "));
  if (autonomy === "manual" && !extras.approve) {
    return { status: "blocked", reason: "manual autonomy needs an approval channel for cascade mode; use supervised or autopilot" };
  }
  const tiers = resolveTiers(config);
  const top = tiers.length - 1;
  const emit = (draft: EngineEventDraft) => {
    try {
      input.emit(draft);
    } catch {
      // Observability must never break a session.
    }
  };
  const readChanges = extras.readChanges ?? gitChanges(input.deps.projectPath);
  const riskOptions = { extraRules: config.modes.cascade?.dangerAreas ?? [], projectRoot: input.deps.projectPath };
  const cancelled = (): Stop => new Stop({ status: "blocked", reason: "cancelled" });
  const checkAbort = () => {
    if (signal.aborted) throw cancelled();
  };

  /** Resolves with the work, or rejects `Stop` when the session is cancelled while waiting. */
  const guard = async <T>(work: Promise<T>): Promise<T> => {
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      work.catch(() => undefined);
    }
  };

  const ask = async (summary: string): Promise<boolean> => {
    if (!extras.approve) return false;
    return guard(extras.approve(summary));
  };

  /** Danger of the changes since the start; an unreadable diff is `unscanned` danger. */
  const assessChanges = async (): Promise<RiskAssessment & { unreadable?: true }> => {
    try {
      const { files, diff } = await guard(readChanges());
      return classifyRisk({ paths: files, diff }, riskOptions);
    } catch (error) {
      if (error instanceof Stop) throw error;
      return {
        level: "danger",
        categories: [RISK_UNSCANNED],
        reasons: [`could not read the changes: ${error instanceof Error ? error.message : String(error)}`],
        unreadable: true,
      };
    }
  };

  let tier = 0;
  let escalations = 0;
  let attempt = 0;
  let feedback: string[] | undefined;
  const triggers: string[] = [];

  /** Why the next tier start needs approval beyond the autonomy floor (a danger move). */
  let pendingApproval: string | undefined;

  /**
   * Moves up to `to` (never down) and emits `cascade.escalated`; a danger move must be approved before
   * the tier starts. A danger start is not an escalation: no lower tier ran, so no `fromTier`.
   */
  const escalate = (to: number, trigger: string, reason: string, categories?: string[]) => {
    if (to <= tier) return;
    const start = trigger === "danger_start";
    emit({
      type: "cascade.escalated",
      sessionId,
      data: { ...(start ? {} : { fromTier: tier }), toTier: to, reason, trigger, ...(categories ? { categories } : {}) },
    });
    if (trigger === "danger" || start) pendingApproval = reason;
    tier = to;
    if (!start) {
      escalations += 1;
      triggers.push(trigger);
    }
  };

  try {
    checkAbort();
    const baseline = await assessChanges();
    const known = new Set(baseline.reasons);
    // Danger the start did not already have. A cut-off reasons list or unreadable changes cannot be compared.
    const newDanger = (after: RiskAssessment & { unreadable?: true }): string[] => {
      if (after.level !== "danger") return [];
      const added = after.unreadable || after.reasons.some((r) => r.startsWith("… and "))
        ? after.reasons
        : after.reasons.filter((r) => !known.has(r));
      return added;
    };
    /** After a tier below the top: new danger in its changes jumps to the top tier. True when it did. */
    const jumpOnDanger = async (): Promise<boolean> => {
      if (tier >= top) return false;
      const after = await assessChanges();
      const added = newDanger(after);
      if (added.length === 0) return false;
      const reason = `the changes touch a danger area (${after.categories.join(", ")}): ${added[0]}`;
      escalate(top, "danger", reason, after.categories);
      feedback = [`The previous tier's changes touch a danger area (${after.categories.join(", ")}). Review them with extra care and fix anything unsafe.`];
      return true;
    };

    for (const [index, t] of tiers.entries()) {
      const shared = sharedSeats(config, t);
      if (shared) emit({ type: "session.warning", sessionId, data: { kind: "cascade.self_review", message: `modes.cascade.tiers[${index}]: ${shared}` } });
    }

    checkAbort();
    const start = classifyRisk({ taskText: goal }, riskOptions);
    if (start.level === "danger") {
      const reason = `danger area (${start.categories.join(", ")}): ${start.reasons[0] ?? ""}`;
      escalate(top, "danger_start", reason, start.categories);
      feedback = [`This task touches a danger area (${start.categories.join(", ")}). Work carefully and keep the change minimal.`];
    }

    for (;;) {
      checkAbort();
      const current = tiers[tier]!;
      // manual asks before every tier; supervised only for a danger start or escalation; autopilot never.
      if (autonomy === "manual" || (autonomy === "supervised" && pendingApproval)) {
        const why = pendingApproval ?? `start tier ${tier + 1} of ${tiers.length}`;
        if (!(await ask(`cascade: ${why}. Run tier ${tier + 1} (${current.team})?`))) {
          throw new Stop({ status: "blocked", reason: `tier ${tier + 1} was not approved${extras.approve ? "" : " (no approval channel)"}: ${why}` });
        }
      }
      pendingApproval = undefined;
      attempt += 1;
      const stage = (id: string, kind: "execute" | "review", team: string, extra: Partial<StageSpec> = {}): StageSpec =>
        StageSpecSchema.parse({ id, kind, team, ...extra });
      const exec = stage(`cascade-t${tier + 1}`, "execute", current.team);
      const review = stage(`cascade-t${tier + 1}-review`, "review", current.reviewTeam, {
        strategy: "panel",
        options: { maxRounds: current.maxRounds },
      });

      let result;
      try {
        result = await stages.execute({
          sessionId,
          stage: exec,
          review,
          goal,
          ...(feedback ? { feedback } : {}),
          attempt,
          signal,
          emit: (draft) => emit({ ...draft, stageId: exec.id } as EngineEventDraft),
        });
      } catch (error) {
        checkAbort();
        const message = error instanceof Error ? error.message : String(error);
        if (tier === top) throw error;
        // Whatever the tier wrote before it died still gets the danger check.
        if (await jumpOnDanger()) continue;
        escalate(tier + 1, "tier_failed", `tier ${tier + 1} (${current.team}) failed: ${message}`);
        feedback = [`The previous tier failed before finishing: ${message}. Check the current state of the files first.`];
        continue;
      }
      checkAbort();

      if (result.outcome === "budget") return { status: "budget_exceeded", reason: result.summary };
      if (result.outcome === "pass") {
        if (await jumpOnDanger()) continue;
        const record = { tier, team: current.team, reviewTeam: current.reviewTeam, escalations };
        emit({ type: "cascade.tier_succeeded", sessionId, data: { tier, team: current.team, escalations, triggers: [...triggers] } });
        try {
          extras.onTierSucceeded?.(record);
        } catch {
          // A scoreboard hook must not fail a finished session.
        }
        return { status: "completed", reason: `accepted at tier ${tier + 1} of ${tiers.length} (${current.team})${escalations > 0 ? ` after ${escalations} escalation(s)` : ""}` };
      }

      // needs_work or blocked
      const trigger = result.outcome === "needs_work" ? "needs_work" : "blocked";
      if (tier === top) {
        return { status: "blocked", reason: `the top tier (${current.team}) ended ${trigger}: ${result.summary}` };
      }
      if (await jumpOnDanger()) continue;
      escalate(tier + 1, trigger, `tier ${tier + 1} (${current.team}) ended ${trigger}: ${result.summary}`);
      feedback = result.feedback?.length ? [...result.feedback] : [`The previous tier ended ${trigger}: ${result.summary}`];
    }
  } catch (error) {
    if (error instanceof Stop) return error.result;
    if (signal.aborted) return { status: "blocked", reason: "cancelled" };
    throw error;
  }
}
