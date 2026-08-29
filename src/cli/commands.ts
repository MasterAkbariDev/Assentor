import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_PROFILES,
  selectReviewers,
  type ReviewStrategy,
} from "../agents/index.js";
import { createBudgets } from "../core/budgets.js";
import { createConversationId, createTaskId } from "../core/ids.js";
import {
  createEmptyContract,
  mergeAcceptanceCriteria,
  type TaskContract,
} from "../core/task-contract.js";
import { Supervisor } from "../orchestrator/supervisor.js";
import { isTerminalState, TaskState } from "../orchestrator/state-machine.js";
import { TaskStore, loadTaskForResume, findLatestResumableTask } from "../persistence/index.js";
import { killAllTrackedProcesses } from "../providers/executors/cursor/index.js";
import { MockExecutor } from "../providers/executors/mock/index.js";
import type { Executor } from "../providers/executors/types.js";
import { buildExecutorRegistry } from "../executors/adapters.js";
import {
  isSelectableExecutorProvider,
  normalizeExecutorProvider,
  SELECTABLE_EXECUTOR_PROVIDERS,
} from "../executors/providers.js";
import { type RunMode } from "../core/run-mode.js";
import {
  CliReviewer,
  resolveCliAdapter,
  type CliTransport,
} from "../providers/reviewers/cli/index.js";
import { FallbackReviewer } from "../providers/reviewers/fallback.js";
import { GeminiReviewer } from "../providers/reviewers/gemini/index.js";
import { MockReviewer } from "../providers/reviewers/mock/index.js";
import { OpenAICompatibleReviewer } from "../providers/reviewers/openai/index.js";
import type { Reviewer } from "../providers/reviewers/types.js";
import {
  PanelReviewer,
  TaskComplexityAnalyzer,
  specialtyAddendum,
  selectReviewerBackends,
  formatReviewerRunLabel,
  type ReviewerBackend,
} from "../review/index.js";
import { loadAssentorConfig, type AssentorConfig } from "../config/load.js";
import { printPreflight, runPreflight } from "./preflight.js";
import { RunReporter } from "./ui/reporter.js";
import { resolveProviderApiKey } from "../keys/resolve.js";

