import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_PROFILES,
  selectReviewers,
  type ReviewStrategy,
} from "#assentor/engine/agents/index.js";
import { createBudgets } from "#assentor/engine/core/budgets.js";
import { createConversationId, createTaskId } from "#assentor/engine/core/ids.js";
import {
  createEmptyContract,
  mergeAcceptanceCriteria,
  type TaskContract,
} from "#assentor/engine/core/task-contract.js";
import { Supervisor } from "#assentor/engine/orchestrator/supervisor.js";
import {
  SeatEventSink,
  trackReviewerSeat,
  type SeatInfo,
} from "#assentor/engine/orchestrator/seat-events.js";
import { EventLog } from "#assentor/engine/events/log.js";
import { estimateRun } from "#assentor/engine/estimate/cost.js";
import { observedPricing } from "#assentor/engine/usage/observed.js";
import type { EngineEvent, RunEstimate } from "#assentor/protocol/events.js";
import { PRINT_CLI_RECIPES } from "#assentor/engine/providers/executors/cli-print/recipes.js";
import { isTerminalState, TaskState } from "#assentor/engine/orchestrator/state-machine.js";
import { TaskStore, loadTaskForResume, findLatestResumableTask } from "#assentor/engine/persistence/index.js";
import { killAllTrackedProcesses } from "#assentor/engine/providers/executors/cursor/index.js";
import { MockExecutor } from "#assentor/engine/providers/executors/mock/index.js";
import type { Executor } from "#assentor/engine/providers/executors/types.js";
import { buildExecutorRegistry } from "#assentor/engine/executors/adapters.js";
import {
  isSelectableExecutorProvider,
  normalizeExecutorProvider,
  formatExecutorProvider,
  SELECTABLE_EXECUTOR_PROVIDERS,
} from "#assentor/engine/executors/providers.js";
import {
  AUTONOMY_LEVELS,
  AutonomySchema,
  type Autonomy,
  type RunMode,
} from "#assentor/engine/core/run-mode.js";
import { getMode, MODE_IDS, ModeIdSchema, type ModeId } from "#assentor/engine/modes/registry.js";
import {
  CliReviewer,
  isCliReviewerAvailable,
  resolveCliAdapter,
  type CliTransport,
} from "#assentor/engine/providers/reviewers/cli/index.js";
import { expandSeatSpecs, type Team } from "#assentor/protocol/seats.js";
import { FallbackReviewer } from "#assentor/engine/providers/reviewers/fallback.js";
import { GeminiReviewer } from "#assentor/engine/providers/reviewers/gemini/index.js";
import { MockReviewer } from "#assentor/engine/providers/reviewers/mock/index.js";
import { OpenAICompatibleReviewer } from "#assentor/engine/providers/reviewers/openai/index.js";
import type { Reviewer } from "#assentor/engine/providers/reviewers/types.js";
import { withReviewBudget } from "#assentor/engine/providers/reviewers/budget.js";
import { roleBudget } from "#assentor/engine/context/budget.js";
import {
  PanelReviewer,
  TaskComplexityAnalyzer,
  specialtyAddendum,
  selectReviewerBackends,
  formatReviewerRunLabel,
  type ReviewCoordinatorOptions,
  type ReviewerBackend,
} from "#assentor/engine/review/index.js";
import { loadAssentorConfig, type AssentorConfig } from "#assentor/engine/config/load.js";
import {
  OUTPUT_STYLES,
  OutputStyleSchema,
  withOutputStyle,
  type OutputStyle,
} from "#assentor/engine/output/style.js";
import { resolveTeams, ReviewModeSchema } from "#assentor/engine/config/teams.js";
import { applyRunProfile, profileNote, reviewStrategyFor, type RunProfile } from "#assentor/engine/config/profile.js";
import {
  createReviewerSeats,
  reviewerProviderForSeat,
  reviewTeamTargets,
} from "#assentor/engine/seats/index.js";
import { printPreflight, runPreflight } from "./preflight.js";
import { terminalQuestionIO, type QuestionIO } from "./mode-questions.js";
import { confirmRunEstimate, formatRunEstimate, toRunEstimate } from "./run-estimate.js";
import { RunReporter } from "./ui/reporter.js";
import type { ModeRunHooks } from "./mode-run.js";
import { resolveProviderApiKey } from "#assentor/engine/keys/resolve.js";

export interface RunAssentorInput {
  projectPath: string;
  prompt: string;
  executor?: string;
  /** Executor model; overrides `config.executor.model`. */
  executorModel?: string;
  reviewer?: string;
  /** Config `teams` entry to review with; overrides `modes.review.team`. Cannot be combined with `reviewer`. */
  team?: string;
  maxRounds?: number;
  maxMessages?: number;
  acceptanceCriteria?: string[];
  verbose?: boolean;
  skipPreflight?: boolean;
  skipGates?: boolean;
  /** Deprecated: use `autonomy`, which wins when both are set. */
  mode?: RunMode;
  /** Deprecated: same as `mode: "autopilot"`. */
  autopilot?: boolean;
  /** Overrides config `run.autonomy` / `run.mode`. */
  autonomy?: Autonomy;
  /** `--style` / `--brief`; overrides `output.style`. */
  style?: OutputStyle;
  /** `--profile`; overrides `run.profile` (TE-06). */
  profile?: RunProfile;
  /** Registry mode (`--mode <id>`). Only `available` modes run; solo runs the Supervisor below, others through prepareModeSession. */
  modeId?: ModeId;
  /** Live seat-scoped engine events (T00-07), in log order. Errors thrown here are reported, not propagated. */
  onEngineEvent?: (event: EngineEvent) => void;
  /** `--mode` runs (not solo): after the session, a retro appends lessons to `.assentor/memory/lessons.md`. */
  retro?: boolean;
  /** `--mode` runs (not solo): replace host pieces (tests, embedding hosts). */
  modeHooks?: ModeRunHooks;
  /** Start even when the pre-run estimate is over `limits.confirmAbove*` (`--yes`, TE-09). */
  yes?: boolean;
  /** Where an over-limit estimate asks for confirmation; default the terminal. */
  confirmIO?: QuestionIO;
}

