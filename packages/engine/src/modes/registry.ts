import { z } from "zod";
import type { AssentorConfig } from "../config/schema.js";
import { resolveTeams } from "../config/teams.js";
import type { Autonomy } from "../core/run-mode.js";
import type { Seat, SessionSpecSchema } from "#assentor/protocol/seats.js";
import type { Executor } from "../providers/executors/types.js";
import type { StageRunnerDeps } from "../orchestrator/session-stages.js";
import type { StageResult, StageRunners } from "../orchestrator/session-runner.js";
import type { EngineEventDraft } from "#assentor/protocol/events.js";
import type { PromptLibrary } from "../prompts/library.js";
import type { Usage } from "../seats/scheduler.js";
import type { WorktreeManager } from "../worktrees/manager.js";
import { leadConfigProblems } from "./lead/config.js";
import type { RosterEntry } from "./roster.js";
import { builtinPlaybookSession, builtinPlaybookTeamProblems } from "./playbook-modes.js";
import { createDebugController, debugProblems } from "./debug.js";
import { tddRuntime } from "./tdd/mode.js";
import { cascadeProblems, createCascadeController } from "./cascade.js";
import { createRedteamController, redteamProblems } from "./redteam.js";
import { createPairController, pairProblems } from "./pair.js";
import { createSwarmController, swarmProblems } from "./swarm.js";

/**
 * Mode registry and mode contract (T02B-01b metadata, T02B-01 contract). A mode
 * decides how seats are organized and who decides the next step; autonomy
 * (`src/core/run-mode.ts`) is the separate axis for how much it runs without asking.
 * Catalog: docs/plans/modes.md §3.
 *
 * A **static** mode turns its input into a `SessionSpec` (`buildSession`) that the
 * stage-graph runner (T02-09) walks; a **dynamic** mode returns a `ModeController`
 * (`createController`) that decides each next step itself and calls the stage
 * runners as tools (Lead, T02B-02). `prepareModeSession` (`src/modes/session.ts`)
 * validates and starts either kind. A mode with neither cannot run yet.
 *
 * `available` is narrower: true only when `assentor run --mode <id>` runs the mode
 * (solo through the Supervisor, the rest through `prepareModeSession`).
 */
/** Ids in modes.md §3 catalog order. */
export const MODE_IDS = [
  "solo",
  "review",
  "negotiate",
  "lead",
  "cascade",
  "pipeline",
  "pair",
  "race",
  "redteam",
  "tdd",
  "swarm",
  "debug",
  "explore",
  "plan",
  "interactive",
  "auto",
  "watch",
] as const;
export type ModeId = (typeof MODE_IDS)[number];

/** Accepted spellings that resolve to a canonical id (modes.md §1). */
export const MODE_ALIASES: Readonly<Record<string, ModeId>> = { supervisor: "lead" };

/** Mode id from user input: trims, lowercases and resolves aliases; rejects unknown ids. */
export const ModeIdSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const id = value.trim().toLowerCase();
  return MODE_ALIASES[id] ?? id;
}, z.enum(MODE_IDS));

/** A built session graph; defaults (`options`, `requireApproval`) may be omitted. */
export type SessionSpecInput = z.input<typeof SessionSpecSchema>;

/** What `buildSession` and `createController` get. */
export interface ModeBuildInput {
  goal: string;
  title: string;
  /**
   * The configured level. A mode may ask the user more often than it implies,
   * never less. `prepareModeSession` enforces the floor: under `manual` every
   * non-review stage waits for approval; only `autopilot` lets the Supervisor steer.
   */
  autonomy: Autonomy;
  /** Loaded config; the mode reads its own `modes.<id>` section. `validate` has passed. */
  config: AssentorConfig;
}

/** A piece of a running executor's live output (Pair mode, T02B-13). */
export interface ExecutorOutputChunk {
  text: string;
  /** The executor started or finished a tool call; a watcher may look at once. */
  toolCall?: boolean;
}

/**
 * Host services a dynamic controller needs beyond the stage runners (T02B-02).
 * Optional on the session; a controller that needs one it did not get throws
 * when it starts (the session then fails with that reason).
 */
