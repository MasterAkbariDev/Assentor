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
import { TaskStore, loadTaskForResume } from "../persistence/index.js";
import { CursorExecutor } from "../providers/executors/cursor/index.js";
import { MockExecutor } from "../providers/executors/mock/index.js";
import type { Executor } from "../providers/executors/types.js";
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
  } = {},
): Promise<Executor> {
  switch (provider) {
    case "cursor":
      return new CursorExecutor({
        onOutput: options.onOutput,
        onStatus: options.onStatus,
      });
    case "mock":
      return new MockExecutor();
    default:
      throw new Error(
        `Unknown executor provider "${provider}". Supported: mock, cursor`,
      );
  }
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
    case "gemini-cli":
      throw new Error(
        `Provider "${provider}" requires transport: "cli". Set reviewers[].transport to "cli".`,
      );
    default:
      throw new Error(
        `Unknown reviewer provider "${provider}". Supported: mock, openai, gemini, claude, gemini-cli`,
      );
  }
}

function resolveReviewerModel(
  config: AssentorConfig,
  provider: string,
): string | undefined {
  if (provider === "gemini" || provider === "gemini-cli") {
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

export function buildContract(
  prompt: string,
  acceptanceCriteria: string[] = [],
): TaskContract {
  const base = createEmptyContract(prompt);
  return mergeAcceptanceCriteria(base, acceptanceCriteria);
}

export async function runAssentorTask(input: RunAssentorInput) {
  const projectPath = path.resolve(input.projectPath);
  const config = await loadAssentorConfig(projectPath, {
    executor: input.executor,
    reviewer: input.reviewer,
    maxRounds: input.maxRounds,
    maxMessages: input.maxMessages,
  });

  const executorProvider = config.executor.provider;
  const reviewerConfig = config.reviewers[0];
  const reviewerProvider = reviewerConfig?.provider ?? "mock";
  const reviewerTransport = reviewerConfig?.transport ?? "api";

  if (executorProvider === "project-mutating") {
    throw new Error(
      "project-mutating executor is test-only; use mock or cursor",
    );
  }

  if (!input.skipPreflight) {
    const preflight = await runPreflight({
      executor: executorProvider,
      reviewer: reviewerProvider,
      projectPath,
    });
    printPreflight(preflight);
    if (!preflight.ok) {
      throw new Error(
        "Preflight failed. Fix the issues above, then re-run.\n" +
          "Cursor: `agent login` or set CURSOR_API_KEY\n" +
          "Gemini/OpenAI: assentor → API Keys (global ~/.assentor), or export GEMINI_API_KEY / OPENAI_API_KEY",
      );
    }
  }

  const reporter = new RunReporter({
    verbose: input.verbose,
    executorName: executorProvider,
    reviewerName: reviewerProvider,
  });

  const executor = await createExecutor(executorProvider, projectPath, {
    onStatus: (status) => reporter.onExecutorStatus(status),
  });
  const resolvedKey = reviewerNeedsApiKey(reviewerProvider, reviewerTransport)
    ? await resolveProviderApiKey(reviewerProvider, projectPath)
    : undefined;
  const fallbackProvider = reviewerConfig?.fallback?.provider;
  const fallbackTransport = reviewerConfig?.fallback?.transport ?? "api";
  const fallbackKey =
    fallbackProvider &&
    reviewerNeedsApiKey(fallbackProvider, fallbackTransport)
      ? await resolveProviderApiKey(fallbackProvider, projectPath)
      : undefined;

  const complexity = new TaskComplexityAnalyzer().analyze({
    taskText: input.prompt,
  });
  const reviewStrategy = config.routing.reviewStrategy as ReviewStrategy;
  const selectedProfiles = selectReviewers(
    DEFAULT_AGENT_PROFILES,
    reviewStrategy,
    input.prompt,
    {
      min: 1,
      max:
        reviewStrategy === "FULL"
          ? 7
          : Math.max(4, complexity.recommendedCount),
    },
    complexity,
  );

  const fallbackOpts = reviewerConfig?.fallback
    ? {
        fallback: {
          transport: reviewerConfig.fallback.transport,
          provider: reviewerConfig.fallback.provider,
          model:
            reviewerConfig.fallback.model ??
            (fallbackProvider
              ? resolveReviewerModel(config, fallbackProvider)
              : undefined),
          apiKey: fallbackKey?.secret,
        },
      }
    : {};

  const memberReviewers: Reviewer[] = [];
  for (const profile of selectedProfiles) {
    const member = await createReviewer(reviewerProvider, {
      onStatus: (message) =>
        reporter.onReviewerStatus(`[${profile.id}] ${message}`),
      model: resolveReviewerModel(config, reviewerProvider),
      apiKey: resolvedKey?.secret,
      name: profile.id,
      transport: reviewerTransport,
      specialtyAddendum: specialtyAddendum(profile.specialty),
      ...fallbackOpts,
    });
    memberReviewers.push(member);
  }

  const reviewer: Reviewer =
    reviewStrategy === "SINGLE" || memberReviewers.length <= 1
      ? memberReviewers[0]!
      : new PanelReviewer({
          name: `panel:${reviewStrategy.toLowerCase()}`,
          reviewers: memberReviewers,
          goal: input.prompt,
          acceptanceCriteria: input.acceptanceCriteria ?? [],
        });

  if (resolvedKey) {
    reporter.note(
      `reviewer key: ${resolvedKey.source}${resolvedKey.masked ? ` (${resolvedKey.masked})` : ""}`,
    );
  }
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
    `defaults: ${executorProvider} + ${reviewerProvider}/${reviewerTransport} · routing=${config.routing.strategy}`,
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
    collectExecutorExplanation: true,
    onEvent: (event) => {
      reporter.onEvent(event);
    },
  });

  printBanner({
    task: contract.goal,
    round: `0 / ${budgets.limits.maxRounds}`,
    executor: executor.name,
    reviewer: reviewer.name,
    status: TaskState.Initializing,
  });

  try {
    const result = await supervisor.run();

    printBanner({
      task: contract.goal,
      round: `${result.round} / ${budgets.limits.maxRounds}`,
      executor: executor.name,
      reviewer: reviewer.name,
      status: result.status,
    });

    return { result, config, store };
  } finally {
    reporter.dispose();
  }
}

