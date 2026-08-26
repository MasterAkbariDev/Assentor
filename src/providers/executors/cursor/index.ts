import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
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
  summarizeStreamJson,
  type AgentStatusUpdate,
} from "./stream-status.js";

export type CursorOutputFormat = "text" | "json" | "stream-json";
export type { AgentStatusUpdate };

export interface CursorSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Live child so Ctrl+C can SIGTERM the Cursor process. */
  onSpawn?: (child: { kill: (signal?: NodeJS.Signals) => boolean }) => void;
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
   * ASSENTOR_CURSOR_BINARY → `cursor` → `agent` → macOS Cursor.app path.
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
}

const DEFAULT_CAPABILITIES: ExecutorCapabilities = {
  canEditFiles: true,
  canRunCommands: true,
  canContinueSession: true,
  supportsScreenshots: false,
};

const MAC_CURSOR_BIN =
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";

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
  private readonly cancelled = new Set<string>();
  private activeChild?: { kill: (signal?: NodeJS.Signals) => boolean };
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
    const prompt = buildContinuationPrompt(input.messages);
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
    try {
      this.activeChild?.kill("SIGTERM");
    } catch {
      // already exited
    }
    setTimeout(() => {
      try {
        this.activeChild?.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1500).unref?.();
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

    let result: CursorSpawnResult;
    try {
      result = await this.spawnFn({
        command: this.binary,
        args,
        cwd: projectPath,
        env,
        timeoutMs: this.timeoutMs,
        onSpawn: (child) => {
          this.activeChild = child;
        },
        onOutput: (chunk, stream) => {
          this.onOutput?.(chunk, stream);
          if (stream === "stdout" && streamParser) {
            for (const update of streamParser.push(chunk)) {
              this.onStatus?.(update);
            }
          }
        },
      });
      if (streamParser) {
        for (const update of streamParser.flush()) {
          this.onStatus?.(update);
        }
      }
    } catch (error) {
      this.activeChild = undefined;
      const message = error instanceof Error ? error.message : String(error);
      const hint = /ENOENT/i.test(message)
        ? " Cursor CLI not found. Install Cursor, ensure `cursor`/`agent` is on PATH, or set ASSENTOR_CURSOR_BINARY."
        : "";
      return {
        status: "failed",
        summary: message + hint,
        error: message + hint,
        sessionId: this.sessionId,
      };
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

    if (result.timedOut) {
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

    if (result.code !== 0) {
      return {
        status: "failed",
        summary: `Cursor agent exited with code ${result.code}`,
        error: result.stderr || result.stdout || `exit ${result.code}`,
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

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min}m`;
}

/** Exported for doctor / tests. */
export function resolveCursorBinary(): string {
  if (process.env.ASSENTOR_CURSOR_BINARY) {
    return process.env.ASSENTOR_CURSOR_BINARY;
  }

  const candidates = [
    process.env.HOME ? `${process.env.HOME}/.local/bin/agent` : "",
    process.env.HOME ? `${process.env.HOME}/.local/bin/cursor-agent` : "",
    "agent",
    "cursor",
    MAC_CURSOR_BIN,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (isExecutable(candidate)) {
        return candidate;
      }
      continue;
    }
    const fromPath = findOnPath(candidate);
    if (fromPath) {
      return fromPath;
    }
  }

  return "cursor";
}

export function isCursorAppBinary(binary: string): boolean {
  const base = path.basename(binary).toLowerCase();
  return base === "cursor" || base === "cursor.exe";
}

function findOnPath(command: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const full = path.join(dir, command);
    if (isExecutable(full)) {
      return full;
    }
  }
  return undefined;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function buildContinuationPrompt(messages: ProtocolMessage[]): string {
  if (messages.length === 0) {
    return "Continue the current task. Apply any outstanding required changes and report what you did.";
  }

  const parts = messages.map((message) => {
    return `[${message.type} from ${message.from}]\n${JSON.stringify(message.content, null, 2)}`;
  });

  return [
    "Continue the Assentor orchestration task.",
    "Address the following supervisor/reviewer messages:",
    ...parts,
    "",
    "Make the necessary project changes, then summarize what you changed.",
  ].join("\n");
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
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: {
        ...request.env,
        // Headless: don't let Cursor's own TTY UI paint over Assentor's spinner.
        CI: request.env.CI ?? "1",
        NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    request.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      finish({
        code: null,
        stdout,
        stderr,
        timedOut: true,
        signal: "SIGTERM",
      });
    }, request.timeoutMs);

    const finish = (result: CursorSpawnResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      request.onOutput?.(text, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      request.onOutput?.(text, "stderr");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
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