export interface ModeHostServices {
  /**
   * One read-only prompt on a seat (Lead turns, summaries): render nothing, call
   * the seat's model, return its reply text. Must stop when `signal` aborts.
   * Runs inside a scheduler job; report usage through `reportUsage`.
   */
  askSeat?(request: {
    seat: Seat;
    prompt: string;
    signal: AbortSignal;
    reportUsage: (delta: Partial<Usage>) => void;
  }): Promise<string>;
  /** Who may be hired right now (`buildRoster`, T02B-04): installed, authenticated, allowed by policy. */
  roster?(): readonly RosterEntry[] | Promise<readonly RosterEntry[]>;
  /** The prompt library the host loaded (layers it chose). Without it a controller loads the default layers. */
  prompts?: PromptLibrary;
  /**
   * Live output of an executor made by `deps.createExecutor` (its `onOutput`, in
   * the host's wiring); returns the unsubscribe function. Pair mode's navigator
   * watches through it. Without it the navigator sees the driver's output at the
   * end of each turn only.
   */
  watchExecutorOutput?(executor: Executor, onChunk: (chunk: ExecutorOutputChunk) => void): () => void;
}

/** Thrown by a gated action the user did not approve (e.g. `worktrees.applyTo("main")`); nothing changed. */
export class ApprovalDeniedError extends Error {
  override name = "ApprovalDeniedError";
}

/**
 * The stage result the session's `manual` gate returns when the user declines a stage. Compare by identity:
 * a model-written BLOCKED review with the same words is a different object and must still escalate.
 */
export const STAGE_DENIED: StageResult = Object.freeze({ outcome: "blocked" as const, summary: "the user did not approve this stage" });

/** What a controller may do with worktrees. `applyTo("main")` passes the session's approval floor. */
export type ControllerWorktrees = Pick<WorktreeManager, "create" | "diff" | "list" | "applyTo" | "discard" | "markFailed" | "cleanup" | "readAtBase">;

/** A request for the user's yes/no before work starts or lands. */
export interface ApprovalRequest {
  /** One line shown to the user, e.g. "Apply task T3 to your branch?". */
  question: string;
  /**
   * Under `manual`: approving this also approves the first run of executors the
   * controller creates for this stage id, so it can ask before scheduling work
   * (with its own wording) instead of the executor asking inside its job.
   */
  stageId?: string;
}

export interface ModeControllerInput extends ModeBuildInput {
  sessionId: string;
  /**
   * Built-in stage runners (negotiate, execute ⇄ review) to call as tools. Under
   * `manual` autonomy the session gates them: each call waits for the user's
   * approval and a denied call returns `blocked` without running anything.
   */
  stages: StageRunners;
  /**
   * Scheduler, seats and model calls behind the stage runners (project path
   * included). Under `manual`, every executor from `createExecutor` asks the
   * user before its first run (one approval per executor).
   */
  deps: StageRunnerDeps;
  /**
   * When the host provides one: worktrees for agent seats. Applying to `"main"`
   * asks the user first unless autonomy is `autopilot`; a denial throws
   * `ApprovalDeniedError`.
   */
  worktrees?: ControllerWorktrees;
  /** Host services (model calls, roster). */
  host: ModeHostServices;
  /**
   * Asks the user a yes/no question (`user.question`, answered with the
   * session's `answer()`). Resolves false when denied or when the session is
   * cancelled. For approvals a mode adds on top of the floor.
   */
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  /**
   * Asks the user a question. With `options`, the answer is one of them. Resolves
   * undefined when the session is cancelled before an answer.
   */
  ask(question: { question: string; options?: readonly string[] }): Promise<string | undefined>;
  /**
   * Continue a session this mode persisted earlier (same `sessionId`). Autonomy is
   * the one given now, never a saved one: the floor is re-applied on every resume.
   */
  resume: boolean;
  /** Session cancel. Stop all work when it aborts. */
  signal: AbortSignal;
  /** Session event sink; never throws. */
  emit: (draft: EngineEventDraft) => void;
}

/**
 * A running dynamic mode. The session enforces the autonomy floor around it
 * (`manual`: approval before any executor runs or stage starts; `manual` and
 * `supervised`: approval before applying to the main checkout). A controller may
 * ask more (`requestApproval`), never less: auto-integrate only under `autopilot`
 * with a policy that allows it.
 */
export interface ModeController {
  /**
   * Runs the mode to its end. Throw to fail the session. When `signal` aborts,
   * settle promptly: whatever it returns then is recorded as cancelled.
   */
  run(): Promise<ModeControllerResult>;
}

export interface ModeControllerResult {
  status: "completed" | "blocked" | "budget_exceeded";
  reason?: string;
}

