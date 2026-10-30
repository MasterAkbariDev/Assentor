import { z } from "zod";
import type { AssentorConfig } from "../config/schema.js";
import { resolveTeams } from "../config/teams.js";
import type { Autonomy } from "../core/run-mode.js";
import type { SessionSpecSchema } from "../core/seats.js";
import type { StageRunnerDeps } from "../orchestrator/session-stages.js";
import type { StageRunners } from "../orchestrator/session-runner.js";
import type { EngineEventDraft } from "../protocol/events.js";
import type { WorktreeManager } from "../worktrees/manager.js";
import { createDebugController, debugProblems } from "./debug.js";

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
 * `available` is narrower: true only when `assentor run --mode <id>` runs the mode.
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

export interface ModeControllerInput extends ModeBuildInput {
  sessionId: string;
  /** Built-in stage runners (negotiate, execute ⇄ review) to call as tools; autonomy already applied. */
  stages: StageRunners;
  /** Scheduler, seats and model calls behind the stage runners (project path included). */
  deps: StageRunnerDeps;
  /** When the host provides one: worktrees for edit seats. Integrate only through it (T02B-02). */
  worktrees?: WorktreeManager;
  /** Session cancel. Stop all work when it aborts. */
  signal: AbortSignal;
  /** Session event sink; never throws. */
  emit: (draft: EngineEventDraft) => void;
}

/**
 * A running dynamic mode. Autonomy is the controller's to honour (T02B-02): under
 * `manual` ask before every action that starts work, under `supervised` before
 * `integrate`; auto-integrate only under `autopilot` with a policy that allows it.
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

const MODES: readonly ModeDefinition[] = [
  // Today's `assentor run`: one executor in a review loop (one reviewer or a `--team` panel).
  mode("solo", "Solo", "One executor with a review loop; today's assentor run.", "static", true, true, solo),
  // review and negotiate run through prepareModeSession; the CLI does not route them yet (no real
  // SeatStepRunner for negotiation steps, and `run` still drives the Supervisor directly).
  mode("review", "Review", "Several reviewers judge existing work; a policy merges their verdicts.", "static", false, false, review),
  mode("negotiate", "Negotiate", "Several peers reach consensus with a strategy (vote, debate, synthesize).", "static", true, false, negotiate),
  mode("lead", "Lead (Supervisor)", "A lead seat plans tasks, picks agents and accepts or rejects their reports.", "dynamic", true),
  mode("cascade", "Cascade", "Start with a cheap model; escalate on failure or risk.", "dynamic", true),
  mode("pipeline", "Pipeline", "Requirements, architect, coder, tester, reviewer and docs stages in order.", "static", true),
  mode("pair", "Pair", "A driver codes while a navigator watches the stream and interjects.", "static", true),
  mode("race", "Race", "Several seats implement in parallel worktrees; a judge picks one.", "static", true),
  mode("redteam", "Red team", "An attacker writes failing tests or exploits; a builder fixes; repeat.", "static", true),
  mode("tdd", "TDD", "Failing tests first, then code that passes them without touching the tests.", "static", true),
  mode("swarm", "Swarm", "Many small independent items split across cheap seats, then merged.", "static", true),
  // A controller loop (hypothesis rounds, then a fix), not a stage graph: how many rounds it takes depends on the evidence.
  mode("debug", "Debug", "Seats test competing hypotheses in their own worktrees; evidence picks the fix.", "dynamic", true, false, {
    validate: (config) => [...teamProblems(config), ...debugProblems(config)],
    createController: createDebugController,
  }),
  mode("explore", "Explore", "Read-only seats investigate a question; a synthesizer answers with citations.", "static", false),
  mode("plan", "Plan", "Produce a spec and task cards, no code.", "static", true),
  mode("interactive", "Interactive", "Chat with the team; a lead routes messages to seats.", "dynamic", true),
  mode("auto", "Auto", "Suggest a mode from the task and ask before running it.", "dynamic", true),
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
