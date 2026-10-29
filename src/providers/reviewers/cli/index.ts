import {
  findOnPath,
  locateBinary,
  spawnCliProcess,
  type HostEnv,
} from "../../../executors/cli-locator.js";
import { requestedModel } from "../../executors/cli-print/recipes.js";
import { isCursorAppBinary } from "../../executors/cursor/index.js";
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

export type CliReviewerAdapter = "claude" | "antigravity" | "cursor" | "codex" | "mock";

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
  /** Model for the next `run`. Absent when the transport cannot switch models. */
  setModel?(model: string): void;
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
  /** Model id passed as the CLI's model flag. `AUTO`, blank, or unset means the CLI default. */
  model?: string;
}

/**
 * Reviewers are read-only (Danger list #3): no flag that skips approvals,
 * lifts a sandbox or forces writes may reach a reviewer CLI.
 */
const FORBIDDEN_REVIEWER_ARG =
  /dangerously|bypass|yolo|^--force\b|^-f$|full-auto|sandbox|danger-full-access|workspace-write|^-s$|approve-for-me|permission-mode|accept-?edits|allowed-?tools/i;

/** Throws if any of `args` would grant a reviewer CLI edit or unattended rights. */
export function assertReadOnlyReviewerArgs(args: readonly string[]): void {
  const bad = args.filter((arg) => FORBIDDEN_REVIEWER_ARG.test(arg));
  if (bad.length > 0) {
    throw new Error(
      `Refusing reviewer CLI flags that grant edit or unattended rights: ${bad.join(" ")}`,
    );
  }
}

/**
 * Spawns Claude Code, Antigravity, Cursor or Codex CLI with a pack-aware review prompt.
 */
export class ProcessCliTransport implements CliTransport {
  readonly adapter: Exclude<CliReviewerAdapter, "mock">;
  private readonly binary: string;
  private readonly extraArgs: string[];
  private readonly spawnFn: CliSpawnFn;
  private readonly env?: NodeJS.ProcessEnv;
  private model?: string;
  lastCommand?: { command: string; args: string[]; cwd: string };

  constructor(options: ProcessCliTransportOptions) {
    this.adapter = options.adapter;
    this.binary = options.binary ?? resolveCliBinary(options.adapter);
    this.extraArgs = options.extraArgs ?? [];
    assertReadOnlyReviewerArgs(this.extraArgs);
    this.spawnFn = options.spawnFn ?? defaultCliSpawn;
    this.env = options.env;
    this.model = options.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async run(input: {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<CliSpawnResult> {
    const args = buildCliArgs(this.adapter, input.prompt, this.extraArgs, {
      cwd: input.cwd,
      binary: this.binary,
      model: this.model,
    });
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
  /** Model id for the CLI's model flag. `AUTO`, blank, or unset means the CLI default. */
  model?: string;
}

/**
 * Reviewer that reaches a coding-agent CLI (Claude / Antigravity / Cursor / Codex / mock).
 * Logical agent identity is owned by the caller (`name`); this class is transport only.
 */
export class CliReviewer implements Reviewer {
  readonly name: string;
  readonly adapter: CliReviewerAdapter;
  private readonly transport: CliTransport;
  private readonly timeoutMs: number;
  private readonly specialtyAddendum?: string;
  private readonly onStatus?: (message: string) => void;
  /** Present only when the transport can switch models. */
  readonly setModel?: (model: string) => void;
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
        model: options.model,
      });
    }
    const transport = this.transport;
    if (transport.setModel) {
      this.setModel = (model) => transport.setModel!(model);
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
      const hint = /ENOENT/i.test(message) && this.adapter !== "mock"
        ? ` CLI binary for ${this.adapter} not found. Install it or set ${BINARY_ENV[this.adapter]}.`
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

/** Env var that points at each adapter's binary (see `TOOL_ENV` in cli-locator). */
const BINARY_ENV: Record<Exclude<CliReviewerAdapter, "mock">, string> = {
  claude: "ASSENTOR_CLAUDE_BINARY",
  antigravity: "ASSENTOR_AGY_BINARY",
  cursor: "ASSENTOR_CURSOR_BINARY",
  codex: "ASSENTOR_CODEX_BINARY",
};

export function resolveCliAdapter(
  provider: string,
): CliReviewerAdapter {
  const p = provider.toLowerCase();
  if (p === "claude" || p === "claude-code") {
    return "claude";
  }
  if (p === "antigravity" || p === "agy" || p === "gemini-cli" || p === "gemini") {
    return "antigravity";
  }
  if (p === "cursor" || p === "cursor-agent" || p === "agent") {
    return "cursor";
  }
  if (p === "codex") {
    return "codex";
  }
  if (p === "mock") {
    return "mock";
  }
  throw new Error(
    `Provider "${provider}" does not support CLI transport. Use claude, antigravity, cursor, codex, or mock.`,
  );
}

export function resolveCliBinary(adapter: Exclude<CliReviewerAdapter, "mock">): string {
  if (adapter === "claude") {
    return locateBinary("claude") ?? findOnPath("claude") ?? "claude";
  }
  if (adapter === "cursor") {
    return locateBinary("cursor") ?? findOnPath("agent") ?? "agent";
  }
  if (adapter === "codex") {
    return locateBinary("codex") ?? findOnPath("codex") ?? "codex";
  }
  return locateBinary("agy") ?? findOnPath("agy") ?? "agy";
}

export function isCliReviewerAvailable(
  provider: string,
  options: { host?: Partial<HostEnv> } = {},
): boolean {
  try {
    const adapter = resolveCliAdapter(provider);
    if (adapter === "mock") {
      return true;
    }
    const tool =
      adapter === "claude"
        ? "claude"
        : adapter === "cursor"
          ? "cursor"
          : adapter === "codex"
            ? "codex"
            : "agy";
    return Boolean(locateBinary(tool, { ...options, persist: false }));
  } catch {
    return false;
  }
}

function buildCliArgs(
  adapter: Exclude<CliReviewerAdapter, "mock">,
  prompt: string,
  extraArgs: string[],
  context: { cwd?: string; binary?: string; model?: string } = {},
): string[] {
  const model = requestedModel(context.model);
  const modelArgs = model ? ["--model", model] : [];
  if (adapter === "claude") {
    return ["-p", "--output-format", "text", ...modelArgs, ...extraArgs, prompt];
  }
  if (adapter === "cursor") {
    const args: string[] = [];
    if (context.binary && isCursorAppBinary(context.binary)) {
      args.push("agent");
    }
    args.push("-p", "--print", "--trust");
    if (context.cwd) {
      args.push("--workspace", context.cwd);
    }
    args.push("--output-format", "text", ...modelArgs, ...extraArgs, prompt);
    return args;
  }
  if (adapter === "codex") {
    // Reviewers must not edit the project. `codex exec` is read-only only by
    // default: `sandbox_mode` in ~/.codex/config.toml or a profile can widen it,
    // so pin the sandbox on the command line, which wins over config. Unlike the
    // codex executor recipe, a reviewer never gets
    // --dangerously-bypass-approvals-and-sandbox or --full-auto.
    const codexModel = model ? ["-m", model] : [];
    return [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      ...codexModel,
      ...extraArgs,
      prompt,
    ];
  }
  return [...modelArgs, ...extraArgs, `-p=${prompt}`];
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
