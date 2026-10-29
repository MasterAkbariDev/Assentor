import type { ReviewerFinding } from "../agents/routed-reviewer.js";
import { createBudgets } from "../core/budgets.js";
import type { Seat, StageSpec } from "../core/seats.js";
import { createEmptyContract, type TaskContract } from "../core/task-contract.js";
import { ReviewStatus, type BudgetLimits } from "../core/types.js";
import { runNegotiation, type SeatStepRunner } from "../negotiation/engine.js";
import { debateStrategy } from "../negotiation/strategies/debate.js";
import { getStrategy, registerBuiltinStrategies } from "../negotiation/strategies/index.js";
import { NegotiationCancelledError } from "../negotiation/strategy.js";
import type { EngineEventDraft } from "../protocol/events.js";
import { makeReviewResult, type ReviewResult } from "../protocol/review-result.js";
import type { Executor } from "../providers/executors/types.js";
import type { Reviewer } from "../providers/reviewers/types.js";
import type { ReviewCoordinatorOptions } from "../review/coordinator.js";
import type { SeatScheduler } from "../seats/scheduler.js";
import type { StageResult, StageRunners } from "./session-runner.js";
import { TaskState } from "./state-machine.js";
import { Supervisor, type SupervisorConfig } from "./supervisor.js";

/**
 * Built-in stage runners for the stage graph (task T02-09):
 * - `plan` / `negotiate`: `runNegotiation` (T02-03) with the stage's strategy
 *   and team; its decision becomes the plan of later stages.
 * - `execute` + its `review` stage: one `Supervisor` run (the execute ⇄ review
 *   loop), with the plan in the contract goal. The review stage's
 *   `options.maxRounds` caps Supervisor rounds; when the rounds run out while
 *   the review still says NEEDS_WORK the stage ends `needs_work` (the graph
 *   then follows `onNeedsWork`). `options.tiebreak: "negotiate"` gives the
 *   reviewer a Debate among the review team's seats as `onDisagreement`.
 *
 * Cancel: negotiations stop through the scheduler (session signal); the
 * Supervisor gets `requestCancel()` plus `executor.cancel(taskId)`, and the
 * runner waits for it to settle.
 */

export type PanelTiebreakOptions = Pick<ReviewCoordinatorOptions, "tiebreak" | "onDisagreement">;

export interface StageRunnerDeps {
  projectPath: string;
  /** One scheduler per session; its lifetime must cover the session signal. */
  scheduler: SeatScheduler;
  /**
   * Model call for negotiation steps. It renders the prompt whose id equals
   * the step name (`negotiate-propose`, …, `moderator`, `judge`; T03-03)
   * with the vars it is given. The stage graph never supplies one itself.
   */
  runStep: SeatStepRunner;
  /** Seats of a stage's team. Throw for an unknown team. */
  seatsFor(stage: StageSpec): readonly Seat[];
  /** Executor for an execute stage; `stage.strategy`/`options` say how (e.g. best-of-n, T02-06). */
  createExecutor(stage: StageSpec): Executor;
  /**
   * Reviewer for a review stage. Spread `tiebreak` into the `PanelReviewer`
   * options: it is `{ tiebreak: "negotiate", onDisagreement }` when the stage
   * asks for a negotiated tiebreak, else `{}`.
   */
  createReviewer(stage: StageSpec, tiebreak: PanelTiebreakOptions): Reviewer;
  /** Base contract for execute stages. Default: `createEmptyContract(goal)`. */
  contract?: TaskContract;
  /** Supervisor budget limits; the review stage's `options.maxRounds` overrides `maxRounds`. */
  budgetLimits?: Partial<BudgetLimits>;
  /** Passed to every Supervisor (verification, events, autopilot, …). */
  supervisor?: Omit<
    SupervisorConfig,
    "projectPath" | "contract" | "executor" | "reviewer" | "budgets" | "taskId" | "conversationId" | "store" | "resumeFrom"
  >;
  /** Per-ask deadline for negotiation steps. */
  askTimeoutMs?: number;
}

const MAX_REVIEW_ROUNDS = 50;

