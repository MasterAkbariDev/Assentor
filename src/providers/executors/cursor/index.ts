import path from "node:path";
import { createId } from "../../../core/ids.js";
import { MessageType, type ProtocolMessage } from "../../../protocol/messages.js";
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorContinuation,
  ExecutorResult,
  ExecutorTask,
} from "../types.js";
import {
  CursorStreamStatusParser,
  resolveExecutorFailureMessage,
  summarizeStreamJson,
  type AgentStatusUpdate,
} from "./stream-status.js";
import { locateBinary, spawnCliProcess } from "../../../executors/cli-locator.js";
import { killProcessTree } from "../../../process/kill-tree.js";
import {
  killAllTrackedProcesses,
  trackChildProcess,
  untrackChildProcess,
} from "../../../process/tracker.js";
import { buildAutonomousContinuationPrompt, buildSupervisedContinuationPrompt } from "../../../orchestrator/phase-steering.js";

export type CursorOutputFormat = "text" | "json" | "stream-json";
export type { AgentStatusUpdate };

export interface CursorSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** After a stream-json `result` event, stop waiting for process exit. */
  resultGraceMs?: number;
  /** Live child so Ctrl+C can stop the Cursor process. */
  onSpawn?: (child: CursorChildHandle) => void;
}

export interface CursorChildHandle {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  /** Resolve spawn without waiting for the OS process to exit. */
  abandon?: () => void;
}

export interface CursorSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: NodeJS.Signals | null;
}

export type CursorSpawnFn = (
  request: CursorSpawnRequest,
) => Promise<CursorSpawnResult>;

export interface CursorExecutorOptions {
  /**
   * CLI binary. Defaults to auto-detect:
   * env → cached config path → PATH (with Windows PATHEXT) → well-known install dirs.
   */
  binary?: string;
  /** Kill the process after this many ms. Default: 60 minutes. */
  timeoutMs?: number;
  /** Pass `--force` / `--yolo` so the agent can edit files. Default: true */
  force?: boolean;
  /** Pass `--trust` for headless workspace trust. Default: true */
  trust?: boolean;
  /**
   * Default `stream-json` so Assentor can show live tool status.
   * Override with ASSENTOR_CURSOR_OUTPUT_FORMAT or options.
   */
  outputFormat?: CursorOutputFormat;
  apiKey?: string;
  /** Extra CLI args appended before the prompt. */
  extraArgs?: string[];
  /** Injectable process runner for tests. */
  spawnFn?: CursorSpawnFn;
  name?: string;
  /** Live stdout/stderr from the Cursor process (raw). */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Parsed live status from stream-json events. */
  onStatus?: (status: AgentStatusUpdate) => void;
  /**
   * After Cursor emits a stream-json `result` event, wait this long for the
   * process to exit, then SIGTERM it. Default 10s.
   * The CLI often hangs on "finishing up" after the result is already written.
   */
  resultGraceMs?: number;
}

const DEFAULT_CAPABILITIES: ExecutorCapabilities = {
  canEditFiles: true,
  canRunCommands: true,
  canContinueSession: true,
  supportsScreenshots: false,
};

/**
 * Cursor CLI executor adapter.
 *
 * Uses non-interactive print mode (no GUI automation):
 * - `cursor agent -p --force ...` (Cursor.app CLI)
 * - or standalone `agent -p --force ...`
 */
export class CursorExecutor implements Executor {
  readonly name: string;
  private readonly binary: string;
  private readonly usesCursorSubcommand: boolean;
  private readonly timeoutMs: number;
  private readonly force: boolean;
  private readonly trust: boolean;
  private readonly outputFormat: CursorOutputFormat;
  private readonly apiKey?: string;
  private readonly extraArgs: string[];
  private readonly spawnFn: CursorSpawnFn;
  private readonly onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  private readonly onStatus?: (status: AgentStatusUpdate) => void;
  private readonly resultGraceMs: number;
  private readonly cancelled = new Set<string>();
  private activeChild?: CursorChildHandle;
  private forceComplete?: () => void;
  private sessionId = createId();
  callCount = 0;
  lastCommand?: { command: string; args: string[]; cwd: string };

  constructor(options: CursorExecutorOptions = {}) {
    this.name = options.name ?? "cursor";
    this.binary = options.binary ?? resolveCursorBinary();
    this.usesCursorSubcommand = isCursorAppBinary(this.binary);
    this.timeoutMs =
      options.timeoutMs ??
      envTimeoutMs() ??
      60 * 60 * 1000;
    this.force = options.force ?? true;
    this.trust = options.trust ?? true;
    this.outputFormat =
      options.outputFormat ??
      (process.env.ASSENTOR_CURSOR_OUTPUT_FORMAT as CursorOutputFormat | undefined) ??
      "stream-json";
    this.apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
    this.extraArgs = options.extraArgs ?? [];
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.onOutput = options.onOutput;
    this.onStatus = options.onStatus;
    this.resultGraceMs =
      options.resultGraceMs ?? envResultGraceMs() ?? 10_000;
  }

