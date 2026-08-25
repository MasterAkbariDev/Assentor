import { promises as fs } from "node:fs";
import path from "node:path";
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
import { GeminiReviewer } from "../providers/reviewers/gemini/index.js";
import { MockReviewer } from "../providers/reviewers/mock/index.js";
import { OpenAICompatibleReviewer } from "../providers/reviewers/openai/index.js";
import type { Reviewer } from "../providers/reviewers/types.js";
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

export async function createReviewer(
  provider: string,
  options: {
    onStatus?: (message: string) => void;
    model?: string;
    apiKey?: string;
  } = {},
): Promise<Reviewer> {
  const model =
    options.model && options.model !== "AUTO" ? options.model : undefined;
  switch (provider) {
    case "mock":
      return new MockReviewer({ steps: [{ type: "pass" }] });
    case "openai":
      return new OpenAICompatibleReviewer({
        ...(model ? { model } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      });
    case "gemini":
      return new GeminiReviewer({
        onStatus: options.onStatus,
        ...(model ? { model } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      });
    default:
      throw new Error(
        `Unknown reviewer provider "${provider}". Supported: mock, openai, gemini`,
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
  const reviewerProvider = config.reviewers[0]?.provider ?? "mock";

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
  const resolvedKey =
    reviewerProvider === "mock"
      ? undefined
      : await resolveProviderApiKey(reviewerProvider, projectPath);
  const reviewer = await createReviewer(reviewerProvider, {
    onStatus: (message) => reporter.onReviewerStatus(message),
    model: resolveReviewerModel(config, reviewerProvider),
    apiKey: resolvedKey?.secret,
  });
  if (resolvedKey) {
    reporter.note(
      `reviewer key: ${resolvedKey.source}${resolvedKey.masked ? ` (${resolvedKey.masked})` : ""}`,
    );
  }
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
    reviewers: [reviewer.name],
  });

  reporter.note(`task id: ${taskId}`);
  reporter.note(`project: ${projectPath}`);
  reporter.note(
    `defaults: ${executorProvider} + ${reviewerProvider} · routing=${config.routing.strategy}`,
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
  const reviewerProvider = config.reviewers[0]?.provider ?? "mock";

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
  const resumeKey =
    reviewerProvider === "mock"
      ? undefined
      : await resolveProviderApiKey(reviewerProvider, projectPath);
  const reviewer = await createReviewer(reviewerProvider, {
    onStatus: (message) => reporter.onReviewerStatus(message),
    model: resolveReviewerModel(config, reviewerProvider),
    apiKey: resumeKey?.secret,
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