export async function resumeAssentorTask(input: {
  projectPath: string;
  taskId: string;
  verbose?: boolean;
}) {
  const projectPath = path.resolve(input.projectPath);
  const resume = await loadTaskForResume(projectPath, input.taskId);
  if (!resume.resumable) {
    throw new Error(resume.reason ?? `Task ${input.taskId} is not resumable`);
  }

  const config = await loadAssentorConfig(projectPath);
  const executorProvider = config.executor.provider;
  const reviewerConfig = config.reviewers[0];
  const reviewerProvider = reviewerConfig?.provider ?? "mock";
  const reviewerTransport = reviewerConfig?.transport ?? "api";

  const preflight = await runPreflight({
    executor: executorProvider,
    reviewer: reviewerProvider,
    projectPath,
  });
  printPreflight(preflight);
  if (!preflight.ok) {
    throw new Error("Preflight failed. Fix the issues above, then re-run.");
  }

  const reporter = new RunReporter({
    verbose: input.verbose,
    executorName: executorProvider,
    reviewerName: reviewerProvider,
  });

  const executor = await createExecutor(executorProvider, projectPath, {
    onStatus: (status) => reporter.onExecutorStatus(status),
  });
  const resumeKey = reviewerNeedsApiKey(reviewerProvider, reviewerTransport)
    ? await resolveProviderApiKey(reviewerProvider, projectPath)
    : undefined;
  const fallbackProvider = reviewerConfig?.fallback?.provider;
  const fallbackTransport = reviewerConfig?.fallback?.transport ?? "api";
  const fallbackKey =
    fallbackProvider &&
    reviewerNeedsApiKey(fallbackProvider, fallbackTransport)
      ? await resolveProviderApiKey(fallbackProvider, projectPath)
      : undefined;

  const reviewer = await createReviewer(reviewerProvider, {
    onStatus: (message) => reporter.onReviewerStatus(message),
    model: resolveReviewerModel(config, reviewerProvider),
    apiKey: resumeKey?.secret,
    name: reviewerConfig?.name ?? reviewerProvider,
    transport: reviewerTransport,
    ...(reviewerConfig?.fallback
      ? {
          fallback: {
            transport: reviewerConfig.fallback.transport,
            provider: reviewerConfig.fallback.provider,
            model:
              reviewerConfig.fallback.model ??
              (fallbackProvider
                ? resolveReviewerModel(config, fallbackProvider)
                : undefined),
            apiKey: fallbackKey?.secret,
          },
        }
      : {}),
  });

  try {
    const supervisor = new Supervisor({
      projectPath,
      contract: resume.snapshot.contract,
      executor,
      reviewer,
      store: resume.store,
      resumeFrom: resume.snapshot,
      onEvent: (event) => reporter.onEvent(event),
    });

    return await supervisor.run();
  } finally {
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
  const configPath = assentorConfigPath(projectPath);
  try {
    await fs.access(configPath);
    return configPath;
  } catch {
    // create defaults
  }
  return saveAssentorConfig(projectPath, parseAssentorConfig({}), {
    scope: "project",
  });
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

function printBanner(input: {
  task: string;
  round: string;
  executor: string;
  reviewer: string;
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
