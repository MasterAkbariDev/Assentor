import {
  findOnPath,
  locateBinary,
  spawnCliProcess,
} from "../../../executors/cli-locator.js";
import {
  asReviewInput,
  buildReviewPrompt,
  reviewResultFromModelText,
} from "../shared/prompt.js";
import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "../types.js";

export type CliReviewerAdapter = "claude" | "gemini-cli" | "mock";

export interface CliSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export interface CliSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: NodeJS.Signals | null;
}

export type CliSpawnFn = (request: CliSpawnRequest) => Promise<CliSpawnResult>;

/**
 * Pluggable CLI transport — production spawns a binary; tests use MockCliTransport.
 */
export interface CliTransport {
  readonly adapter: CliReviewerAdapter;
  run(input: {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<CliSpawnResult>;
}

export interface MockCliTransportStep {
  /** Successful stdout (typically JSON review result). */
  stdout?: string;
  stderr?: string;
  code?: number | null;
  timedOut?: boolean;
  /** If set, run() rejects with this message. */
  throwMessage?: string;
}

export interface MockCliTransportOptions {
  adapter?: CliReviewerAdapter;
  /** Scripted responses consumed in order. When exhausted, returns empty failure. */
  steps?: MockCliTransportStep[];
}

/**
 * Deterministic CLI transport for tests — never spawns a child process.
 */
export class MockCliTransport implements CliTransport {
  readonly adapter: CliReviewerAdapter;
  private readonly steps: MockCliTransportStep[];
  private index = 0;
  callCount = 0;
  lastPrompt?: string;

  constructor(options: MockCliTransportOptions = {}) {
    this.adapter = options.adapter ?? "mock";
    this.steps = [...(options.steps ?? [])];
  }

  async run(input: {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<CliSpawnResult> {
    this.callCount += 1;
    this.lastPrompt = input.prompt;
    const step = this.steps[this.index];
    this.index += 1;

    if (!step) {
      return {
        code: 1,
        stdout: "",
        stderr: "MockCliTransport: no scripted steps remaining",
      };
    }

    if (step.throwMessage) {
      throw new Error(step.throwMessage);
    }

    return {
      code: step.code ?? 0,
      stdout: step.stdout ?? "",
      stderr: step.stderr ?? "",
      timedOut: step.timedOut,
    };
  }
}

export interface ProcessCliTransportOptions {
  adapter: Exclude<CliReviewerAdapter, "mock">;
  binary?: string;
  extraArgs?: string[];
  spawnFn?: CliSpawnFn;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawns Claude Code or Gemini CLI with a pack-aware review prompt.
 */
export class ProcessCliTransport implements CliTransport {
  readonly adapter: Exclude<CliReviewerAdapter, "mock">;
  private readonly binary: string;
  private readonly extraArgs: string[];
  private readonly spawnFn: CliSpawnFn;
  private readonly env?: NodeJS.ProcessEnv;
  lastCommand?: { command: string; args: string[]; cwd: string };

  constructor(options: ProcessCliTransportOptions) {
    this.adapter = options.adapter;
    this.binary = options.binary ?? resolveCliBinary(options.adapter);
    this.extraArgs = options.extraArgs ?? [];
    this.spawnFn = options.spawnFn ?? defaultCliSpawn;
    this.env = options.env;
  }

  async run(input: {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<CliSpawnResult> {
    const args = buildCliArgs(this.adapter, input.prompt, this.extraArgs);
    this.lastCommand = { command: this.binary, args, cwd: input.cwd };
    return this.spawnFn({
      command: this.binary,
      args,
      cwd: input.cwd,
      env: { ...process.env, ...this.env, ...input.env },
      timeoutMs: input.timeoutMs,
    });
  }
}

export interface CliReviewerOptions {
  name?: string;
  adapter?: CliReviewerAdapter;
  /** Injectable transport (MockCliTransport for tests). */
  transport?: CliTransport;
  binary?: string;
  extraArgs?: string[];
  spawnFn?: CliSpawnFn;
  timeoutMs?: number;
  specialtyAddendum?: string;
  onStatus?: (message: string) => void;
}

/**
 * Reviewer that reaches a coding-agent CLI (Claude / Gemini CLI / mock).
 * Logical agent identity is owned by the caller (`name`); this class is transport only.
 */
export class CliReviewer implements Reviewer {
  readonly name: string;
  readonly adapter: CliReviewerAdapter;
  private readonly transport: CliTransport;
  private readonly timeoutMs: number;
  private readonly specialtyAddendum?: string;
  private readonly onStatus?: (message: string) => void;
  callCount = 0;

  constructor(options: CliReviewerOptions = {}) {
    this.name = options.name ?? "cli-reviewer";
    this.adapter = options.adapter ?? options.transport?.adapter ?? "mock";
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.specialtyAddendum = options.specialtyAddendum;
    this.onStatus = options.onStatus;

    if (options.transport) {
      this.transport = options.transport;
    } else if (this.adapter === "mock") {
      this.transport = new MockCliTransport({
        steps: [
          {
            stdout: JSON.stringify({
              status: "PASS",
              confidence: 0.9,
              summary: "Mock CLI reviewer PASS",
              issues: [],
              requiredChanges: [],
              optionalChanges: [],
              evidenceRequests: [],
            }),
          },
        ],
      });
    } else {
      this.transport = new ProcessCliTransport({
        adapter: this.adapter,
        binary: options.binary,
        extraArgs: options.extraArgs,
        spawnFn: options.spawnFn,
      });
    }
  }

  async review(input: ReviewInput): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  async continue(input: ReviewContinuation): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  private async turn(
    input: ReviewInput | ReviewContinuation,
  ): Promise<ReviewerTurnResult> {
    this.callCount += 1;
    const prompt = buildReviewPrompt({
      ...asReviewInput(input),
      specialtyAddendum: this.specialtyAddendum,
    });

    this.onStatus?.(
      `Calling ${this.adapter} CLI reviewer (${this.name})…`,
    );

    let result: CliSpawnResult;
    try {
      result = await this.transport.run({
        prompt,
        cwd: input.projectPath,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /ENOENT/i.test(message)
        ? ` CLI binary for ${this.adapter} not found. Install it or set ASSENTOR_${this.adapter === "claude" ? "CLAUDE" : "GEMINI_CLI"}_BINARY.`
        : "";
      return { error: message + hint };
    }

    if (result.timedOut) {
      return {
        error: `${this.adapter} CLI timed out after ${this.timeoutMs}ms`,
        rawOutput: result.stdout || result.stderr,
      };
    }

    if (result.code !== 0 && !result.stdout.trim()) {
      return {
        error:
          result.stderr ||
          `${this.adapter} CLI exited with code ${result.code}`,
        rawOutput: result.stdout || result.stderr,
      };
    }

    const parsed = reviewResultFromModelText(result.stdout || result.stderr);
    if (parsed.error && result.code !== 0) {
      return {
        error:
          parsed.error ||
          result.stderr ||
          `${this.adapter} CLI exited with code ${result.code}`,
        rawOutput: result.stdout || result.stderr,
      };
    }

    this.onStatus?.(`${this.adapter} CLI reviewer responded`);
    return parsed;
  }
}

export function resolveCliAdapter(
  provider: string,
): CliReviewerAdapter {
  const p = provider.toLowerCase();
  if (p === "claude" || p === "claude-code") {
    return "claude";
  }
  if (p === "gemini-cli" || p === "gemini") {
    return "gemini-cli";
  }
  if (p === "mock") {
    return "mock";
  }
  throw new Error(
    `Provider "${provider}" does not support CLI transport. Use claude, gemini-cli, or mock.`,
  );
}

export function resolveCliBinary(adapter: Exclude<CliReviewerAdapter, "mock">): string {
  if (adapter === "claude") {
    return locateBinary("claude") ?? findOnPath("claude") ?? "claude";
  }
  return locateBinary("gemini") ?? findOnPath("gemini") ?? "gemini";
}

function buildCliArgs(
  adapter: Exclude<CliReviewerAdapter, "mock">,
  prompt: string,
  extraArgs: string[],
): string[] {
  if (adapter === "claude") {
    // Claude Code print mode — ask for JSON-only review output in the prompt.
    return ["-p", "--output-format", "text", ...extraArgs, prompt];
  }
  // Gemini CLI non-interactive prompt
  return ["-p", ...extraArgs, prompt];
}

export async function defaultCliSpawn(
  request: CliSpawnRequest,
): Promise<CliSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCliProcess(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

    const finish = (result: CliSpawnResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
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
