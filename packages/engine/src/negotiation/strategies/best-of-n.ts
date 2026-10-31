import { randomBytes } from "node:crypto";
import { realpath } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveVerificationCommands } from "../../config/detect-commands.js";
import type { AssentorConfig } from "../../config/schema.js";
import type { Seat } from "#assentor/protocol/seats.js";
import type { EngineEventDraft } from "#assentor/protocol/events.js";
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorResult,
  ExecutorTask,
} from "../../providers/executors/types.js";
import { runVerificationGates, type RunVerificationCommand } from "../../review/verification-gates.js";
import type { SeatScheduler } from "../../seats/scheduler.js";
import {
  worktreeBranch,
  worktreeRelativePath,
  type SeatKey,
  type WorktreeManager,
} from "../../worktrees/index.js";
import { runNegotiation, type SeatStepRunner } from "../engine.js";
import {
  NegotiationCancelledError,
  type NegotiationContext,
  type NegotiationStrategy,
} from "../strategy.js";
import { voteStrategy } from "./vote.js";

/**
 * Best-of-N (T02-06): N editing seats each implement the task in their own
 * worktree, verification gates run per worktree, a judge panel votes over the
 * anonymized diffs, and only the winner is applied (`WorktreeManager.applyTo`).
 *
 * It is an `Executor`, because that is where the stage runner plugs it in:
 * `StageRunnerDeps.createExecutor(stage)` returns `createBestOfNExecutor(...)`
 * for an execute stage whose `strategy` is `"best-of-n"`; the Supervisor then
 * drives it like any executor (run → verification → review → continue). It is
 * deliberately not in the negotiation strategy registry: it needs executors and
 * worktrees, which `NegotiationContext` does not offer.
 *
 * Flow per `run`/`continue` (each is one fresh round from the target's tip):
 * 1. one worktree per candidate (`manager.create`), run through the seat
 *    scheduler (caps, budgets, `candidateTimeoutMs`), executor cwd = worktree;
 * 2. gates per worktree (same `runVerificationGates` as the Supervisor);
 * 3. a candidate is eligible when it completed, changed something, and (if any
 *    candidate passed the gates) passed the gates itself;
 * 4. one eligible candidate wins unopposed; several go to the existing `vote`
 *    strategy: candidates "propose" their diff (+ gate results) without a model
 *    call, judges rank (the judge team, or the eligible candidates when none is
 *    given; a seat in both may not rank its own diff first). Ties go to the
 *    earliest candidate (vote's rule);
 * 5. `applyTo(target, winner)`; a refusal or conflict fails the round, nothing
 *    is retried with a runner-up;
 * 6. losers are kept by default (`keepLosers: true`; failed ones are marked so
 *    `cleanup({ keepFailed })` leaves them): nothing is force-deleted behind the
 *    user's back. `manager.cleanup` never removes unmerged worktrees, so the host
 *    must call `discardBestOfNLosers` at session end. `keepLosers: false` opts
 *    in to discarding losers right after the round. The winner's worktree is
 *    left for the session's `manager.cleanup`.
 *
 * Candidates are shown to the judges in a seeded random order per round (the
 * seed is in the result summary), so position bias and vote ties do not always
 * favour seat 1.
 *
 * Host duties: install dependencies in each candidate worktree before the gates
 * run (`pnpm install --frozen-lockfile --prefer-offline`, not a node_modules
 * symlink); without it the gates fail or pass depending on the machine. Gate
 * commands run after the diff is taken, and files they create (coverage,
 * tsbuildinfo) are reported as a warning; keep them in .gitignore, because
 * `applyTo` commits whatever is in the worktree.
 *
 * Cancel: `cancel(taskId)` aborts the round's signal; scheduler jobs stop and
 * their executors are cancelled, the judge negotiation is cancelled, and
 * `cancel` resolves when the round has settled. Every candidate gets exactly
 * one terminal seat event (`seat.done`, or `seat.error` on failure). Cancel
 * this executor only at session end: the engine answers the round's abort with
 * the permanent `scheduler.cancelAll`. Finished candidates are kept; only
 * candidates cancelled mid-edit are discarded when `keepLosers` is false.
 */