export function createStageRunners(deps: StageRunnerDeps): StageRunners {
  registerBuiltinStrategies();

  const seats = (stage: StageSpec): readonly Seat[] | string => {
    try {
      const found = deps.seatsFor(stage);
      return found.length > 0 ? found : `team "${stage.team ?? "(none)"}" has no seats`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  return {
    validate(stage) {
      if (stage.kind === "plan" || stage.kind === "negotiate") {
        const strategy = stage.strategy ? getStrategy(stage.strategy) : undefined;
        if (!strategy) {
          return stage.strategy ? `unknown negotiation strategy "${stage.strategy}"` : "a negotiation stage needs a strategy";
        }
        const team = seats(stage);
        return typeof team === "string" ? team : strategy.validate(team, stage.options);
      }
      if (stage.kind === "review") {
        const { maxRounds, tiebreak } = stage.options;
        if (
          maxRounds !== undefined &&
          (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_REVIEW_ROUNDS)
        ) {
          return `options.maxRounds must be an integer from 1 to ${MAX_REVIEW_ROUNDS}`;
        }
        if (tiebreak !== undefined && tiebreak !== "negotiate" && tiebreak !== "adjudicator") {
          return `options.tiebreak must be "negotiate" or "adjudicator"`;
        }
        if (tiebreak === "negotiate") {
          const team = seats(stage);
          if (typeof team === "string") return team;
          const problem = debateStrategy.validate(team, {});
          if (problem) return `tiebreak: ${problem}`;
        }
      }
      return undefined;
    },

    async negotiate(input) {
      const team = seats(input.stage);
      if (typeof team === "string") throw new Error(team);
      const goal = withFeedback(input.goal, input.feedback);
      try {
        const { result } = await runNegotiation({
          sessionId: input.sessionId,
          projectPath: deps.projectPath,
          runId: `${input.stage.id}-${input.attempt}`,
          strategy: input.stage.strategy ?? "",
          goal,
          seats: team,
          options: input.stage.options,
          scheduler: deps.scheduler,
          runStep: deps.runStep,
          emit: input.emit,
          signal: input.signal,
          ...(deps.askTimeoutMs ? { askTimeoutMs: deps.askTimeoutMs } : {}),
        });
        if (!result.decision.trim()) {
          return { outcome: "blocked", summary: `no decision: ${result.rationale}` };
        }
        return { outcome: "pass", summary: result.rationale, decision: result.decision };
      } catch (error) {
        if (error instanceof NegotiationCancelledError && error.reason === "budget") {
          return { outcome: "budget", summary: error.message };
        }
        throw error;
      }
    },

    async execute(input) {
      const { review } = input;
      const base = deps.contract ?? createEmptyContract(input.goal);
      // Supervised executors only see `contract.goal`, so the plan goes there.
      let goal = input.plan ? `${base.goal}\n\nAgreed plan (follow it):\n${input.plan}` : base.goal;
      goal = withFeedback(goal, input.feedback);
      const contract: TaskContract = { ...base, goal };

      let tiebreak: PanelTiebreakOptions = {};
      if (review.options.tiebreak === "negotiate") {
        const team = seats(review);
        if (typeof team === "string") throw new Error(team);
        tiebreak = {
          tiebreak: "negotiate",
          onDisagreement: createDebateTiebreak({
            sessionId: input.sessionId,
            projectPath: deps.projectPath,
            goal,
            seats: team,
            scheduler: deps.scheduler,
            runStep: deps.runStep,
            signal: input.signal,
            emit: (draft) => input.emit({ ...draft, stageId: review.id } as EngineEventDraft),
            runIdPrefix: `${review.id}-${input.attempt}`,
            ...(deps.askTimeoutMs ? { askTimeoutMs: deps.askTimeoutMs } : {}),
          }),
        };
      }

      const executor = deps.createExecutor(input.stage);
      const reviewer = deps.createReviewer(review, tiebreak);
      const maxRounds = review.options.maxRounds as number | undefined;
      const supervisor = new Supervisor({
        ...deps.supervisor,
        projectPath: deps.projectPath,
        contract,
        executor,
        reviewer,
        budgets: createBudgets({ ...deps.budgetLimits, ...(maxRounds ? { maxRounds } : {}) }),
      });
      const stop = () => {
        supervisor.requestCancel();
        void Promise.resolve()
          .then(() => executor.cancel(supervisor.getTaskId()))
          .catch(() => undefined);
      };
      if (input.signal.aborted) stop();
      else input.signal.addEventListener("abort", stop, { once: true });
      let run;
      try {
        run = await supervisor.run();
      } finally {
        input.signal.removeEventListener("abort", stop);
      }

      const final = run.finalReview;
      const summary = final?.summary ?? run.reason ?? run.status;
      switch (run.status) {
        case TaskState.Done:
          return { outcome: "pass", summary };
        case TaskState.HumanRequired:
          return { outcome: "blocked", summary: run.reason ?? summary };
        case TaskState.BudgetExceeded:
          if (final?.status === ReviewStatus.NeedsWork && run.budgets.usage.rounds >= run.budgets.limits.maxRounds) {
            return {
              outcome: "needs_work",
              summary: `still NEEDS_WORK after ${run.round} rounds: ${summary}`,
              feedback: [...(final.requiredChanges ?? [])],
            };
          }
          return { outcome: "budget", summary: run.reason ?? "Supervisor budget exceeded" };
        default:
          throw new Error(run.reason ?? `Supervisor ended ${run.status}`);
      }
    },
  };
}

function withFeedback(goal: string, feedback: readonly string[] | undefined): string {
  return feedback && feedback.length > 0
    ? `${goal}\n\nThe last review asked for these changes:\n${feedback.map((f) => `- ${f}`).join("\n")}`
    : goal;
}

// ---------------------------------------------------------------------------
// Negotiated review tiebreak
// ---------------------------------------------------------------------------

export interface DebateTiebreakInput {
  sessionId: string;
  projectPath?: string;
  /** Task goal (with the plan), shown to the debaters. */
  goal: string;
  /** Reviewer seats that debate. */
  seats: readonly Seat[];
  scheduler: SeatScheduler;
  runStep: SeatStepRunner;
  signal?: AbortSignal;
  emit?: (draft: EngineEventDraft) => void;
  /** Negotiation run ids are `<runIdPrefix>-tiebreak-<n>`. */
  runIdPrefix: string;
  askTimeoutMs?: number;
}

const VERDICT_LINE = /^\s*VERDICT:\s*(PASS|NEEDS_WORK|BLOCKED)\b/i;

/**
 * `onDisagreement` for a split review panel: the reviewer seats debate the
 * member verdicts (shown as "Reviewer 1…n", never by name) and each proposal
 * must start with `VERDICT: PASS|NEEDS_WORK|BLOCKED`. Returns undefined — so
 * the panel policy decides — when the debate reaches no consensus or its
 * decision has no verdict line. It throws on cancel or error, which the
 * coordinator also treats as "no ruling". The coordinator still applies the
 * security veto and refuses a negotiated PASS over a BLOCKED member or an
 * evidenced blocker.
 */
export function createDebateTiebreak(
  input: DebateTiebreakInput,
): (findings: ReviewerFinding[]) => Promise<ReviewResult | undefined> {
  let calls = 0;
  return async (findings) => {
    calls += 1;
    const { result } = await runNegotiation({
      sessionId: input.sessionId,
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      runId: `${input.runIdPrefix}-tiebreak-${calls}`,
      strategy: debateStrategy,
      goal: tiebreakGoal(input.goal, findings),
      seats: input.seats,
      scheduler: input.scheduler,
      runStep: input.runStep,
      ...(input.emit ? { emit: input.emit } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.askTimeoutMs ? { askTimeoutMs: input.askTimeoutMs } : {}),
    });
    const verdict = VERDICT_LINE.exec(result.decision)?.[1]?.toUpperCase();
    if (!result.consensus.reached || !verdict) {
      return undefined;
    }
    const pass = verdict === ReviewStatus.Pass;
    const requiredChanges = pass ? [] : [...new Set(findings.flatMap((f) => f.result.requiredChanges ?? []))];
    try {
      return makeReviewResult({
        status: verdict as ReviewResult["status"],
        confidence: result.consensus.score,
        summary: `Negotiated tiebreak (debate): ${result.rationale}`.slice(0, 500),
        issues: pass ? [] : findings.flatMap((f) => f.result.issues ?? []),
        requiredChanges: !pass && requiredChanges.length === 0 ? [result.decision] : requiredChanges,
        optionalChanges: [],
        evidenceRequests: [],
      });
    } catch {
      return undefined; // a verdict the result schema rejects is no ruling
    }
  };
}

function tiebreakGoal(goal: string, findings: readonly ReviewerFinding[]): string {
  const members = findings.map((f, index) => {
    const issues = (f.result.issues ?? []).map(
      (i) =>
        `  - [${i.severity}${i.category ? `/${i.category}` : ""}] ${i.description}` +
        ((i.evidence ?? []).length > 0 ? ` (evidence: ${(i.evidence ?? []).join("; ")})` : ""),
    );
    return [`Reviewer ${index + 1}: ${f.result.status} — ${f.result.summary}`, ...issues].join("\n");
  });
  return [
    "The review panel disagrees. Decide the review verdict for this task.",
    `Task:\n${goal}`,
    `Panel verdicts:\n${members.join("\n")}`,
    "Start your proposal with one line `VERDICT: PASS`, `VERDICT: NEEDS_WORK` or `VERDICT: BLOCKED`, then give your reasons.",
  ].join("\n\n");
}