export interface RunAssentorInput {
  projectPath: string;
  prompt: string;
  executor?: string;
  reviewer?: string;
  maxRounds?: number;
  maxMessages?: number;
  acceptanceCriteria?: string[];
  verbose?: boolean;
  skipPreflight?: boolean;
  skipGates?: boolean;
  mode?: RunMode;
  autopilot?: boolean;
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
  } = {},
): Promise<Executor> {
  const { withAssentorGitignore } = await import(
    "../providers/executors/with-gitignore.js"
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

async function createMembersFromBackends(input: {
  config: AssentorConfig;
  projectPath: string;
  prompt: string;
  onStatus?: (message: string) => void;
}): Promise<{
  members: Reviewer[];
  complexity: ReturnType<TaskComplexityAnalyzer["analyze"]>;
  reviewStrategy: ReviewStrategy;
}> {
  const complexity = new TaskComplexityAnalyzer().analyze({
    taskText: input.prompt,
  });
  const reviewStrategy = input.config.routing.reviewStrategy as ReviewStrategy;
  const backends = selectReviewerBackends(input.config);
  if (backends.length === 0) {
    throw new Error(
      "No reviewers configured. Add Gemini (API) or Claude (CLI) in Configure → Reviewers.",
    );
  }

  const selectedProfiles = selectReviewers(
    DEFAULT_AGENT_PROFILES,
    reviewStrategy,
    input.prompt,
    {
      min: 1,
      max:
        reviewStrategy === "FULL"
          ? 7
          : Math.max(backends.length, complexity.recommendedCount),
    },
    complexity,
  );
  const profiles =
    selectedProfiles.length > 0
      ? selectedProfiles
      : DEFAULT_AGENT_PROFILES.filter((p) => p.kind === "reviewer");

  const members: Reviewer[] = [];
  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i]!;
    const profile = profiles[i % profiles.length];
    members.push(
      await instantiateBackend(backend, input.config, input.projectPath, {
        onStatus: (message) =>
          input.onStatus?.(
            `[${backend.name ?? backend.provider}${profile ? `/${profile.id}` : ""}] ${message}`,
          ),
        specialtyAddendum: profile
          ? specialtyAddendum(profile.specialty)
          : undefined,
        logicalName: backend.name ?? profile?.id ?? backend.provider,
      }),
    );
  }

  return { members, complexity, reviewStrategy };
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
    model: backend.model ?? resolveReviewerModel(config, backend.provider),
    apiKey: resolvedKey?.secret,
    name: extras.logicalName,
    transport,
    specialtyAddendum: extras.specialtyAddendum,
    ...(backend.fallback
      ? {
          fallback: {
            transport: backend.fallback.transport,
            provider: backend.fallback.provider,
            model:
              backend.fallback.model ??
              (fallbackProvider
                ? resolveReviewerModel(config, fallbackProvider)
                : undefined),
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

export async function runAssentorTask(input: RunAssentorInput) {
  const projectPath = path.resolve(input.projectPath);
  const reporter = new RunReporter({
    verbose: input.verbose,
    executorName: input.executor ?? "executor",
    reviewerName: input.reviewer ?? "reviewer",
  });
  reporter.preparing("loading config…");

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
    return await runAssentorTaskBody(input, projectPath, reporter, {
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
    reporter.dispose();
  }
}

async function runAssentorTaskBody(
  input: RunAssentorInput,
  projectPath: string,
  reporter: RunReporter,
  slots: {
    setExecutor: (executor: Executor) => void;
    setSupervisor: (supervisor: Supervisor) => void;
    setTaskId: (taskId: string) => void;
  },
) {
  const config = await loadAssentorConfig(projectPath, {
    executor: input.executor,
    reviewer: input.reviewer,
    maxRounds: input.maxRounds,
    maxMessages: input.maxMessages,
    mode: input.autopilot ? "autopilot" : input.mode,
  });
  const runMode = config.run.mode;
  const autopilot = runMode === "autopilot";

  const executorProvider = config.executor.provider;
  const backends = selectReviewerBackends(config);
  const reviewerLabel =
    backends.map((b) => `${b.provider}/${b.transport ?? "api"}`).join(", ") ||
    "none";

  if (executorProvider === "project-mutating") {
    throw new Error(
      "project-mutating executor is test-only; use mock or cursor",
    );
  }

  if (!input.skipPreflight) {
    reporter.updatePreparing("checking environment…");
    const preflight = await runPreflight({
      executor: executorProvider,
      reviewers: backends.map((b) => ({
        provider: b.provider,
        transport: b.transport ?? "api",
      })),
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

  const executor = await createExecutor(executorProvider, projectPath, {
    onStatus: (status) => reporter.onExecutorStatus(status),
    timeoutMs: config.limits.maxRuntimeMinutes * 60_000,
  });
  slots.setExecutor(executor);

  const { members: memberReviewers, complexity, reviewStrategy } =
    await createMembersFromBackends({
      config,
      projectPath,
      prompt: input.prompt,
      onStatus: (message) => reporter.onReviewerStatus(message),
    });

  const reviewer: Reviewer =
    reviewStrategy === "SINGLE" || memberReviewers.length <= 1
      ? memberReviewers[0]!
      : new PanelReviewer({
          name: `panel:${reviewStrategy.toLowerCase()}`,
          reviewers: memberReviewers,
          goal: input.prompt,
          acceptanceCriteria: input.acceptanceCriteria ?? [],
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
    onEvent: (event) => {
      reporter.onEvent(event);
    },
  });
  slots.setSupervisor(supervisor);

  const reviewerDisplay = formatReviewerRunLabel(
    reviewer.name,
    backends[0],
  );

  reporter.ready();
  printBanner({
    task: contract.goal,
    round: `0 / ${budgets.limits.maxRounds}`,
    executor: executor.name,
    reviewer: reviewerDisplay,
    mode: runMode,
    status: TaskState.Executing,
  });

  const result = await supervisor.run();

  printBanner({
    task: contract.goal,
    round: `${result.round} / ${budgets.limits.maxRounds}`,
    executor: executor.name,
    reviewer: reviewerDisplay,
    mode: runMode,
    status: result.status,
  });

  return { result, config, store };
}

export async function resumeAssentorTask(input: {
  projectPath: string;
  taskId?: string;
  verbose?: boolean;
}) {
  const projectPath = path.resolve(input.projectPath);
  const reporter = new RunReporter({
    verbose: input.verbose,
    executorName: "executor",
    reviewerName: "reviewer",
  });
  reporter.preparing("loading task to continue…");

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

    reporter.updatePreparing("loading config…");
    const config = await loadAssentorConfig(projectPath);
    const executorProvider = config.executor.provider;
    const backends = selectReviewerBackends(config);

    reporter.updatePreparing("checking environment…");
    const preflight = await runPreflight({
      executor: executorProvider,
      reviewers: backends.map((b) => ({
        provider: b.provider,
        transport: b.transport ?? "api",
      })),
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

    executor = await createExecutor(executorProvider, projectPath, {
      onStatus: (status) => reporter.onExecutorStatus(status),
      timeoutMs: config.limits.maxRuntimeMinutes * 60_000,
    });

    const { members: memberReviewers, reviewStrategy } =
      await createMembersFromBackends({
        config,
        projectPath,
        prompt: resume.snapshot.contract.goal,
        onStatus: (message) => reporter.onReviewerStatus(message),
      });

    const reviewer: Reviewer =
      reviewStrategy === "SINGLE" || memberReviewers.length <= 1
        ? memberReviewers[0]!
        : new PanelReviewer({
            name: `panel:${reviewStrategy.toLowerCase()}`,
            reviewers: memberReviewers,
            goal: resume.snapshot.contract.goal,
            acceptanceCriteria:
              resume.snapshot.contract.acceptanceCriteria ?? [],
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
      onEvent: (event) => reporter.onEvent(event),
    });

    return await supervisor.run();
  } finally {
    detachInterrupt();
    reporter.dispose();
  }
}

export async function statusAssentorTask(projectPath: string, taskId: string) {
  const resume = await loadTaskForResume(path.resolve(projectPath), taskId);
  return resume.snapshot;
}

export async function initAssentorProject(projectPath: string): Promise<string> {
  const { parseAssentorConfig, saveAssentorConfig, assentorConfigPath } =
    await import("../config/load.js");
  const { detectVerificationCommands } = await import(
    "../config/detect-commands.js"
  );
  const { ensureAssentorGitignored } = await import("../persistence/paths.js");
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

export async function doctorAssentor(): Promise<string[]> {
  const lines: string[] = [];
  lines.push(`assentor: v${(await import("../self/version.js")).getLocalVersionSync()}`);
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
    `ASSENTOR_GEMINI_MODEL: ${process.env.ASSENTOR_GEMINI_MODEL ?? "(default gemini-3.6-flash + fallbacks)"}`,
  );

  const { resolveCursorBinary, isCursorAppBinary } = await import(
    "../providers/executors/cursor/index.js"
  );
  const binary = resolveCursorBinary();
  lines.push(`cursor binary: ${binary}`);
  lines.push(
    `cursor invocation: ${isCursorAppBinary(binary) ? `${binary} agent ...` : `${binary} ...`}`,
  );

  return lines;
}

function attachRunInterrupt(input: {
  reporter: RunReporter;
  getExecutor: () => Executor | undefined;
  getTaskId: () => string | undefined;
  getSupervisor: () => Supervisor | undefined;
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

function printBanner(input: {
  task: string;
  round: string;
  executor: string;
  reviewer: string;
  mode?: string;
  status: string;
}): void {
  const task = truncate(input.task, 40);
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";
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