/** Native realpath resolves Windows 8.3 short names, which the plain one keeps. */
const nativeRealpath = promisify(realpath.native);

export const BEST_OF_N_STRATEGY_ID = "best-of-n";

export interface BestOfNCandidate {
  /** An editing seat. */
  seat: Seat;
  /** The adapter that runs this seat; it is started with the worktree as its project path. */
  executor: Executor;
}

export interface BestOfNOptions {
  /** Use only the first n candidates (2 or more). Default: all. */
  n?: number;
  /**
   * How the winner lands in the target. Default `squash`. `patch` is refused: it
   * leaves the target dirty, so the next round's `manager.create` would fail.
   */
  apply: "merge" | "squash";
  /**
   * Keep losers' worktrees (default true; the host discards them at session end
   * with `discardBestOfNLosers`). `false` discards them through the manager
   * right after the round.
   */
  keepLosers: boolean;
  /** Per-candidate deadline for the executor run. */
  candidateTimeoutMs?: number;
}

/** Validate a stage's `options`. Returns the parsed options or an error message. */
export function parseBestOfNOptions(
  options: Readonly<Record<string, unknown>>,
  candidateCount?: number,
): BestOfNOptions | string {
  const { n, apply = "squash", keepLosers = true, candidateTimeoutMs } = options;
  if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 2)) {
    return "best-of-n: options.n must be an integer of at least 2";
  }
  if (typeof n === "number" && candidateCount !== undefined && n > candidateCount) {
    return `best-of-n: options.n is ${n} but the team has only ${candidateCount} editing seats`;
  }
  if (candidateCount !== undefined && candidateCount < 2) {
    return "best-of-n needs at least two editing seats";
  }
  if (apply !== "merge" && apply !== "squash") {
    return `best-of-n: options.apply must be "merge" or "squash" ("patch" would leave the target dirty for the next round)`;
  }
  if (typeof keepLosers !== "boolean") {
    return "best-of-n: options.keepLosers must be a boolean";
  }
  if (
    candidateTimeoutMs !== undefined &&
    (typeof candidateTimeoutMs !== "number" || !Number.isFinite(candidateTimeoutMs) || candidateTimeoutMs <= 0)
  ) {
    return "best-of-n: options.candidateTimeoutMs must be a positive number";
  }
  return {
    ...(n !== undefined ? { n: n as number } : {}),
    apply,
    keepLosers,
    ...(candidateTimeoutMs !== undefined ? { candidateTimeoutMs: candidateTimeoutMs as number } : {}),
  };
}

/**
 * Dependencies of `createBestOfNExecutor`. The executor may only be cancelled at
 * session end (see the module doc). With `target: "main"` the Supervisor's
 * `projectPath` must be the manager's top-level checkout (not a monorepo
 * subpackage); a mismatch fails the round before anything is created.
 */
export interface BestOfNDeps {
  manager: WorktreeManager;
  /** Worktree session id (a UUID, like the session's id). */
  sessionId: string;
  /** Project root; the vote transcript is persisted under it when given. */
  projectPath?: string;
  scheduler: SeatScheduler;
  /** Model call for the judges' `negotiate-rank` step (the engine's `SeatStepRunner`). */
  runStep: SeatStepRunner;
  candidates: readonly BestOfNCandidate[];
  /** Review seats that pick the winner. Default: the eligible candidates rank each other. */
  judges?: readonly Seat[];
  /** The stage's `options` (see `parseBestOfNOptions`). */
  options?: Readonly<Record<string, unknown>>;
  /**
   * Where the winner lands: `"main"` (the main checkout the manager was built
   * for; the default) or the task's own worktree seat, whose branch is also the
   * base the candidates start from.
   */
  target?: "main" | SeatKey;
  /** Verification gates per worktree; omitted or `enabled: false` skips them, like the Supervisor. */
  verification?: AssentorConfig["verification"];
  runVerificationCommand?: RunVerificationCommand;
  /** Negotiation run ids are `<prefix>-<round tag>`; give each stage its own (≤ 40 chars). Default `best-of-n`. */
  runIdPrefix?: string;
  askTimeoutMs?: number;
  /** Per-round seed (uint32) for the candidate order. Default: 4 random bytes. Tests pin it. */
  roundSeed?: () => number;
  /** Seat and negotiation events; must not throw. */
  emit?: (draft: EngineEventDraft) => void;
}