export async function createExecutor(
  provider: string,
  _projectPath: string,
  options: {
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
    onStatus?: (status: {
      activity: string;
      detail: string;
    }) => void;
    timeoutMs?: number;
    model?: string;
  } = {},
): Promise<Executor> {
  const { withAssentorGitignore } = await import(
    "#assentor/engine/providers/executors/with-gitignore.js"
  );

  let executor: Executor;
  const id = normalizeExecutorProvider(provider);
  if (id === "mock") {
    executor = new MockExecutor();
  } else if (id === "project-mutating") {
    throw new Error(
      "project-mutating executor is test-only; use mock or a detected CLI",
    );
  } else if (isSelectableExecutorProvider(id) && id !== "mock") {
    const registry = buildExecutorRegistry({
      onOutput: options.onOutput,
      onStatus: options.onStatus,
      timeoutMs: options.timeoutMs,
      model: options.model,
    });
    const adapter = registry.get(id);
    if (!adapter) {
      throw new Error(
        `Unknown executor provider "${provider}". Supported: ${SELECTABLE_EXECUTOR_PROVIDERS.join(", ")}`,
      );
    }
    executor = adapter;
  } else {
    throw new Error(
      `Unknown executor provider "${provider}". Supported: ${SELECTABLE_EXECUTOR_PROVIDERS.join(", ")}`,
    );
  }

  return withAssentorGitignore(executor);
}

/**
 * Executor model precedence: the `--executor-model` flag, then
 * `config.executor.model`, then unset (the CLI default). A flag of `AUTO`
 * still wins over config and adds no model flag.
 */
export function resolveExecutorModel(
  flag: string | undefined,
  configModel: string | undefined,
): string | undefined {
  return flag?.trim() || configModel?.trim() || undefined;
}

export interface CreateReviewerOptions {
  onStatus?: (message: string) => void;
  model?: string;
  apiKey?: string;
  /** Logical agent id preserved across transport switches. */
  name?: string;
  transport?: "api" | "cli";
  specialtyAddendum?: string;
  fallback?: {
    transport?: "api" | "cli";
    provider?: string;
    model?: string;
    apiKey?: string;
  };
  /** Injectable CLI transport for tests. */
  cliTransport?: CliTransport;
}

export async function createReviewer(
  provider: string,
  options: CreateReviewerOptions = {},
): Promise<Reviewer> {
  const logicalName = options.name ?? provider;
  const transport = options.transport ?? "api";

  const primary = await createReviewerTransport(provider, {
    ...options,
    name: logicalName,
    transport,
  });

  if (!options.fallback) {
    return primary;
  }

  const fallbackProvider = options.fallback.provider ?? provider;
  const fallbackTransport = options.fallback.transport ?? "api";
  const fallback = await createReviewerTransport(fallbackProvider, {
    onStatus: options.onStatus,
    model: options.fallback.model ?? options.model,
    apiKey: options.fallback.apiKey ?? options.apiKey,
    name: logicalName,
    transport: fallbackTransport,
    cliTransport: options.cliTransport,
  });

  return new FallbackReviewer({
    name: logicalName,
    primary,
    fallback,
    onStatus: options.onStatus,
  });
}

async function createReviewerTransport(
  provider: string,
  options: CreateReviewerOptions & { transport: "api" | "cli"; name: string },
): Promise<Reviewer> {
  if (options.transport === "cli") {
    const adapter = resolveCliAdapter(provider);
    return new CliReviewer({
      name: options.name,
      adapter,
      transport: options.cliTransport,
      onStatus: options.onStatus,
      specialtyAddendum: options.specialtyAddendum,
      model: options.model,
    });
  }

  const model =
    options.model && options.model !== "AUTO" ? options.model : undefined;

  switch (provider) {
    case "mock":
      return new MockReviewer({
        name: options.name,
        steps: [{ type: "pass" }],
      });
    case "openai":
      return new OpenAICompatibleReviewer({
        name: options.name,
        ...(model ? { model } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.specialtyAddendum
          ? { specialtyAddendum: options.specialtyAddendum }
          : {}),
      });
    case "gemini":
      return new GeminiReviewer({
        name: options.name,
        onStatus: options.onStatus,
        ...(model ? { model } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.specialtyAddendum
          ? { specialtyAddendum: options.specialtyAddendum }
          : {}),
      });
    case "claude":
    case "antigravity":
    case "cursor":
      throw new Error(
        `Provider "${provider}" requires transport: "cli". Set reviewers[].transport to "cli".`,
      );
    default:
      throw new Error(
        `Unknown reviewer provider "${provider}". Supported: mock, openai, gemini, claude, antigravity, cursor`,
      );
  }
}

function resolveReviewerModel(
  config: AssentorConfig,
  provider: string,
): string | undefined {
  if (provider === "gemini") {
    return config.models.gemini !== "AUTO"
      ? config.models.gemini
      : config.models.default;
  }
  if (provider === "openai") {
    return config.models.openai !== "AUTO"
      ? config.models.openai
      : config.models.default;
  }
  return config.models.default;
}

function reviewerNeedsApiKey(
  provider: string,
  transport: "api" | "cli",
): boolean {
  if (transport === "cli" || provider === "mock") {
    return false;
  }
  return provider === "openai" || provider === "gemini";
}

const EXECUTOR_SEAT_ID = "executor";
/** Seat for the review panel as a whole, spawned only when there is more than one reviewer. */
const PANEL_SEAT_ID = "panel";
/** Longest `close()` waits for queued event-log writes before giving up on them. */
const SEAT_EVENTS_CLOSE_MS = 5_000;

function reviewerSeatId(index: number): string {
  return `reviewer-${index + 1}`;
}

/**
 * Seat event wiring for one run (T00-07). Callbacks exist before the task id
 * is known; `open` attaches the session event log once it is. Nothing here
 * throws into the run: a log that can't be opened only disables persistence.
 * Exported for tests.
 */
export class RunSeatEvents {
  private sink?: SeatEventSink;
  private log?: EventLog;
  private forwardOutput = false;

  constructor(private readonly onEngineEvent?: (event: EngineEvent) => void) {}

  /**
   * Only plain-text executor output becomes `seat.output.delta`. Stream-json
   * executors print protocol NDJSON that the status parser already turns into
   * status/tool events; persisting it again would be megabytes of noise.
   */
  setExecutorProvider(provider: string): void {
    this.forwardOutput = executorEmitsPlainText(provider);
  }

  readonly executorStatus = (status: { activity: string; detail: string }): void => {
    // Plain-text parsers report every output line as "running <line>". The line
    // is already in seat.output.delta, so it is one "writing" status, not a
    // status and a tool call per line (which would also defeat batching).
    if (this.forwardOutput && status.activity === "running") {
      this.sink?.status(EXECUTOR_SEAT_ID, "writing");
      return;
    }
    this.sink?.activity(EXECUTOR_SEAT_ID, status.activity, status.detail);
  };

  readonly executorOutput = (chunk: string, stream: "stdout" | "stderr"): void => {
    if (this.forwardOutput && stream === "stdout") {
      this.sink?.output(EXECUTOR_SEAT_ID, chunk);
    }
  };

  readonly memberStatus = (index: number, message: string): void => {
    this.sink?.status(reviewerSeatId(index), "thinking", message);
  };

  /** `panel`: a `PanelReviewer` runs these members, so each also reports its own verdict. */
  trackMembers(members: Reviewer[], panel: boolean): Reviewer[] {
    return members.map((member, index) =>
      trackReviewerSeat(member, reviewerSeatId(index), () => this.sink, panel),
    );
  }

