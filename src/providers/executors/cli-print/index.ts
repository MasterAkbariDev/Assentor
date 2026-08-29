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
import {
  CursorStreamStatusParser,
  isExecutorStreamBlob,
  resolveExecutorFailureMessage,
  summarizeExecutorStreamOutput,
} from "../cursor/stream-status.js";
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
import { TextLineStreamParser } from "./text-stream.js";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RESULT_GRACE_MS = 10_000;

export interface PrintCliChildHandle {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  abandon?: () => void;
}

export interface PrintCliSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  onSpawn?: (child: PrintCliChildHandle) => void;
  /** After stream-json `result`, stop waiting for process exit. */
  resultGraceMs?: number;
}

export interface PrintCliSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: NodeJS.Signals | null;
}

export type PrintCliSpawnFn = (
  request: PrintCliSpawnRequest,
) => Promise<PrintCliSpawnResult>;

export interface PrintCliExecutorOptions {
  recipe: PrintCliRecipe;
  binary?: string;
  timeoutMs?: number;
  resultGraceMs?: number;
  spawnFn?: PrintCliSpawnFn;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  onStatus?: (status: { activity: string; detail: string }) => void;
}

export class PrintCliExecutor implements Executor {
  readonly name: string;
  private readonly recipe: PrintCliRecipe;
  private readonly timeoutMs: number;
  private readonly resultGraceMs: number;
  private readonly spawnFn: PrintCliSpawnFn;
  private readonly onOutput?: PrintCliExecutorOptions["onOutput"];
  private readonly onStatus?: PrintCliExecutorOptions["onStatus"];
  private binary: string;
  private readonly binaryOverride?: string;
  private sessionId?: string;
  private readonly cancelled = new Set<string>();
  private activeChild?: PrintCliChildHandle;
  private forceComplete?: () => void;

  constructor(options: PrintCliExecutorOptions) {
    this.recipe = options.recipe;
    this.name = options.recipe.name;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resultGraceMs = options.resultGraceMs ?? DEFAULT_RESULT_GRACE_MS;
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
    return this.execute(task.taskId, task.projectPath, task.prompt, {
      isContinuation: false,
    });
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
    return this.execute(input.taskId, input.projectPath, prompt, {
      isContinuation: true,
    });
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
    this.activeChild?.abandon?.();
    killProcessTree(this.activeChild);
    this.forceComplete?.();
  }