/** Marks vote asks that are skipped on purpose (a judge has no diff to propose; a candidate is no judge). */
const SKIP = "best-of-n: not applicable";
const DIFF_LIMIT = 40_000;

interface Candidate {
  c: BestOfNCandidate;
  key: SeatKey;
  path?: string;
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  result?: ExecutorResult;
  gatesPassed?: boolean;
  /** Files the gates created in the worktree. */
  warning?: string;
  /** What judges see: gate results and the diff. */
  text?: string;
}

/** Seat ids of best-of-n worktrees end in `.bon-r<round><8 hex>`; no other strategy or user seat id matches. */
const ROUND_TAG = /\.bon-r\d+[0-9a-f]{8}$/;

/**
 * Session-end cleanup for kept losers: discards (through the manager) the
 * best-of-n worktrees of the session that were neither applied nor, with
 * `keepFailed` (the default, as in `manager.cleanup`), marked failed. Failed
 * ones are the ones a round kept on purpose: a winner whose `applyTo` was
 * refused (the only copy of the winning work) and candidates that finished
 * before a cancel or budget stop. Winners that landed are removed by
 * `manager.cleanup`. Pass `keepFailed: false` only to throw all of it away.
 */
export async function discardBestOfNLosers(
  manager: WorktreeManager,
  sessionId: string,
  options: { keepFailed?: boolean } = {},
): Promise<SeatKey[]> {
  const keepFailed = options.keepFailed ?? true;
  const discarded: SeatKey[] = [];
  for (const info of await manager.list(sessionId)) {
    if (
      ROUND_TAG.test(info.seatId) &&
      info.outcome !== "applied" &&
      !(keepFailed && info.outcome === "failed")
    ) {
      await manager.discard({ sessionId, seatId: info.seatId }, { force: true });
      discarded.push({ sessionId, seatId: info.seatId });
    }
  }
  return discarded;
}

/** Replace a worktree's absolute path and its repository-relative form (both slash styles) by `<worktree>`. */
function redact(text: string, absolute: string, key: SeatKey): string {
  const relative = worktreeRelativePath(key);
  return [absolute, relative, relative.replaceAll("/", "\\")].reduce((t, p) => t.split(p).join("<worktree>"), text);
}