  capabilities(): ExecutorCapabilities {
    return { ...DEFAULT_CAPABILITIES };
  }

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    return this.execute(
      task.taskId,
      task.projectPath,
      task.prompt,
      task.messages ?? [],
      false,
    );
  }

  async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
    if (input.sessionId) {
      this.sessionId = input.sessionId;
    }
    const prompt = buildContinuationPrompt(
      input.messages,
      input.nextPhaseDirective,
      input.mode,
    );
    return this.execute(
      input.taskId,
      input.projectPath,
      prompt,
      input.messages,
      true,
    );
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
    this.activeChild?.abandon?.();
    killProcessTree(this.activeChild);
    killAllTrackedProcesses();
    this.forceComplete?.();
  }

  private async execute(
    taskId: string,
    projectPath: string,
    prompt: string,
    messages: ProtocolMessage[],
    isContinuation: boolean,
  ): Promise<ExecutorResult> {
    this.callCount += 1;

    if (this.cancelled.has(taskId)) {
      return {
        status: "cancelled",
        summary: "Cursor executor cancelled",
        sessionId: this.sessionId,
      };
    }

    const args = this.buildArgs(projectPath, prompt, isContinuation);
    this.lastCommand = { command: this.binary, args, cwd: projectPath };

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.apiKey) {
      env.CURSOR_API_KEY = this.apiKey;
    }

    const streamParser =
      this.outputFormat === "stream-json"
        ? new CursorStreamStatusParser()
        : undefined;

    let resultGrace: ReturnType<typeof setTimeout> | undefined;
    let capturedStdout = "";
    let capturedStderr = "";
    let forcedResult: CursorSpawnResult | undefined;
    const forcedExit = new Promise<CursorSpawnResult>((resolve) => {
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
        detail: "closing stuck Cursor process",
      });
      this.activeChild?.abandon?.();
      killProcessTree(this.activeChild);
      this.forceComplete?.();
    };
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

    let result: CursorSpawnResult;
    try {
      result = await Promise.race([
        this.spawnFn({
          command: this.binary,
          args,
          cwd: projectPath,
          env,
          timeoutMs: this.timeoutMs,
          resultGraceMs: this.resultGraceMs,
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
                this.onStatus?.(update);
                if (update.isFinal) {
                  scheduleResultGrace();
                }
              }
            }
          },
        }),
        forcedExit,
      ]);
      if (streamParser) {
        for (const update of streamParser.flush()) {
          this.onStatus?.(update);
        }
      }
    } catch (error) {
      this.activeChild = undefined;
      const message = error instanceof Error ? error.message : String(error);
      const hint = /ENOENT/i.test(message)
        ? " Cursor CLI not found. Install Cursor, ensure `cursor`/`agent` is on PATH, or set ASSENTOR_CURSOR_BINARY. On Windows the standalone CLI is usually %LOCALAPPDATA%\\cursor-agent\\agent.cmd."
        : "";
      return {
        status: "failed",
        summary: message + hint,
        error: message + hint,
        sessionId: this.sessionId,
      };
    } finally {
      if (resultGrace) {
        clearTimeout(resultGrace);
      }
      this.forceComplete = undefined;
    }
    this.activeChild = undefined;

    const combined = `${result.stdout}\n${result.stderr}`;

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
        summary: `Cursor agent timed out after ${this.timeoutMs}ms`,
        error:
          `Cursor was still working when Assentor stopped it after ${formatDuration(this.timeoutMs)}. ` +
          `Resume with: assentor resume ${taskId}`,
        sessionId: this.sessionId,
        rawOutput: result.stdout,
      };
    }

    if (/Authentication required/i.test(combined)) {
      return {
        status: "failed",
        summary: "Cursor authentication required",
        error:
          "Cursor authentication required. Run `agent login` or `cursor agent login`, or set CURSOR_API_KEY. " +
          `Then: assentor resume ${taskId}`,
        sessionId: this.sessionId,
        rawOutput: result.stdout,
      };
    }

    if (this.cancelled.has(taskId)) {
      return {
        status: "cancelled",
        summary: "Cursor executor cancelled",
        sessionId: this.sessionId,
        rawOutput: result.stdout,
      };
    }

    const parsedSession =
      streamParser?.getSessionId() ?? extractSessionId(result.stdout);
    if (parsedSession) {
      this.sessionId = parsedSession;
    }

    const completedViaResult = Boolean(streamParser?.hasFinalResult());
    if (streamParser?.isResultError()) {
      const failure = resolveExecutorFailureMessage({
        executorName: "Cursor",
        parser: streamParser,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      });
      return {
        status: failure.kind,
        summary: failure.summary,
        error: failure.error,
        sessionId: this.sessionId,
        rawOutput: result.stdout,
      };
    }

    if (result.code !== 0 && !completedViaResult) {
      const failure = resolveExecutorFailureMessage({
        executorName: "Cursor",
        parser: streamParser,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      });
      return {
        status: failure.kind,
        summary: failure.summary,
        error: failure.error,
        sessionId: this.sessionId,
        rawOutput: result.stdout,
      };
    }

    const summary =
      (streamParser?.getResultText() ||
        summarizeStreamJson(result.stdout).summary ||
        summarizeOutput(result.stdout)) ||
      "Cursor agent completed";
    return {
      status: "completed",
      summary,
      sessionId: this.sessionId,
      rawOutput: result.stdout,
      messages: maybeAckEvidence(messages, this.sessionId),
    };
  }

  private buildArgs(
    projectPath: string,
    prompt: string,
    isContinuation: boolean,
  ): string[] {
    const args: string[] = [];

    if (this.usesCursorSubcommand) {
      args.push("agent");
    }

    args.push("-p", "--print");

    if (this.force) {
      args.push("--force");
    }
    if (this.trust) {
      args.push("--trust");
    }

    args.push("--workspace", projectPath);
    args.push("--output-format", this.outputFormat);

    if (isContinuation) {
      args.push("--resume", this.sessionId);
    }

    args.push(...this.extraArgs);
    args.push(prompt);
    return args;
  }
}

