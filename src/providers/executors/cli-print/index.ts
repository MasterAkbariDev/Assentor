import {
  locateBinary,
  spawnCliProcess,
} from "../../../executors/cli-locator.js";
import { killProcessTree } from "../../../process/kill-tree.js";
import {
  trackChildProcess,
  untrackChildProcess,
} from "../../../process/tracker.js";
import {
  buildAutonomousContinuationPrompt,
  buildSupervisedContinuationPrompt,
} from "../../../orchestrator/phase-steering.js";
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorContinuation,
  ExecutorResult,
  ExecutorTask,
} from "../types.js";
import {
  buildPrintCliArgs,
  PRINT_CLI_RECIPES,
  type PrintCliRecipe,
} from "./recipes.js";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface PrintCliSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export interface PrintCliSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type PrintCliSpawnFn = (
  request: PrintCliSpawnRequest,
) => Promise<PrintCliSpawnResult>;

export interface PrintCliExecutorOptions {
  recipe: PrintCliRecipe;
  binary?: string;
  timeoutMs?: number;
  spawnFn?: PrintCliSpawnFn;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  onStatus?: (status: { activity: string; detail: string }) => void;
}

export class PrintCliExecutor implements Executor {
  readonly name: string;
  private readonly recipe: PrintCliRecipe;
  private readonly timeoutMs: number;
  private readonly spawnFn: PrintCliSpawnFn;
  private readonly onOutput?: PrintCliExecutorOptions["onOutput"];
  private readonly onStatus?: PrintCliExecutorOptions["onStatus"];
  private binary: string;
  private readonly binaryOverride?: string;
  private sessionId?: string;
  private readonly cancelled = new Set<string>();

  constructor(options: PrintCliExecutorOptions) {
    this.recipe = options.recipe;
    this.name = options.recipe.name;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? defaultPrintCliSpawn;
    this.onOutput = options.onOutput;
    this.onStatus = options.onStatus;
    this.binaryOverride = options.binary;
    this.binary =
      options.binary ??
      locateBinary(options.recipe.tool) ??
      options.recipe.tool;
  }

  capabilities(): ExecutorCapabilities {
    return {
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: Boolean(this.recipe.resumeFlag),
      supportsScreenshots: false,
    };
  }

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    return this.execute(task.taskId, task.projectPath, task.prompt);
  }

  async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
    if (input.sessionId) {
      this.sessionId = input.sessionId;
    }
    const prompt =
      input.mode === "autopilot"
        ? buildAutonomousContinuationPrompt(
            input.messages,
            input.nextPhaseDirective,
          )
        : buildSupervisedContinuationPrompt(input.messages);
    return this.execute(input.taskId, input.projectPath, prompt);
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
  }

  private async execute(
    taskId: string,
    projectPath: string,
    prompt: string,
  ): Promise<ExecutorResult> {
    if (this.cancelled.has(taskId)) {
      return {
        status: "cancelled",
        summary: `${this.name} executor cancelled`,
        sessionId: this.sessionId,
      };
    }

    const binary =
      this.binaryOverride ?? locateBinary(this.recipe.tool) ?? this.binary;
    this.binary = binary;
    const args = buildPrintCliArgs(this.recipe, prompt, {
      sessionId: this.sessionId,
    });

    this.onStatus?.({
      activity: `Running ${this.name}`,
      detail: `${binary} ${this.recipe.printArgs.join(" ")}`,
    });

    let result: PrintCliSpawnResult;
    try {
      result = await this.spawnFn({
        command: binary,
        args,
        cwd: projectPath,
        env: process.env,
        timeoutMs: this.timeoutMs,
        onOutput: this.onOutput,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        summary: `${this.name} failed to start`,
        error: message,
        sessionId: this.sessionId,
      };
    }

    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.timedOut) {
      return {
        status: "timeout",
        summary: `${this.name} timed out`,
        error: stderr || stdout || "timed out",
        rawOutput: result.stdout,
        sessionId: this.sessionId,
      };
    }

    if (result.code !== 0) {
      return {
        status: "failed",
        summary: `${this.name} exited ${result.code ?? "null"}`,
        error: stderr || stdout || `exit ${result.code}`,
        rawOutput: result.stdout,
        sessionId: this.sessionId,
      };
    }

    return {
      status: "completed",
      summary: summarizePrintOutput(stdout) || `${this.name} completed`,
      rawOutput: result.stdout,
      sessionId: this.sessionId,
    };
  }
}

export function defaultPrintCliSpawn(
  request: PrintCliSpawnRequest,
): Promise<PrintCliSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = trackChildProcess(
      spawnCliProcess(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ code: null, stdout, stderr, timedOut: true });
    }, request.timeoutMs);

    const finish = (result: PrintCliSpawnResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      untrackChildProcess(child);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      request.onOutput?.(text, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      request.onOutput?.(text, "stderr");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      untrackChildProcess(child);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

function summarizePrintOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      result?: string;
      message?: string;
      text?: string;
    };
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // plain text
  }
  const lines = trimmed.split("\n").filter((line) => line.trim());
  return lines.slice(-8).join("\n");
}

export function recipeForExecutorId(id: string): PrintCliRecipe | undefined {
  return PRINT_CLI_RECIPES[id];
}