/** Deterministic Fisher-Yates with a mulberry32 stream; the same seed gives the same order. */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function createBestOfNExecutor(deps: BestOfNDeps): Executor {
  const parsed = parseBestOfNOptions(deps.options ?? {}, deps.candidates.length);
  if (typeof parsed === "string") {
    throw new Error(parsed);
  }
  const options = parsed;
  const candidates = deps.candidates.slice(0, options.n);
  const ids = candidates.map((c) => c.seat.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`best-of-n: candidate seat ids must be unique (got ${ids.join(", ")})`);
  }
  const target = deps.target ?? "main";
  const baseRef = target === "main" ? "HEAD" : worktreeBranch(target);
  const prefix = deps.runIdPrefix ?? BEST_OF_N_STRATEGY_ID;
  const active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  let round = 0;

  const emit = (draft: EngineEventDraft) => {
    try {
      deps.emit?.(draft);
    } catch {
      // Observability must never break the run.
    }
  };
  const seatEvent = (seatId: string, type: "seat.status" | "seat.done" | "seat.error", data: Record<string, unknown>) =>
    emit({ type, sessionId: deps.sessionId, seatId, data } as EngineEventDraft);

  async function gates(worktree: string): Promise<{ passed: boolean; text: string }> {
    const verification = deps.verification;
    if (!verification || verification.enabled === false) {
      return { passed: true, text: "Verification: not run" };
    }
    const commands = await resolveVerificationCommands(worktree, verification.commands);
    const result = await runVerificationGates({
      projectPath: worktree,
      commands,
      skipReviewOnFailure: verification.skipReviewOnFailure,
      ...(deps.runVerificationCommand ? { runCommand: deps.runVerificationCommand } : {}),
    });
    const lines = result.runs.map((run) =>
      run.status === "FAILED"
        ? `${run.slot}: FAILED (exit ${run.exitCode ?? "?"})\n${(run.output ?? "").slice(0, 500)}`
        : `${run.slot}: ${run.status}`,
    );
    return { passed: result.passed, text: `Verification:\n${lines.join("\n")}` };
  }

  async function runCandidate(
    cand: Candidate,
    base: Omit<ExecutorTask, "taskId" | "projectPath">,
    taskId: string,
    controller: AbortController,
  ): Promise<void> {
    const { c, key } = cand;
    try {
      seatEvent(c.seat.id, "seat.status", { status: "editing", detail: BEST_OF_N_STRATEGY_ID });
      cand.path = (await deps.manager.create(key, baseRef)).path;
      const candidateTaskId = `${taskId}.${c.seat.id}`;
      const outcome = await deps.scheduler.run(
        c.seat,
        async (job) => {
          const stop = () =>
            void Promise.resolve()
              .then(() => c.executor.cancel(candidateTaskId))
              .catch(() => undefined);
          if (job.signal.aborted) stop();
          else job.signal.addEventListener("abort", stop, { once: true });
          try {
            return await c.executor.run({ ...base, taskId: candidateTaskId, projectPath: cand.path! });
          } finally {
            job.signal.removeEventListener("abort", stop);
          }
        },
        {
          signal: controller.signal,
          maxAttempts: 1, // a retry would rerun the executor on a half-edited worktree
          ...(options.candidateTimeoutMs ? { timeoutMs: options.candidateTimeoutMs } : {}),
        },
      );
      if (!outcome.ok) {
        if (outcome.scope === "session") controller.abort(); // cancel or session budget: stop the other candidates too
        cand.cancelled = outcome.reason === "cancelled";
        throw new Error(`${outcome.reason}: ${outcome.error}`);
      }
      cand.result = outcome.value;
      if (controller.signal.aborted) {
        cand.cancelled = true;
        throw new Error("cancelled");
      }
      if (outcome.value.status !== "completed") {
        throw new Error(`${outcome.value.status}: ${outcome.value.error ?? outcome.value.summary}`);
      }
      // The diff is taken before the gates run, so gate artifacts never reach the judges.
      const diff = await deps.manager.diff(key);
      if (diff.files.length === 0) {
        throw new Error("made no changes");
      }
      const gate = await gates(cand.path);
      if (deps.verification && deps.verification.enabled !== false) {
        const grown = (await deps.manager.diff(key)).files.filter((f) => !diff.files.includes(f));
        if (grown.length > 0) {
          cand.warning = `the gates created ${grown.join(", ")} (applyTo would commit them; ignore them in .gitignore)`;
        }
      }
      const shown =
        diff.diff.length > DIFF_LIMIT
          ? `${diff.diff.slice(0, DIFF_LIMIT)}\n[diff truncated: ${diff.diff.length - DIFF_LIMIT} more characters]`
          : diff.diff;
      cand.gatesPassed = gate.passed;
      // The worktree path contains the seat id; judges must not see it in the gate output or the diff.
      cand.text = redact(`${gate.text}\n\nFiles changed: ${diff.files.join(", ")}\n\n${shown}`, cand.path, key);
      cand.ok = true;
      seatEvent(c.seat.id, "seat.done", { ok: true, summary: "candidate complete" });
    } catch (error) {
      cand.ok = false;
      cand.error = error instanceof Error ? error.message : String(error);
      if (cand.cancelled || controller.signal.aborted) {
        cand.cancelled = true;
        seatEvent(c.seat.id, "seat.done", { ok: false, summary: "cancelled" });
      } else {
        seatEvent(c.seat.id, "seat.error", { message: cand.error });
      }
    }
  }

  /** Vote over the eligible candidates' diffs with the existing vote strategy. Returns the winner, or why there is none. */
  async function judge(
    eligible: Candidate[],
    goal: string,
    tag: string,
    controller: AbortController,
  ): Promise<{ winner?: Candidate; rationale: string }> {
    if (eligible.length === 1) {
      return { winner: eligible[0], rationale: "only one eligible candidate" };
    }
    const texts = new Map(eligible.map((cand) => [cand.c.seat.id, cand.text!]));
    const judges = deps.judges?.length ? deps.judges : eligible.map((cand) => cand.c.seat);
    const judgeIds = new Set(judges.map((seat) => seat.id));
    const voters = [
      ...eligible.map((cand) => cand.c.seat),
      ...judges.filter((seat) => !texts.has(seat.id)),
    ];
    const skipped = (seatId: string) => ({ ok: false as const, seatId, error: SKIP });
    const judgeVote: NegotiationStrategy = {
      id: voteStrategy.id,
      validate: voteStrategy.validate,
      async run(ctx) {
        const view: NegotiationContext = {
          ...ctx,
          askSeat: (async (seatId, step, vars, askOptions) => {
            if (step === "negotiate-propose") {
              const text = texts.get(seatId);
              return text === undefined
                ? skipped(seatId)
                : { ok: true, seatId, data: { proposal: text } };
            }
            if (step === "negotiate-rank" && !judgeIds.has(seatId)) {
              return skipped(seatId);
            }
            return ctx.askSeat(seatId, step, vars, askOptions);
          }) as NegotiationContext["askSeat"],
        };
        const result = await voteStrategy.run(view);
        return { ...result, dissent: result.dissent.filter((d) => d.reason !== SKIP) };
      },
    };

    let preferred: string | undefined;
    try {
      const { result } = await runNegotiation({
        sessionId: deps.sessionId,
        ...(deps.projectPath ? { projectPath: deps.projectPath } : {}),
        runId: `${prefix}-${tag}`,
        strategy: judgeVote,
        goal,
        seats: voters,
        scheduler: deps.scheduler,
        runStep: deps.runStep,
        signal: controller.signal,
        emit: (draft) => {
          if (draft.type === "negotiation.consensus") {
            preferred = (draft.data as { preferred?: string }).preferred;
          }
          emit(draft);
        },
        ...(deps.askTimeoutMs ? { askTimeoutMs: deps.askTimeoutMs } : {}),
      });
      const seatId = result.proposals.find((p) => p.label === preferred)?.seatId;
      const winner = eligible.find((cand) => cand.c.seat.id === seatId);
      return { ...(winner ? { winner } : {}), rationale: result.rationale };
    } catch (error) {
      if (error instanceof NegotiationCancelledError) throw error;
      return { rationale: `judging failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function execute(
    taskId: string,
    task: Omit<ExecutorTask, "taskId" | "projectPath">,
    projectPath: string,
  ): Promise<ExecutorResult> {
    if (target === "main") {
      const top = await nativeRealpath(await deps.manager.topLevel());
      const given = await nativeRealpath(projectPath).catch(() => path.resolve(projectPath));
      const same = process.platform === "win32" ? given.toLowerCase() === top.toLowerCase() : given === top;
      if (!same) {
        return {
          status: "failed",
          summary: `best-of-n: the project path ${given} is not the repository top level ${top} (a monorepo subpackage?); worktrees are created per repository`,
        };
      }
    }
    round += 1;
    const seed = deps.roundSeed ? deps.roundSeed() >>> 0 : randomBytes(4).readUInt32BE();
    const seedHex = seed.toString(16).padStart(8, "0");
    const tag = `bon-r${round}${seedHex}`;
    const controller = new AbortController();
    const cands: Candidate[] = candidates.map((c) => ({
      c,
      key: { sessionId: deps.sessionId, seatId: `${c.seat.id}.${tag}` },
      ok: false,
    }));
    const warnings: string[] = [];

    /**
     * Through the manager, discard (or, with keepLosers, mark failed) every candidate
     * except `keep`. Kept ones hold work worth inspecting or retrying by hand.
     */
    const settleLosers = async (keep: readonly Candidate[] = []) => {
      for (const cand of cands.filter((x) => !keep.includes(x) && x.path)) {
        try {
          if (options.keepLosers) {
            if (!cand.ok) await deps.manager.markFailed(cand.key);
          } else {
            await deps.manager.discard(cand.key, { force: true });
          }
        } catch (error) {
          warnings.push(`could not clean up ${cand.c.seat.displayName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    /** Cancel or budget stop: finished candidates are kept (marked failed), only the rest follows `keepLosers`. */
    const keepFinished = async () => {
      const good = cands.filter((x) => x.ok);
      await settleLosers(good);
      for (const cand of good) {
        await deps.manager.markFailed(cand.key).catch(() => undefined);
      }
    };
    const failures = () => cands.filter((x) => !x.ok).map((x) => `${x.c.seat.displayName}: ${x.error}`);
    const fail = (summary: string): ExecutorResult => ({
      status: "failed",
      summary,
      error: [...failures(), ...warnings].join("; "),
    });

    /** The winner could not land: keep its worktree (marked failed) so the work is not lost. */
    const keepWinner = async (winner: Candidate, why: string): Promise<ExecutorResult> => {
      await settleLosers([winner]);
      await deps.manager.markFailed(winner.key).catch(() => undefined);
      return fail(`best-of-n: ${why}; the winner's worktree ${winner.path} was kept`);
    };

    const done = (async (): Promise<ExecutorResult> => {
      await Promise.all(cands.map((cand) => runCandidate(cand, task, taskId, controller)));
      const cancelled = (): ExecutorResult => ({ status: "cancelled", summary: "best-of-n cancelled" });
      if (controller.signal.aborted) {
        await keepFinished();
        return cancelled();
      }

      const passing = cands.filter((x) => x.ok && x.gatesPassed);
      const eligible = passing.length > 0 ? passing : cands.filter((x) => x.ok);
      if (eligible.length === 0) {
        await settleLosers();
        return fail(`best-of-n: all ${cands.length} candidates failed`);
      }

      let verdict: Awaited<ReturnType<typeof judge>>;
      try {
        verdict = await judge(shuffleWithSeed(eligible, seed), String(task.contract.goal), tag, controller);
      } catch (error) {
        await keepFinished();
        if (error instanceof NegotiationCancelledError && error.reason === "cancelled") return cancelled();
        return fail(`best-of-n: ${error instanceof Error ? error.message : String(error)}`);
      }
      const winner = verdict.winner;
      if (!winner) {
        await settleLosers(eligible); // judging failed, not the work: keep every good candidate
        return fail(`best-of-n: no winner (${verdict.rationale}); eligible worktrees kept`);
      }

      let applied;
      try {
        applied = await deps.manager.applyTo(target, winner.key, {
          strategy: options.apply,
          message: `assentor: best-of-n winner (${options.apply})`,
        });
      } catch (error) {
        return keepWinner(winner, `applying the winner was refused: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!applied.ok) {
        return keepWinner(winner, `applying the winner conflicts in ${applied.conflicts.join(", ") || "the target"}: ${applied.message}`);
      }
      await settleLosers([winner]);

      const won = winner.result!;
      const note = [
        `best-of-n: ${winner.c.seat.displayName} won of ${cands.length} (${verdict.rationale}); applied by ${options.apply}; order seed ${seedHex}`,
        ...(applied.warning ? [`warning: ${applied.warning}`] : []),
        ...failures().map((f) => `failed candidate ${f}`),
        ...cands.filter((x) => x.warning).map((x) => `warning: ${x.c.seat.displayName}: ${x.warning}`),
        ...warnings,
      ].join("\n");
      return {
        status: "completed",
        summary: `${note}\n${won.summary}`,
        ...(won.sessionId ? { sessionId: won.sessionId } : {}),
        ...(won.messages ? { messages: won.messages } : {}),
        ...(won.rawOutput ? { rawOutput: won.rawOutput } : {}),
      };
    })();

    active.set(taskId, { controller, done });
    try {
      return await done;
    } finally {
      active.delete(taskId);
    }
  }

  return {
    name: BEST_OF_N_STRATEGY_ID,
    capabilities: (): ExecutorCapabilities => ({
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: false,
      supportsScreenshots: false,
    }),
    run: (task) =>
      execute(task.taskId, { contract: task.contract, prompt: task.prompt, ...(task.messages ? { messages: task.messages } : {}) }, task.projectPath),
    // Every round starts fresh from the target's tip (which already holds the last winner), with the feedback in the prompt.
    continue: (input) =>
      execute(
        input.taskId,
        { contract: input.contract, prompt: input.nextPhaseDirective ?? input.contract.goal, messages: input.messages },
        input.projectPath,
      ),
    async cancel(taskId) {
      const run = active.get(taskId);
      if (run) {
        run.controller.abort();
        await run.done.catch(() => undefined);
      }
    },
  };
}