function envTimeoutMs(): number | undefined {
  const raw = process.env.ASSENTOR_CURSOR_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function envResultGraceMs(): number | undefined {
  const raw = process.env.ASSENTOR_CURSOR_RESULT_GRACE_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min}m`;
}

/** Exported for doctor / tests. */
export function resolveCursorBinary(): string {
  return locateBinary("cursor") ?? "cursor";
}

export function isCursorAppBinary(binary: string): boolean {
  const base = path
    .basename(binary)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/i, "");
  return base === "cursor";
}

export function buildContinuationPrompt(
  messages: ProtocolMessage[],
  nextPhaseDirective?: string,
  mode: "supervised" | "autopilot" = "supervised",
): string {
  if (mode === "autopilot") {
    return buildAutonomousContinuationPrompt(messages, nextPhaseDirective);
  }
  return buildSupervisedContinuationPrompt(messages);
}

function summarizeOutput(stdout: string): string {
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
    if (typeof parsed.result === "string") {
      return parsed.result;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
    if (typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // plain text
  }

  const lines = trimmed.split("\n").filter((line) => line.trim());
  const last = lines.at(-1) ?? trimmed;
  return last;
}

function extractSessionId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      session_id?: string;
      sessionId?: string;
      chatId?: string;
      id?: string;
    };
    return parsed.session_id ?? parsed.sessionId ?? parsed.chatId ?? parsed.id;
  } catch {
    const match = stdout.match(
      /(?:session[_-]?id|chat[_-]?id)\s*[:=]\s*([A-Za-z0-9_-]+)/i,
    );
    return match?.[1];
  }
}

function maybeAckEvidence(
  inbound: ProtocolMessage[],
  sessionId: string,
): ProtocolMessage[] | undefined {
  const request = inbound.find(
    (message) =>
      message.type === MessageType.EvidenceRequest ||
      message.type === MessageType.InvestigationRequest,
  );
  if (!request) {
    return undefined;
  }

  return [
    {
      messageId: createId(),
      conversationId: request.conversationId,
      round: request.round,
      from: "executor",
      to: "reviewer",
      type: MessageType.EvidenceResponse,
      requiresResponse: false,
      timestamp: new Date().toISOString(),
      content: {
        inReplyTo: request.messageId,
        notes: `Cursor session ${sessionId} completed the requested investigation.`,
        artifacts: [
          {
            kind: "log",
            description: "Cursor executor completion acknowledgment",
            content:
              "Investigation/evidence handling delegated to Cursor agent output.",
          },
        ],
      },
    },
  ];
}

export async function defaultSpawn(
  request: CursorSpawnRequest,
): Promise<CursorSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = trackChildProcess(
      spawnCliProcess(request.command, request.args, {
        cwd: request.cwd,
        env: {
          ...request.env,
          // Headless: don't let Cursor's own TTY UI paint over Assentor's spinner.
          CI: request.env.CI ?? "1",
          NO_UPDATE_NOTIFIER: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );

    const parser = new CursorStreamStatusParser();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let resultGrace: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CursorSpawnResult) => {
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
      killAllTrackedProcesses();
      finish({
        code: parser.hasFinalResult() ? 0 : null,
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
      finish({
        code: null,
        stdout,
        stderr,
        timedOut: true,
        signal: "SIGTERM",
      });
    }, request.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      request.onOutput?.(text, "stdout");
      for (const update of parser.push(text)) {
        if (update.isFinal && !resultGrace) {
          const grace = request.resultGraceMs ?? 10_000;
          resultGrace = setTimeout(abandon, grace);
          resultGrace.unref?.();
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
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        untrackChildProcess(child);
        reject(error);
      }
    });
    child.on("exit", (code, signal) => {
      finish({ code, stdout, stderr, signal });
    });
    child.on("close", (code, signal) => {
      finish({ code, stdout, stderr, signal });
    });
  });
}

export { killProcessTree } from "../../../process/kill-tree.js";
export { killAllTrackedProcesses } from "../../../process/tracker.js";
