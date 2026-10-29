import { randomBytes } from "node:crypto";
import { resolveVerificationCommands } from "../../config/detect-commands.js";
import type { AssentorConfig } from "../../config/schema.js";
import type { Seat } from "../../core/seats.js";
import type { EngineEventDraft } from "../../protocol/events.js";
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
  type ApplyStrategy,
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
 * 6. losers are discarded through the manager (`keepLosers` keeps them, failed
 *    ones marked so `cleanup({ keepFailed })` leaves them for inspection). The
 *    winner's worktree is left for the session's `manager.cleanup`.
 *
 * Cancel: `cancel(taskId)` aborts the round's signal; scheduler jobs stop and
 * their executors are cancelled, the judge negotiation is cancelled, and
 * `cancel` resolves when the round has settled. Every candidate gets exactly
 * one terminal seat event (`seat.done`, or `seat.error` on failure).
 */

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
  /** How the winner lands in the target. Default `squash`. */
  apply: ApplyStrategy;
  /** Keep losers' worktrees instead of discarding them. Default false. */
  keepLosers: boolean;
  /** Per-candidate deadline for the executor run. */
  candidateTimeoutMs?: number;
}

/** Validate a stage's `options`. Returns the parsed options or an error message. */
export function parseBestOfNOptions(
  options: Readonly<Record<string, unknown>>,
  candidateCount?: number,
): BestOfNOptions | string {
  const { n, apply = "squash", keepLosers = false, candidateTimeoutMs } = options;
  if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 2)) {
    return "best-of-n: options.n must be an integer of at least 2";
  }
  if (typeof n === "number" && candidateCount !== undefined && n > candidateCount) {
    return `best-of-n: options.n is ${n} but the team has only ${candidateCount} editing seats`;
  }
  if (candidateCount !== undefined && candidateCount < 2) {
    return "best-of-n needs at least two editing seats";
  }
  if (apply !== "merge" && apply !== "squash" && apply !== "patch") {
    return `best-of-n: options.apply must be "merge", "squash" or "patch"`;
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
  /** What judges see: gate results and the diff. */
  text?: string;
}

export function createBestOfNExecutor(deps: BestOfNDeps): Executor {
  const parsed = parseBestOfNOptions(deps.options ?? {}, deps.candidates.length);
  if (typeof parsed === "string") {
    throw new Error(parsed);
  }
  const options = parsed;
  const candidates = deps.candidates.slice(0, options.n);
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
    // The worktree path contains the seat id; judges must not see it.
    return { passed: result.passed, text: `Verification:\n${lines.join("\n")}`.split(worktree).join("<worktree>") };
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
      const gate = await gates(cand.path);
      const diff = await deps.manager.diff(key);
      if (diff.files.length === 0) {
        throw new Error("made no changes");
      }
      const shown =
        diff.diff.length > DIFF_LIMIT
          ? `${diff.diff.slice(0, DIFF_LIMIT)}\n[diff truncated: ${diff.diff.length - DIFF_LIMIT} more characters]`
          : diff.diff;
      cand.gatesPassed = gate.passed;
      cand.text = `${gate.text}\n\nFiles changed: ${diff.files.join(", ")}\n\n${shown}`;
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
  ): Promise<ExecutorResult> {
    round += 1;
    const tag = `r${round}${randomBytes(2).toString("hex")}`;
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
        await settleLosers();
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
        verdict = await judge(eligible, String(task.contract.goal), tag, controller);
      } catch (error) {
        await settleLosers();
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
        `best-of-n: ${winner.c.seat.displayName} won of ${cands.length} (${verdict.rationale}); applied by ${options.apply}`,
        ...(applied.warning ? [`warning: ${applied.warning}`] : []),
        ...failures().map((f) => `failed candidate ${f}`),
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
    run: (task) => execute(task.taskId, { contract: task.contract, prompt: task.prompt, ...(task.messages ? { messages: task.messages } : {}) }),
    // Every round starts fresh from the target's tip (which already holds the last winner), with the feedback in the prompt.
    continue: (input) =>
      execute(input.taskId, {
        contract: input.contract,
        prompt: input.nextPhaseDirective ?? input.contract.goal,
        messages: input.messages,
      }),
    async cancel(taskId) {
      const run = active.get(taskId);
      if (run) {
        run.controller.abort();
        await run.done.catch(() => undefined);
      }
    },
  };
}