export interface ModeDefinition {
  id: ModeId;
  /** Display name, e.g. "Lead (Supervisor)". */
  title: string;
  /** One line for lists and help. */
  description: string;
  /** static: a fixed stage graph decides the next step; dynamic: a controller seat or router does (modes.md §2). */
  kind: "static" | "dynamic";
  defaultAutonomy: Autonomy;
  /** May change files in the user's project. Conservative: "optional" or "configurable" count as true. */
  editsCode: boolean;
  /** True only when `assentor run --mode <id>` can run it today; otherwise it fails before any work. */
  available: boolean;
  /** Problems with this mode's config (`modes.<id>`, its teams), or `[]`. Runs before anything starts. */
  validate?(config: AssentorConfig): string[];
  /** Static modes: the stage graph to run. Pure; must not start work. */
  buildSession?(input: ModeBuildInput): SessionSpecInput;
  /** Dynamic modes: the controller. Called when the session starts; may throw (the session then fails). */
  createController?(input: ModeControllerInput): ModeController;
}

/** Execute-stage strategy for "no executor": review mode reviews the work already in the tree. */
export const EXISTING_WORK_STRATEGY = "existing-work";

type ModeRuntime = Pick<ModeDefinition, "validate" | "buildSession" | "createController">;

function mode(
  id: ModeId,
  title: string,
  description: string,
  kind: ModeDefinition["kind"],
  editsCode: boolean,
  available = false,
  runtime: ModeRuntime = {},
): ModeDefinition {
  return { id, title, description, kind, defaultAutonomy: "supervised", editsCode, available, ...runtime };
}