  scope(memberCount: number): { executorSeatId: string; reviewerSeatId: string } {
    return {
      executorSeatId: EXECUTOR_SEAT_ID,
      reviewerSeatId: memberCount > 1 ? PANEL_SEAT_ID : reviewerSeatId(0),
    };
  }

  get events(): SeatEventSink | undefined {
    return this.sink;
  }

  async open(input: {
    projectPath: string;
    taskId: string;
    title: string;
    executor: { name: string; provider: string; model?: string };
    reviewers: Array<{ name: string; backend?: ReviewerMemberSource }>;
    redactSecrets: boolean;
    /** The pre-run estimate (TE-09), logged so the usage report can compare it with actual use. */
    estimate?: RunEstimate;
  }): Promise<void> {
    let log: EventLog | undefined;
    try {
      log = await EventLog.open(input.projectPath, input.taskId);
      this.log = log;
    } catch (error) {
      // One line, no stack: this can print while the TUI owns the screen.
      console.error(
        `[assentor] seat events: session log disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sink = new SeatEventSink({
      sessionId: input.taskId,
      log,
      onEvent: this.onEngineEvent,
      redactSecrets: input.redactSecrets,
    });
    this.sink = sink;

    if ((log?.lastSeq ?? 0) === 0) {
      sink.emit({
        type: "session.created",
        sessionId: input.taskId,
        data: { title: input.title },
      });
    }
    if (input.estimate) {
      sink.emit({ type: "session.estimate", sessionId: input.taskId, data: input.estimate });
    }
    sink.spawned(executorSeatInfo(input.executor));
    if (input.reviewers.length > 1) {
      sink.spawned({
        seatId: PANEL_SEAT_ID,
        displayName: "Review panel",
        provider: "panel",
        transport: "api",
        model: "AUTO",
        role: "panel",
        permissions: "read-only",
      });
    }
    input.reviewers.forEach((reviewer, index) => {
      sink.spawned(reviewerSeatInfo(index, reviewer.name, reviewer.backend));
    });
  }

  /** Never rejects; gives up on writes still queued after a few seconds. */
  async close(): Promise<void> {
    try {
      await this.drainSink();
    } finally {
      // Release the session writer lock even when queued writes are stuck.
      await this.log?.close({ timeoutMs: SEAT_EVENTS_CLOSE_MS }).catch(() => undefined);
    }
  }

  private async drainSink(): Promise<void> {
    const closing = this.sink?.close();
    if (!closing) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SEAT_EVENTS_CLOSE_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }
}

/** Exported for tests. */
export function executorEmitsPlainText(provider: string): boolean {
  if (provider === "cursor") {
    return process.env.ASSENTOR_CURSOR_OUTPUT_FORMAT === "text";
  }
  return PRINT_CLI_RECIPES[provider]?.outputFormat === "text";
}

function executorSeatInfo(executor: {
  name: string;
  provider: string;
  model?: string;
}): SeatInfo {
  return {
    seatId: EXECUTOR_SEAT_ID,
    displayName: executor.name,
    provider: executor.provider,
    transport: executor.provider === "mock" ? "api" : "cli",
    model: executor.model?.trim() || "AUTO",
    role: "engineer",
    permissions: "edit",
  };
}

/** Where a review member came from: a legacy `reviewers` entry or a team seat. */
interface ReviewerMemberSource {
  provider: string;
  transport?: "api" | "cli";
  model?: string;
  role?: string;
}

/**
 * Reviewer `{ provider, transport }` pairs a run will use, for preflight and
 * labels: the `modes.review` team's seats when set, else the legacy reviewers.
 */
function reviewTargets(
  config: AssentorConfig,
): Array<{ provider: string; transport: "api" | "cli" }> {
  if (config.modes.review) {
    return reviewTeamTargets(resolveTeams(config).review);
  }
  return selectReviewerBackends(config).map((b) => ({
    provider: b.provider,
    transport: b.transport ?? "api",
  }));
}

function reviewerSeatInfo(
  index: number,
  name: string,
  backend?: ReviewerMemberSource,
): SeatInfo {
  return {
    seatId: reviewerSeatId(index),
    displayName: name,
    provider: backend?.provider ?? "unknown",
    transport: backend?.transport ?? "api",
    model: backend?.model?.trim() || "AUTO",
    role: backend?.role ?? "general",
    permissions: "read-only",
  };
}

/** Decision policy and seat roles for a `PanelReviewer`, from `modes.review`. Exported for mode-run.ts. */
export function panelPolicyOptions(
  config: AssentorConfig,
  backends: ReviewerMemberSource[],
): Pick<ReviewCoordinatorOptions, "policy" | "tiebreak" | "roles"> {
  const mode = config.modes.review;
  return {
    ...(mode ? { policy: mode.policy, tiebreak: mode.tiebreak } : {}),
    roles: backends.map((backend) => backend.role ?? "general"),
  };
}

/** Exported for `run --mode` (mode-run.ts). */
export async function createMembersFromBackends(input: Parameters<typeof buildMembersFromBackends>[0]): ReturnType<typeof buildMembersFromBackends> {
  const built = await buildMembersFromBackends(input);
  const budget = roleBudget(input.config.context?.budgetTokens, "reviewer");
  return budget ? { ...built, members: built.members.map((member) => withReviewBudget(member, budget)) } : built;
}

async function buildMembersFromBackends(input: {
  config: AssentorConfig;
  projectPath: string;
  prompt: string;
  /** A config team to review with instead of `modes.review` / the legacy reviewers. */
  team?: { name: string; team: Team };
  onStatus?: (message: string) => void;
  /** Raw status message for the member at this index (one member per backend). */
  onMemberStatus?: (index: number, message: string) => void;
}): Promise<{
  members: Reviewer[];
  /** `members[i]` was built from `backends[i]`. */
  backends: ReviewerMemberSource[];
  complexity: ReturnType<TaskComplexityAnalyzer["analyze"]>;
  reviewStrategy: ReviewStrategy;
  /**
   * True when members come from the `modes.review` team (T01-02). The team
   * defines the panel, so `routing.reviewStrategy: SINGLE` does not cut it to one.
   */
  teamMode: boolean;
  /** Team mode: `members[i]`'s seat id, for its token reports. */
  seatIds?: string[];
}> {
  const complexity = new TaskComplexityAnalyzer().analyze({
    taskText: input.prompt,
  });
  // Balanced: the config's own. Economy/max: the profile's default unless the config sets one (TE-06).
  const reviewStrategy = reviewStrategyFor(input.config, input.prompt, input.projectPath) as ReviewStrategy;
  const reviewTeam =
    input.team?.team ??
    (input.config.modes.review ? resolveTeams(input.config).review : undefined);
  const backends = reviewTeam ? [] : selectReviewerBackends(input.config, reviewStrategy);
  if (!reviewTeam && backends.length === 0) {
    throw new Error(
      "No reviewers configured. Add Gemini (API) or Claude (CLI) in Configure → Reviewers.",
    );
  }
  const memberCount = reviewTeam
    ? reviewTeam.seats.reduce((total, spec) => total + spec.count, 0)
    : backends.length;

  const selectedProfiles = selectReviewers(
    DEFAULT_AGENT_PROFILES,
    reviewStrategy,
    input.prompt,
    {
      min: 1,
      max:
        reviewStrategy === "FULL"
          ? 7
          : Math.max(memberCount, complexity.recommendedCount),
    },
    complexity,
  );
  const profiles =
    selectedProfiles.length > 0
      ? selectedProfiles
      : DEFAULT_AGENT_PROFILES.filter((p) => p.kind === "reviewer");

  if (reviewTeam) {
    const config = input.config;
    const seats = await createReviewerSeats(reviewTeam, {
      teamName: input.team?.name ?? config.modes.review!.team,
      createReviewer: (request) =>
        createReviewer(request.provider, {
          onStatus: request.onStatus,
          model: request.model,
          apiKey: request.apiKey,
          name: request.name,
          transport: request.transport,
          specialtyAddendum: request.specialtyAddendum,
        }),
      resolveApiKey: async (provider) =>
        (await resolveProviderApiKey(provider, input.projectPath))?.secret,
      defaultApiModel: (provider) => {
        const model = resolveReviewerModel(config, provider);
        return model && model !== "AUTO" ? model : undefined;
      },
      specialtyAddendum: (_seat, index) => {
        const profile = profiles[index % profiles.length];
        return profile
          ? withOutputStyle(specialtyAddendum(profile.specialty), input.config.output.style)
          : undefined;
      },
      onStatus: (seat, index, message) => {
        input.onStatus?.(`[${seat.displayName}] ${message}`);
        input.onMemberStatus?.(index, message);
      },
      onWarning: (message) => input.onStatus?.(`warning: ${message}`),
    });
    return {
      members: seats.map(({ reviewer }) => reviewer),
      backends: seats.map(({ seat }) => ({
        provider: seat.provider,
        transport: seat.transport,
        model: seat.model,
        role: seat.role,
      })),
      complexity,
      reviewStrategy,
      teamMode: true,
      seatIds: seats.map(({ seat }) => seat.id),
    };
  }

  const members: Reviewer[] = [];
  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i]!;
    const profile = profiles[i % profiles.length];
    members.push(
      await instantiateBackend(backend, input.config, input.projectPath, {
        onStatus: (message) => {
          input.onStatus?.(
            `[${backend.name ?? backend.provider}${profile ? `/${profile.id}` : ""}] ${message}`,
          );
          input.onMemberStatus?.(i, message);
        },
        specialtyAddendum: profile
          ? withOutputStyle(specialtyAddendum(profile.specialty), input.config.output.style)
          : undefined,
        logicalName: backend.name ?? profile?.id ?? backend.provider,
      }),
    );
  }

  return { members, backends, complexity, reviewStrategy, teamMode: false };
}

async function instantiateBackend(
  backend: ReviewerBackend,
  config: AssentorConfig,
  projectPath: string,
  extras: {
    onStatus?: (message: string) => void;
    specialtyAddendum?: string;
    logicalName: string;
  },
): Promise<Reviewer> {
  const transport = backend.transport ?? "api";
  const resolvedKey = reviewerNeedsApiKey(backend.provider, transport)
    ? await resolveProviderApiKey(backend.provider, projectPath, {
        keyId: backend.keyId,
      })
    : undefined;
  const fallbackProvider = backend.fallback?.provider;
  const fallbackTransport = backend.fallback?.transport ?? "api";
  const fallbackKey =
    fallbackProvider &&
    reviewerNeedsApiKey(fallbackProvider, fallbackTransport)
      ? await resolveProviderApiKey(fallbackProvider, projectPath)
      : undefined;

  return createReviewer(backend.provider, {
    onStatus: extras.onStatus,
    // CLI reviewers only use an explicitly configured model; models.* defaults are API-oriented.
    model:
      transport === "cli"
        ? backend.model
        : (backend.model ?? resolveReviewerModel(config, backend.provider)),
    apiKey: resolvedKey?.secret,
    name: extras.logicalName,
    transport,
    specialtyAddendum: extras.specialtyAddendum,
    ...(backend.fallback
      ? {
          fallback: {
            transport: backend.fallback.transport,
            provider: backend.fallback.provider,
            // A CLI fallback uses only its own model. "AUTO" (not undefined) stops
            // createReviewer from inheriting the primary's model.
            model:
              fallbackTransport === "cli"
                ? (backend.fallback.model ?? "AUTO")
                : (backend.fallback.model ??
                  (fallbackProvider
                    ? resolveReviewerModel(config, fallbackProvider)
                    : undefined)),
            apiKey: fallbackKey?.secret,
          },
        }
      : {}),
  });
}

export function buildContract(
  prompt: string,
  acceptanceCriteria: string[] = [],
): TaskContract {
  const base = createEmptyContract(prompt);
  return mergeAcceptanceCriteria(base, acceptanceCriteria);
}

/** `--reviewer` and `--team` both choose the reviewers, so only one may be given. */
export function assertReviewerOrTeam(input: { reviewer?: string; team?: string }): void {
  if (input.reviewer && input.team) {
    throw new Error("Use either --reviewer or --team, not both.");
  }
}

/** What `--mode`, `--autonomy` and `--autopilot` ask for; `notice` is a deprecation line to print. */
export interface ModeFlags {
  autonomy?: Autonomy;
  modeId?: ModeId;
  notice?: string;
}

/**
 * Parses the run/resume mode flags. `--mode supervised|autopilot` (exact spelling,
 * as before) is the deprecated autonomy alias and yields a notice; any other
 * `--mode` must be a registry id or alias. Throws on an unknown mode or level, and
 * when `--autonomy` disagrees with a legacy flag.
 */
export function parseModeFlags(options: {
  mode?: string;
  autonomy?: string;
  autopilot?: boolean;
}): ModeFlags {
  const flags: ModeFlags = {};
  // As before, --autopilot beats --mode supervised.
  let legacy: Autonomy | undefined = options.autopilot ? "autopilot" : undefined;
  if (options.mode === "supervised" || options.mode === "autopilot") {
    legacy ??= options.mode;
    flags.notice = `Note: --mode ${options.mode} is deprecated; use --autonomy ${options.mode}.`;
  } else if (options.mode !== undefined) {
    const id = ModeIdSchema.safeParse(options.mode);
    if (!id.success) {
      const level = AutonomySchema.safeParse(options.mode);
      const hint = level.success ? ` Did you mean --autonomy ${level.data}?` : "";
      throw new Error(`Unknown mode "${options.mode}". Modes: ${MODE_IDS.join(", ")}.${hint}`);
    }
    flags.modeId = id.data;
  }
  if (options.autonomy !== undefined) {
    const level = AutonomySchema.safeParse(options.autonomy);
    if (!level.success) {
      throw new Error(
        `Unknown autonomy "${options.autonomy}". Use one of: ${AUTONOMY_LEVELS.join(", ")}.`,
      );
    }
    if (legacy && legacy !== level.data) {
      const source = options.autopilot ? "--autopilot" : `--mode ${options.mode}`;
      throw new Error(`--autonomy ${level.data} conflicts with ${source}.`);
    }
    flags.autonomy = level.data;
  } else {
    flags.autonomy = legacy;
  }
  return flags;
}

/**
 * `--style` and `--brief` (= `--style concise`) for one run. Undefined when neither
 * is given, so `output.style` from the config files applies. Throws on an unknown
 * style and when the two flags disagree.
 */
export function resolveStyleFlags(options: { style?: string; brief?: boolean }): OutputStyle | undefined {
  let requested: OutputStyle | undefined;
  if (options.style !== undefined) {
    const parsed = OutputStyleSchema.safeParse(options.style.trim().toLowerCase());
    if (!parsed.success) {
      throw new Error(`Unknown style "${options.style}". Use one of: ${OUTPUT_STYLES.join(", ")}.`);
    }
    requested = parsed.data;
  }
  if (options.brief && requested && requested !== "concise") {
    throw new Error(`--brief is --style concise; it conflicts with --style ${requested}.`);
  }
  return options.brief ? "concise" : requested;
}

/**
 * `config` with `modes.review.team` set to `team`, for one run. Returns a new
 * object and writes nothing to disk. An unknown team throws the `resolveTeams`
 * error here, before any executor or reviewer exists.
 */
export function withReviewTeam(config: AssentorConfig, team: string): AssentorConfig {
  const next: AssentorConfig = {
    ...config,
    modes: {
      ...config.modes,
      review: ReviewModeSchema.parse({ ...config.modes.review, team }),
    },
  };
  resolveTeams(next);
  return next;
}

/** Seat events go to the reporter's reviewer seats, then to the caller's listener. */
function seatEventListener(
  reporter: RunReporter,
  onEngineEvent?: (event: EngineEvent) => void,
): (event: EngineEvent) => void {
  return (event) => {
    reporter.onEngineEvent(event);
    onEngineEvent?.(event);
  };
}

type SoloRun = Awaited<ReturnType<typeof runAssentorTaskBody>>;
type ModeRun = Awaited<ReturnType<typeof import("./mode-run.js").runModeTask>>;

export function runAssentorTask(input: RunAssentorInput & { modeId?: "solo" }): Promise<SoloRun>;
export function runAssentorTask(input: RunAssentorInput): Promise<SoloRun | ModeRun>;
export async function runAssentorTask(input: RunAssentorInput): Promise<SoloRun | ModeRun> {
  assertReviewerOrTeam(input);
  if (input.modeId && !getMode(input.modeId)?.available) {
    throw new Error(`Mode ${input.modeId} is not available yet.`);
  }
  if (input.modeId && input.modeId !== "solo") {
    // Every other mode runs through prepareModeSession; solo keeps the Supervisor path below unchanged.
    const { runModeTask } = await import("./mode-run.js");
    return runModeTask({ ...input, modeId: input.modeId });
  }
  const projectPath = path.resolve(input.projectPath);
  const executorLabel = input.executor
    ? formatExecutorProvider(normalizeExecutorProvider(input.executor))
    : "executor";
  const reporter = new RunReporter({
    verbose: input.verbose,
    executorName: executorLabel,
    reviewerName: input.reviewer ?? "reviewer",
  });
  reporter.preparing("loading config…");

  let executor: Executor | undefined;
  let supervisor: Supervisor | undefined;
  let taskId: string | undefined;
  const seatEvents = new RunSeatEvents(
    seatEventListener(reporter, input.onEngineEvent),
  );
  const detachInterrupt = attachRunInterrupt({
    reporter,
    getExecutor: () => executor,
    getTaskId: () => taskId,
    getSupervisor: () => supervisor,
  });

  try {
    return await runAssentorTaskBody(input, projectPath, reporter, {
      seatEvents,
      setExecutor: (value) => {
        executor = value;
      },
      setSupervisor: (value) => {
        supervisor = value;
      },
      setTaskId: (value) => {
        taskId = value;
      },
    });
  } finally {
    detachInterrupt();
    await seatEvents.close();
    reporter.dispose();
  }
}

async function runAssentorTaskBody(
  input: RunAssentorInput,
  projectPath: string,
  reporter: RunReporter,
  slots: {
    seatEvents: RunSeatEvents;
    setExecutor: (executor: Executor) => void;
    setSupervisor: (supervisor: Supervisor) => void;
    setTaskId: (taskId: string) => void;
  },
) {
  const loaded = await loadAssentorConfig(projectPath, {
    executor: input.executor,
    reviewer: input.reviewer,
    maxRounds: input.maxRounds,
    maxMessages: input.maxMessages,
    mode: input.autopilot ? "autopilot" : input.mode,
    autonomy: input.autonomy,
    style: input.style,
    profile: input.profile,
  });
  const profiled = applyRunProfile(loaded, { explicit: input.style ? ["output.style"] : [] });
  const config = input.team ? withReviewTeam(profiled, input.team) : profiled;
  reporter.setStyle(config.output.style);
  const profileLine = profileNote(config);
  if (profileLine) reporter.note(profileLine);
  const pricing = await observedPricing(projectPath).catch(() => ({}));
  const estimate = estimateRun(config, {
    prompt: input.prompt,
    modeId: "solo",
    pricing,
    executorModel: resolveExecutorModel(input.executorModel, config.executor.model),
  });
  reporter.note(formatRunEstimate(estimate, config, "solo", { excludesExecutor: false }));
  await confirmRunEstimate({
    estimate,
    limits: config.limits,
    yes: input.yes,
    io: input.confirmIO ?? terminalQuestionIO(),
    hold: (open) => reporter.holdOutput(open),
    log: (line) => reporter.note(line),
  });
  const runMode = config.run.mode;
  const autopilot = runMode === "autopilot";

  const executorProvider = config.executor.provider;
  const backends = selectReviewerBackends(config);

  if (executorProvider === "project-mutating") {
    throw new Error(
      "project-mutating executor is test-only; use mock or cursor",
    );
  }

  const targets = reviewTargets(config);
  const reviewerLabel =
    targets.map((t) => `${t.provider}/${t.transport}`).join(", ") || "none";

  if (!input.skipPreflight) {
    reporter.updatePreparing("checking environment…");
    const preflight = await runPreflight({
      executor: executorProvider,
      reviewers: targets,
      projectPath,
    });
    if (!preflight.ok) {
      reporter.updatePreparing("preflight failed");
      printPreflight(preflight);
      throw new Error(
        "Preflight failed. Fix the issues above, then re-run.\n" +
          "Cursor: `agent login` or set CURSOR_API_KEY\n" +
          "Gemini/OpenAI: assentor → API Keys (global ~/.assentor), or export GEMINI_API_KEY / OPENAI_API_KEY\n" +
          "Claude CLI: install `claude` and run `claude` once to log in\n" +
          "Cursor CLI: `agent login` or set CURSOR_API_KEY\n" +
          "Antigravity: install `agy` and log in once",
      );
    }
  }

  reporter.updatePreparing("starting executor and reviewers…");

  const seatEvents = slots.seatEvents;
  seatEvents.setExecutorProvider(executorProvider);
  const executorModel = resolveExecutorModel(
    input.executorModel,
    config.executor.model,
  );
  const executor = await createExecutor(executorProvider, projectPath, {
    onStatus: (status) => {
      reporter.onExecutorStatus(status);
      seatEvents.executorStatus(status);
    },
    onOutput: seatEvents.executorOutput,
    timeoutMs: config.limits.maxRuntimeMinutes * 60_000,
    model: executorModel,
  });
  slots.setExecutor(executor);

  const {
    members: builtReviewers,
    backends: memberBackends,
    complexity,
    reviewStrategy,
    teamMode,
  } = await createMembersFromBackends({
    config,
    projectPath,
    prompt: input.prompt,
    onStatus: (message) => reporter.onReviewerStatus(message),
    onMemberStatus: seatEvents.memberStatus,
  });
  const usePanel = !((reviewStrategy === "SINGLE" && !teamMode) || builtReviewers.length <= 1);
  const memberReviewers = seatEvents.trackMembers(builtReviewers, usePanel);

  const reviewer: Reviewer = !usePanel
      ? memberReviewers[0]!
      : new PanelReviewer({
          memberSeatIds: memberReviewers.map((_, index) => reviewerSeatId(index)),
          name: teamMode ? "panel:team" : `panel:${reviewStrategy.toLowerCase()}`,
          reviewers: memberReviewers,
          goal: input.prompt,
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          ...panelPolicyOptions(config, memberBackends),
        });

  reporter.note(
    `review strategy: ${reviewStrategy} · reviewers: ${memberReviewers.map((r) => r.name).join(", ")} · complexity=${complexity.score}/${complexity.risk} · evidence=${complexity.evidenceDepth}`,
  );
  const contract = buildContract(input.prompt, input.acceptanceCriteria);
  const budgets = createBudgets({
    maxRounds: config.limits.maxRounds,
    maxMessages: config.limits.maxMessages,
    maxToolCalls: config.limits.maxToolCalls,
    maxRuntimeMs: config.limits.maxRuntimeMinutes * 60_000,
  });

  const taskId = createTaskId();
  slots.setTaskId(taskId);
  const conversationId = createConversationId();
  const store = await TaskStore.create({
    projectPath,
    taskId,
    conversationId,
    contract,
    budgets,
    executor: executor.name,
    reviewers: memberReviewers.map((r) => r.name),
  });

  reporter.note(`task id: ${taskId}`);
  reporter.note(`project: ${projectPath}`);
  reporter.note(
    `defaults: ${runMode} · ${executorProvider} + ${reviewerLabel} · routing=${config.routing.strategy}`,
  );
  reporter.note(`state dir: ${store.paths.taskDir}`);

  await seatEvents.open({
    projectPath,
    taskId,
    title: contract.goal,
    executor: { name: executor.name, provider: executorProvider, model: executorModel },
    reviewers: builtReviewers.map((member, index) => ({
      name: member.name,
      backend: memberBackends[index],
    })),
    redactSecrets: config.security.redactSecrets,
    estimate: toRunEstimate(estimate),
  });

  const supervisor = new Supervisor({
    projectPath,
    contract,
    executor,
    reviewer,
    budgets,
    taskId,
    conversationId,
    store,
    evidenceDepth: complexity.evidenceDepth,
    verification: config.verification,
    skipGates: input.skipGates,
    autopilot,
    outputStyle: config.output.style,
    onEvent: (event) => {
      reporter.onEvent(event);
    },
    seatEvents: seatEvents.events,
    seatScope: seatEvents.scope(memberReviewers.length),
  });
  slots.setSupervisor(supervisor);

  const reviewerDisplay = formatReviewerRunLabel(
    reviewer.name,
    teamMode ? undefined : backends[0],
  );

  reporter.updateAgentLabels({
    executorName: executor.name,
    reviewerName: reviewerDisplay,
  });

  reporter.ready();
  printBanner({
    task: contract.goal,
    round: `0 / ${budgets.limits.maxRounds}`,
    executor: executor.name,
    reviewer: reviewerDisplay,
    mode: runMode,
    status: TaskState.Executing,
    concise: config.output.style === "concise",
  });

  const result = await supervisor.run();
  reporter.printUsage();

  printBanner({
    task: contract.goal,
    round: `${result.round} / ${budgets.limits.maxRounds}`,
    executor: executor.name,
    reviewer: reviewerDisplay,
    mode: runMode,
    status: result.status,
    concise: config.output.style === "concise",
  });

  return { result, config, store };
}

export async function resumeAssentorTask(input: {
  projectPath: string;
  taskId?: string;
  verbose?: boolean;
  executor?: string;
  reviewer?: string;
  maxRounds?: number;
  maxMessages?: number;
  /** Executor model; overrides `config.executor.model`. */
  executorModel?: string;
  /** Live seat-scoped engine events; see `RunAssentorInput.onEngineEvent`. */
  onEngineEvent?: (event: EngineEvent) => void;
  /** Config `teams` entry to review with; see `RunAssentorInput.team`. */
  team?: string;
  /** Overrides config `run.autonomy` / `run.mode` for this resume. */
  autonomy?: Autonomy;
  /** Mode sessions only: see `RunAssentorInput.modeHooks`. */
  modeHooks?: ModeRunHooks;
  /** `--style` / `--brief`; overrides `output.style`. */
  style?: OutputStyle;
  /** `--profile`; overrides `run.profile` (TE-06). */
  profile?: RunProfile;
}) {
  assertReviewerOrTeam(input);
  if (input.taskId) {
    const { readModeRun, resumeModeTask } = await import("./mode-run.js");
    const record = await readModeRun(input.projectPath, input.taskId);
    if (record) {
      const { result } = await resumeModeTask({ ...input, sessionId: input.taskId, record });
      return result;
    }
  }
  const projectPath = path.resolve(input.projectPath);
  const reporter = new RunReporter({
    verbose: input.verbose,
    executorName: input.executor ?? "executor",
    reviewerName: input.reviewer ?? "reviewer",
  });
  reporter.preparing("loading task to continue…");

  const seatEvents = new RunSeatEvents(
    seatEventListener(reporter, input.onEngineEvent),
  );
  let executor: Executor | undefined;
  let supervisor: Supervisor | undefined;
  let taskId: string | undefined;
  const detachInterrupt = attachRunInterrupt({
    reporter,
    getExecutor: () => executor,
    getTaskId: () => taskId,
    getSupervisor: () => supervisor,
  });

  try {
    // Config first: a bad --team fails here, before the task is even looked up.
    reporter.updatePreparing("loading config…");
    const loaded = await loadAssentorConfig(projectPath, {
      executor: input.executor,
      reviewer: input.reviewer,
      maxRounds: input.maxRounds,
      maxMessages: input.maxMessages,
      autonomy: input.autonomy,
      style: input.style,
      profile: input.profile,
    });
    const profiled = applyRunProfile(loaded, { explicit: input.style ? ["output.style"] : [] });
    const config = input.team ? withReviewTeam(profiled, input.team) : profiled;
    const profileLine = profileNote(config);
    if (profileLine) reporter.note(profileLine);
    // The resumed executor session keeps the style of its first run (its continuation
    // prompts carry no style). `--style` here restyles reviewers and the Lead only.
    reporter.setStyle(config.output.style);

    const resume = input.taskId
      ? await loadTaskForResume(projectPath, input.taskId)
      : await findLatestResumableTask(projectPath);
    if (!resume || !resume.resumable) {
      throw new Error(
        resume?.reason ??
          (input.taskId
            ? `Task ${input.taskId} is not resumable`
            : "No resumable task in this project. Start one with: assentor run \"…\""),
      );
    }
    taskId = resume.snapshot.taskId;

    if (
      resume.snapshot.status === TaskState.BudgetExceeded ||
      input.maxRounds ||
      input.maxMessages
    ) {
      const limits = { ...resume.snapshot.budgets.limits };
      if (input.maxRounds) {
        limits.maxRounds = input.maxRounds;
      } else if (resume.snapshot.status === TaskState.BudgetExceeded) {
        limits.maxRounds = Math.max(
          limits.maxRounds + 4,
          config.limits.maxRounds,
        );
      }
      if (input.maxMessages) {
        limits.maxMessages = input.maxMessages;
      } else if (resume.snapshot.status === TaskState.BudgetExceeded) {
        limits.maxMessages = Math.max(
          limits.maxMessages + 20,
          config.limits.maxMessages,
        );
      }
      resume.snapshot.budgets = {
        ...resume.snapshot.budgets,
        limits,
      };
      reporter.note(
        `Extended budgets for resume: rounds ${resume.snapshot.budgets.usage.rounds}/${limits.maxRounds}, messages ${resume.snapshot.budgets.usage.messages}/${limits.maxMessages}`,
        "warning",
      );
    }
    const executorProvider = config.executor.provider;
    const backends = selectReviewerBackends(config);

    reporter.updateAgentLabels({
      executorName: formatExecutorProvider(executorProvider),
      reviewerName: formatReviewerRunLabel(
        backends[0]?.provider ?? input.reviewer ?? "reviewer",
        backends[0],
      ),
    });

    reporter.updatePreparing("checking environment…");
    const preflight = await runPreflight({
      executor: executorProvider,
      reviewers: reviewTargets(config),
      projectPath,
    });
    if (!preflight.ok) {
      reporter.updatePreparing("preflight failed");
      printPreflight(preflight);
      throw new Error("Preflight failed. Fix the issues above, then re-run.");
    }

    reporter.updatePreparing(
      `resuming ${resume.snapshot.taskId.slice(0, 8)}…`,
    );
    reporter.note(
      `Resuming ${resume.snapshot.taskId} (${resume.snapshot.status}) · ${resume.snapshot.contract.goal}`,
    );

    seatEvents.setExecutorProvider(executorProvider);
    const executorModel = resolveExecutorModel(
      input.executorModel,
      config.executor.model,
    );
    executor = await createExecutor(executorProvider, projectPath, {
      onStatus: (status) => {
        reporter.onExecutorStatus(status);
        seatEvents.executorStatus(status);
      },
      onOutput: seatEvents.executorOutput,
      timeoutMs: config.limits.maxRuntimeMinutes * 60_000,
      model: executorModel,
    });

    const {
      members: builtReviewers,
      backends: memberBackends,
      reviewStrategy,
      teamMode,
    } = await createMembersFromBackends({
      config,
      projectPath,
      prompt: resume.snapshot.contract.goal,
      onStatus: (message) => reporter.onReviewerStatus(message),
      onMemberStatus: seatEvents.memberStatus,
    });
    const usePanel = !((reviewStrategy === "SINGLE" && !teamMode) || builtReviewers.length <= 1);
    const memberReviewers = seatEvents.trackMembers(builtReviewers, usePanel);

    const reviewer: Reviewer = !usePanel
        ? memberReviewers[0]!
        : new PanelReviewer({
            memberSeatIds: memberReviewers.map((_, index) => reviewerSeatId(index)),
            name: teamMode ? "panel:team" : `panel:${reviewStrategy.toLowerCase()}`,
            reviewers: memberReviewers,
            goal: resume.snapshot.contract.goal,
            ...panelPolicyOptions(config, memberBackends),
            acceptanceCriteria:
              resume.snapshot.contract.acceptanceCriteria ?? [],
          });

    reporter.updateAgentLabels({
      executorName: executor.name,
      reviewerName: formatReviewerRunLabel(
        reviewer.name,
        teamMode ? undefined : backends[0],
      ),
    });

    await seatEvents.open({
      projectPath,
      taskId: resume.snapshot.taskId,
      title: resume.snapshot.contract.goal,
      executor: { name: executor.name, provider: executorProvider, model: executorModel },
      reviewers: builtReviewers.map((member, index) => ({
        name: member.name,
        backend: memberBackends[index],
      })),
      redactSecrets: config.security.redactSecrets,
    });

    supervisor = new Supervisor({
      projectPath,
      contract: resume.snapshot.contract,
      executor,
      reviewer,
      store: resume.store,
      resumeFrom: resume.snapshot,
      verification: config.verification,
      autopilot: config.run.mode === "autopilot",
      outputStyle: config.output.style,
      onEvent: (event) => reporter.onEvent(event),
      seatEvents: seatEvents.events,
      seatScope: seatEvents.scope(memberReviewers.length),
    });

    const result = await supervisor.run();
    reporter.printUsage();
    return result;
  } finally {
    detachInterrupt();
    await seatEvents.close();
    reporter.dispose();
  }
}

export async function statusAssentorTask(projectPath: string, taskId: string) {
  const resume = await loadTaskForResume(path.resolve(projectPath), taskId);
  return resume.snapshot;
}

export async function initAssentorProject(projectPath: string): Promise<string> {
  const { parseAssentorConfig, saveAssentorConfig, assentorConfigPath } =
    await import("#assentor/engine/config/load.js");
  const { detectVerificationCommands } = await import(
    "#assentor/engine/config/detect-commands.js"
  );
  const { ensureAssentorGitignored } = await import("#assentor/engine/persistence/paths.js");
  await ensureAssentorGitignored(projectPath);
  const configPath = assentorConfigPath(projectPath);
  try {
    await fs.access(configPath);
    return configPath;
  } catch {
    // create defaults
  }
  const detected = await detectVerificationCommands(projectPath);
  return saveAssentorConfig(
    projectPath,
    parseAssentorConfig({
      verification: {
        enabled: true,
        commands: {
          typecheck: detected.typecheck,
          test: detected.test,
          lint: detected.lint,
          build: detected.build,
        },
      },
    }),
    { scope: "project" },
  );
}

export interface DoctorOptions {
  /** Project whose config lists the teams. Ignored when `config` is given. */
  projectPath?: string;
  /** Config to list teams from. Tests inject this; otherwise it is loaded from `projectPath`. */
  config?: AssentorConfig;
  /** Whether a CLI reviewer is installed, by reviewer provider id. Default: `isCliReviewerAvailable`. */
  locate?: (provider: string) => boolean;
}

export async function doctorAssentor(options: DoctorOptions = {}): Promise<string[]> {
  const lines: string[] = [];
  lines.push(`assentor: v${(await import("#assentor/engine/self/version.js")).getLocalVersionSync()}`);
  lines.push(`node: ${process.version}`);
  lines.push(
    `OPENAI_API_KEY: ${process.env.OPENAI_API_KEY || process.env.ASSENTOR_OPENAI_API_KEY ? "set" : "missing"}`,
  );
  lines.push(
    `GEMINI_API_KEY: ${process.env.GEMINI_API_KEY || process.env.ASSENTOR_GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "set" : "missing"}`,
  );
  lines.push(
    `CURSOR_API_KEY: ${process.env.CURSOR_API_KEY ? "set" : "missing"}`,
  );
  lines.push(
    `ASSENTOR_GEMINI_MODEL: ${process.env.ASSENTOR_GEMINI_MODEL ?? "(default gemini-2.5-flash + fallbacks)"}`,
  );

  const { resolveCursorBinary, isCursorAppBinary } = await import(
    "#assentor/engine/providers/executors/cursor/index.js"
  );
  const binary = resolveCursorBinary();
  lines.push(`cursor binary: ${binary}`);
  lines.push(
    `cursor invocation: ${isCursorAppBinary(binary) ? `${binary} agent ...` : `${binary} ...`}`,
  );

  lines.push(...(await doctorTeamLines(options)));
  return lines;
}

/** "Teams" section, one block per configured team. Empty when no teams are configured. */
async function doctorTeamLines(options: DoctorOptions): Promise<string[]> {
  let config = options.config;
  if (!config && options.projectPath) {
    try {
      config = await loadAssentorConfig(path.resolve(options.projectPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [`teams: unavailable (${message})`];
    }
  }
  const teams = Object.entries(config?.teams ?? {});
  if (teams.length === 0) {
    return [];
  }

  const locate = options.locate ?? isCliReviewerAvailable;
  const lines = ["", "Teams"];
  for (const [name, team] of teams) {
    lines.push(`  ${name}`);
    for (const seat of expandSeatSpecs(team.seats)) {
      // Only CLI seats need a binary on this machine; API and mock seats never do.
      const found =
        seat.transport === "cli"
          ? locate(reviewerProviderForSeat(seat.provider) ?? seat.provider)
            ? "✓"
            : "✗"
          : "api";
      lines.push(
        `    ${seat.displayName} · ${seat.provider}/${seat.transport} · ${seat.model} · ${seat.permissions} · ${found}`,
      );
    }
  }
  return lines;
}

/** Exported for mode-run.ts, whose `getSupervisor` cancels the whole mode session. */
export function attachRunInterrupt(input: {
  reporter: RunReporter;
  getExecutor: () => Executor | undefined;
  getTaskId: () => string | undefined;
  getSupervisor: () => Pick<Supervisor, "requestCancel"> | undefined;
}): () => void {
  let stopping = false;
  const onInterrupt = () => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    input.reporter.updatePreparing("Ctrl+C — stopping Cursor and saving…");
    const executor = input.getExecutor();
    const taskId = input.getTaskId();
    const supervisor = input.getSupervisor();
    if (executor && taskId) {
      void executor.cancel(taskId);
    }
    killAllTrackedProcesses();
    if (supervisor) {
      supervisor.requestCancel();
      setTimeout(() => process.exit(130), 8_000).unref?.();
      return;
    }
    process.exit(130);
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  return () => {
    killAllTrackedProcesses();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  };
}

export function printBanner(input: {
  task: string;
  round: string;
  executor: string;
  reviewer: string;
  mode?: string;
  status: string;
  /** `output.style: concise`: one line instead of the box (TE-02). */
  concise?: boolean;
}): void {
  const task = truncate(input.task, 40);
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";
  if (input.concise) {
    console.log(`${cyan}${bold}ASSENTOR${reset} · ${input.status} · round ${input.round} · ${truncate(input.task, 60)}`);
    return;
  }
  console.log(`${cyan}${bold}╭──────────────────────────────────────────╮${reset}`);
  console.log(`${cyan}${bold}│ ASSENTOR                                    │${reset}`);
  console.log(`${cyan}${bold}├──────────────────────────────────────────┤${reset}`);
  console.log(`${cyan}│${reset} Task      ${pad(task, 29)}${cyan}│${reset}`);
  console.log(`${cyan}│${reset} Round     ${pad(input.round, 29)}${cyan}│${reset}`);
  console.log(`${cyan}│${reset} Mode      ${pad(input.mode ?? "supervised", 29)}${cyan}│${reset}`);
  console.log(`${cyan}│${reset} Executor  ${pad(input.executor, 29)}${cyan}│${reset}`);
  console.log(`${cyan}│${reset} Reviewer  ${pad(input.reviewer, 29)}${cyan}│${reset}`);
  console.log(`${cyan}│${reset} Status    ${pad(input.status, 29)}${cyan}│${reset}`);
  console.log(`${cyan}${bold}╰──────────────────────────────────────────╯${reset}`);
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return value + " ".repeat(width - value.length);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function describeTerminal(status: string): string {
  if (!isTerminalState(status as TaskState)) {
    return "running";
  }
  return status;
}

export type { AssentorConfig };