  private async execute(
    taskId: string,
    projectPath: string,
    prompt: string,
    options: { isContinuation?: boolean } = {},
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
      continueRecent:
        options.isContinuation === true &&
        !this.sessionId &&
        Boolean(this.recipe.continueFlag),
    });

    const useStreamJson = this.recipe.outputFormat === "stream-json";
    const streamParser = useStreamJson
      ? new CursorStreamStatusParser()
      : undefined;
    const textParser = useStreamJson ? undefined : new TextLineStreamParser();

    this.onStatus?.({
      activity: "starting",
      detail: `${this.name} · ${useStreamJson ? "stream-json" : "text"} mode`,
    });

    let capturedStdout = "";
    let capturedStderr = "";
    let forcedResult: PrintCliSpawnResult | undefined;
    const forcedExit = new Promise<PrintCliSpawnResult>((resolve) => {
      this.forceComplete = () => {
        if (forcedResult) {
          return;
        }
        forcedResult = {
          code: this.cancelled.has(taskId) ? null : 0,
          stdout: capturedStdout,
          stderr: capturedStderr,
          signal: "SIGTERM",
        };
        resolve(forcedResult);
      };
    });

    const closeStuckProcess = () => {
      this.onStatus?.({
        activity: "waiting",
        detail: "closing stuck CLI process",
      });
      this.activeChild?.abandon?.();
      killProcessTree(this.activeChild);
      this.forceComplete?.();
    };

    let resultGrace: ReturnType<typeof setTimeout> | undefined;
    const scheduleResultGrace = () => {
      if (resultGrace || this.resultGraceMs <= 0) {
        closeStuckProcess();
        return;
      }
      this.onStatus?.({
        activity: "waiting",
        detail: "result received — waiting for process to exit",
      });
      resultGrace = setTimeout(closeStuckProcess, this.resultGraceMs);
      resultGrace.unref?.();
    };

    let result: PrintCliSpawnResult;
    try {
      result = await Promise.race([
        this.spawnFn({
          command: binary,
          args,
          cwd: projectPath,
          env: {
            ...process.env,
            CI: process.env.CI ?? "1",
            NO_UPDATE_NOTIFIER: "1",
          },
          timeoutMs: this.timeoutMs,
          resultGraceMs: useStreamJson ? this.resultGraceMs : undefined,
          onSpawn: (child) => {
            this.activeChild = child;
          },
          onOutput: (chunk, stream) => {
            if (stream === "stdout") {
              capturedStdout += chunk;
            } else {
              capturedStderr += chunk;
            }
            this.onOutput?.(chunk, stream);

            if (stream === "stdout" && streamParser) {
              for (const update of streamParser.push(chunk)) {
                this.onStatus?.({
                  activity: update.activity,
                  detail: update.detail,
                });
                if (update.sessionId) {
                  this.sessionId = update.sessionId;
                }
                if (update.isFinal) {
                  scheduleResultGrace();
                }
              }
              return;
            }

            const parser = textParser;
            if (!parser) {
              return;
            }
            for (const update of parser.push(chunk)) {
              this.onStatus?.({
                activity: update.activity,
                detail:
                  stream === "stderr"
                    ? `[stderr] ${update.detail}`
                    : update.detail,
              });
            }
          },
        }),
        forcedExit,
      ]);

      if (streamParser) {
        for (const update of streamParser.flush()) {
          this.onStatus?.({
            activity: update.activity,
            detail: update.detail,
          });
          if (update.sessionId) {
            this.sessionId = update.sessionId;
          }
        }
      } else if (textParser) {
        for (const update of textParser.flush()) {
          this.onStatus?.({ activity: update.activity, detail: update.detail });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        summary: `${this.name} failed to start`,
        error: message,
        sessionId: this.sessionId,
      };
    } finally {
      if (resultGrace) {
        clearTimeout(resultGrace);
      }
      this.forceComplete = undefined;
      this.activeChild = undefined;
    }

    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();

    if (this.cancelled.has(taskId)) {
      return {
        status: "cancelled",
        summary: "Interrupted (Ctrl+C)",
        error: "Interrupted (Ctrl+C). Resume with: assentor resume",
        sessionId: this.sessionId,
        rawOutput: result.stdout,
      };
    }

    if (result.timedOut && !streamParser?.hasFinalResult()) {
      return {
        status: "timeout",
        summary: `${this.name} timed out`,
        error: stderr || stdout || "timed out",
        rawOutput: result.stdout,
        sessionId: this.sessionId,
      };
    }

    if (streamParser?.isResultError()) {
      const failure = resolveExecutorFailureMessage({
        executorName: this.name,
        parser: streamParser,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      });
      const resumeHint = this.sessionId
        ? " Resume with: assentor resume"
        : "";
      return {
        status: failure.kind,
        summary: failure.summary,
        error: `${failure.error}${resumeHint}`,
        rawOutput: result.stdout,
        sessionId: this.sessionId,
      };
    }

    const completedViaResult = Boolean(streamParser?.hasFinalResult());
    if (result.code !== 0 && !completedViaResult) {
      const failure = resolveExecutorFailureMessage({
        executorName: this.name,
        parser: streamParser,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      });
      return {
        status: failure.kind,
        summary: failure.summary,
        error: failure.error,
        rawOutput: result.stdout,
        sessionId: this.sessionId,
      };
    }

    const streamSummary = summarizeExecutorStreamOutput(result.stdout);
    const summary =
      streamParser?.getResultText() ||
      streamSummary ||
      (!isExecutorStreamBlob(result.stdout) ? summarizePrintOutput(stdout) : "") ||
      `${this.name} completed`;

    return {
      status: "completed",
      summary,
      rawOutput: result.stdout,
      sessionId: streamParser?.getSessionId() ?? this.sessionId,
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
        windowsHide: true,
      }),
    );

    const parser =
      request.resultGraceMs != null
        ? new CursorStreamStatusParser()
        : undefined;

    let stdout = "";
    let stderr = "";
    let settled = false;
    let resultGrace: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: PrintCliSpawnResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (resultGrace) {
        clearTimeout(resultGrace);
      }
      untrackChildProcess(child);
      resolve(result);
    };

    const abandon = () => {
      killProcessTree(child);
      finish({
        code: parser?.hasFinalResult() ? 0 : null,
        stdout,
        stderr,
        signal: "SIGTERM",
      });
    };

    request.onSpawn?.({
      pid: child.pid,
      kill: (signal) => {
        if (signal === "SIGKILL") {
          killProcessTree(child);
          return true;
        }
        try {
          return child.kill(signal);
        } catch {
          return false;
        }
      },
      abandon,
    });

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ code: null, stdout, stderr, timedOut: true, signal: "SIGTERM" });
    }, request.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      request.onOutput?.(text, "stdout");
      if (parser && request.resultGraceMs != null) {
        for (const update of parser.push(text)) {
          if (update.isFinal && !resultGrace) {
            resultGrace = setTimeout(abandon, request.resultGraceMs);
            resultGrace.unref?.();
          }
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      request.onOutput?.(text, "stderr");
    });
    child.on("error", (error) => {
      if (resultGrace) {
        clearTimeout(resultGrace);
      }
      clearTimeout(timer);
      untrackChildProcess(child);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      finish({ code, stdout, stderr, signal });
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