/** `resolveTeams` problems (unknown `modes.*.team`, unmappable executor/reviewer), as a list. */
function teamProblems(config: AssentorConfig): string[] {
  try {
    resolveTeams(config);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** The panel review stage; `modes.review` picks the team (else legacy `reviewers`, via the host). */
function reviewStage(config: AssentorConfig, options: Record<string, unknown> = {}) {
  const review = config.modes.review;
  return {
    id: "review",
    kind: "review" as const,
    strategy: "panel",
    ...(review ? { team: review.team } : {}),
    options: { ...options, ...(review?.tiebreak === "negotiate" ? { tiebreak: "negotiate" } : {}) },
  };
}

const solo: ModeRuntime = {
  validate: teamProblems,
  buildSession: ({ goal, title, config }) => ({
    title,
    goal,
    stages: [{ id: "execute", kind: "execute", next: "review" }, reviewStage(config)],
  }),
};

// The stage graph has no standalone review stage (T02-09), so review runs as the execute ⇄ review
// pair with a no-op executor and one round: PASS completes, NEEDS_WORK blocks with the findings.
const review: ModeRuntime = {
  validate: teamProblems,
  buildSession: ({ goal, title, config }) => ({
    title,
    goal: `Review the work already in this project; no executor changes anything in this session.\n\nWhat to review: ${goal}`,
    stages: [
      { id: "existing-work", kind: "execute", strategy: EXISTING_WORK_STRATEGY, next: "review" },
      reviewStage(config, { maxRounds: 1 }),
    ],
  }),
};

const negotiate: ModeRuntime = {
  validate: (config) =>
    config.modes.negotiate
      ? teamProblems(config)
      : ["negotiate mode needs modes.negotiate (team and strategy) in the config"],
  buildSession: ({ goal, title, config }) => {
    const { team, strategy, maxRounds, consensus } = config.modes.negotiate!;
    return {
      title,
      goal,
      stages: [{ id: "negotiate", kind: "negotiate", team, strategy, options: { maxRounds, consensus } }],
    };
  },
};

// The controller is Node-only (worktrees, gates, state file), so it loads on run and the registry stays browser-safe.
const lead: ModeRuntime = {
  validate: leadConfigProblems,
  createController: (input) => ({
    run: async () => (await import("./lead/controller.js")).createLeadController(input).run(),
  }),
};

// Built-in playbooks (playbooks/builtin): read-only explore and plan have no execute stage or edit seat.
const pipeline: ModeRuntime = {
  validate: (config) => builtinPlaybookTeamProblems("pipeline", config),
  buildSession: ({ goal, title }) => builtinPlaybookSession("pipeline", { goal, title }),
};

const explore: ModeRuntime = {
  validate: (config) => builtinPlaybookTeamProblems("explore", config),
  buildSession: ({ goal, title }) => builtinPlaybookSession("explore", { goal, title }),
};

const plan: ModeRuntime = {
  validate: (config) => builtinPlaybookTeamProblems("plan", config),
  buildSession: ({ goal, title }) => builtinPlaybookSession("plan", { goal, title }),
};

const MODES: readonly ModeDefinition[] = [
  // Today's `assentor run`: one executor in a review loop (one reviewer or a `--team` panel).
  mode("solo", "Solo", "One executor with a review loop; today's assentor run.", "static", true, true, solo),
  // Modes below with a buildSession/createController run from `assentor run --mode <id>` through
  // prepareModeSession (CLI host: packages/cli/src/cli/mode-run.ts).
  mode("review", "Review", "Several reviewers judge existing work; a policy merges their verdicts.", "static", false, true, review),
  mode("negotiate", "Negotiate", "Several peers reach consensus with a strategy (vote, debate, synthesize).", "static", true, true, negotiate),
  mode("lead", "Lead (Supervisor)", "A lead seat plans tasks, picks agents and accepts or rejects their reports.", "dynamic", true, true, lead),
  mode("cascade", "Cascade", "Start with a cheap model; escalate on failure or risk.", "dynamic", true, true, {
    validate: cascadeProblems,
    createController: (input) => createCascadeController(input, { approve: (question) => input.requestApproval({ question }) }),
  }),
  mode("pipeline", "Pipeline", "Requirements, architect, coder, tester, reviewer and docs stages in order.", "static", true, true, pipeline),
  // A controller loop (driver turns, live navigator, gates, review), not a stage graph: an interjection restarts a turn.
  mode("pair", "Pair", "A driver codes while a navigator watches the stream and interjects.", "dynamic", true, true, {
    validate: (config) => [...teamProblems(config), ...pairProblems(config)],
    createController: (input) => createPairController(input, { approve: (question) => input.requestApproval({ question }) }),
  }),
  mode("race", "Race", "Several seats implement in parallel worktrees; a judge picks one.", "static", true),
  // A controller loop (attacker round, builder fix, gates), not a stage graph: the number of rounds depends on the attacker.
  mode("redteam", "Red team", "An attacker writes failing tests or exploits; a builder fixes; repeat.", "dynamic", true, true, {
    validate: (config) => [...teamProblems(config), ...redteamProblems(config)],
    createController: (input) => createRedteamController(input, { approve: (question) => input.requestApproval({ question }) }),
  }),
  // The CLI host returns createTddExecutor for strategy "tdd".
  mode("tdd", "TDD", "Failing tests first, then code that passes them without touching the tests.", "static", true, true, tddRuntime),
  // A controller loop (split, batches, tier retries, gates, review), not a stage graph: the batches depend on the split and on what fails.
  mode("swarm", "Swarm", "Many small independent items split across cheap seats, then merged.", "dynamic", true, true, {
    validate: (config) => [...teamProblems(config), ...swarmProblems(config)],
    createController: (input) => createSwarmController(input),
  }),
  // A controller loop (hypothesis rounds, then a fix), not a stage graph: how many rounds it takes depends on the evidence.
  mode("debug", "Debug", "Seats test competing hypotheses in their own worktrees; evidence picks the fix.", "dynamic", true, true, {
    validate: (config) => [...teamProblems(config), ...debugProblems(config)],
    createController: (input) => createDebugController(input, { approve: (question) => input.requestApproval({ question }) }),
  }),
  mode("explore", "Explore", "Read-only seats investigate a question; a synthesizer answers with citations.", "static", false, true, explore),
  mode("plan", "Plan", "Produce a spec and task cards, no code.", "static", true, true, plan),
  mode("interactive", "Interactive", "Chat with the team; a lead routes messages to seats.", "dynamic", true),
  mode("auto", "Auto", "Suggest a mode from the task and ask before running it.", "dynamic", true, true),
  mode("watch", "Watch", "React to commits, PRs or CI failures by running a chosen mode.", "static", true),
];

const BY_ID = new Map(MODES.map((m) => [m.id, m]));

/** Every mode in catalog order, available or not. */
export function listModes(): readonly ModeDefinition[] {
  return MODES;
}

/** The mode for an id or alias (`supervisor` → `lead`), any case; undefined when unknown. */
export function getMode(id: string): ModeDefinition | undefined {
  const parsed = ModeIdSchema.safeParse(id);
  return parsed.success ? BY_ID.get(parsed.data) : undefined;
}
