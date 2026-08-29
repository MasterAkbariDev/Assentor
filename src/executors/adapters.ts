import { locateBinary } from "./cli-locator.js";
import {
  CursorExecutor,
  type CursorExecutorOptions,
} from "../providers/executors/cursor/index.js";
import { PrintCliExecutor } from "../providers/executors/cli-print/index.js";
import { PRINT_CLI_RECIPES } from "../providers/executors/cli-print/recipes.js";
import type {
  ExecutorContinuation,
  ExecutorResult,
  ExecutorTask,
} from "../providers/executors/types.js";
import {
  CliExecutorAdapter,
  ExecutorRegistry,
  type DetectionResult,
  type ExecutorAdapter,
  type InstallPlan,
} from "./registry.js";

export interface ExecutorRuntimeOptions {
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  onStatus?: (status: { activity: string; detail: string }) => void;
  timeoutMs?: number;
}

export class CursorExecutorAdapter implements ExecutorAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
  private readonly inner: CursorExecutor;

  constructor(options: CursorExecutorOptions | ExecutorRuntimeOptions = {}) {
    this.inner = new CursorExecutor({
      ...options,
      onStatus: options.onStatus
        ? (status) =>
            options.onStatus?.({
              activity: status.activity,
              detail: status.detail,
            })
        : undefined,
    });
  }

  capabilities() {
    return this.inner.capabilities();
  }

  async detect(): Promise<DetectionResult> {
    const binary = locateBinary("cursor");
    if (!binary) {
      return {
        installed: false,
        available: false,
        error:
          "Cursor CLI not found. Install Cursor / cursor-agent, or set ASSENTOR_CURSOR_BINARY.",
      };
    }
    return {
      installed: true,
      available: true,
      path: binary,
      version: "cli",
      authenticated: Boolean(process.env.CURSOR_API_KEY),
      capabilities: this.capabilities(),
    };
  }

  installPlan(): InstallPlan {
    return {
      application: "Cursor Agent CLI",
      command: "See https://cursor.com/docs/cli — install Cursor or `agent`",
      source: "https://cursor.com",
      automatic: false,
      notes: "Manual install required. Then run `agent login`.",
    };
  }

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    return this.inner.run(task);
  }

  async execute(task: ExecutorTask): Promise<ExecutorResult> {
    return this.inner.run(task);
  }

  async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
    return this.inner.continue(input);
  }

  async cancel(taskId: string): Promise<void> {
    return this.inner.cancel(taskId);
  }
}

export class ClaudeCodeExecutorAdapter extends CliExecutorAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly binaryNames = ["claude"];
  override readonly binaryTool = "claude" as const;

  installPlan(): InstallPlan {
    return {
      application: "Claude Code",
      command: "npm install -g @anthropic-ai/claude-code",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      automatic: true,
      notes: "Confirm before running. Then authenticate per Anthropic docs.",
    };
  }
}

export class CodexExecutorAdapter extends CliExecutorAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly binaryNames = ["codex"];
  override readonly binaryTool = "codex" as const;

  installPlan(): InstallPlan {
    return {
      application: "OpenAI Codex CLI",
      command: "npm install -g @openai/codex",
      source: "https://github.com/openai/codex",
      automatic: true,
      notes: "Confirm before running. Requires OpenAI auth.",
    };
  }
}

export class AntigravityExecutorAdapter extends CliExecutorAdapter {
  readonly id = "antigravity";
  readonly name = "Antigravity";
  readonly binaryNames = ["agy", "antigravity"];
  override readonly binaryTool = "agy" as const;

  installPlan(): InstallPlan {
    return {
      application: "Google Antigravity CLI",
      command:
        "Install the Antigravity CLI (`agy`). See https://antigravity.google/docs/cli or set ASSENTOR_AGY_BINARY.",
      source: "https://antigravity.google",
      automatic: false,
      notes:
        "Binary is `agy` (often ~/.local/bin/agy). Print mode: agy -p \"prompt\".",
    };
  }
}

export class QwenExecutorAdapter extends CliExecutorAdapter {
  readonly id = "qwen";
  readonly name = "Qwen Code";
  readonly binaryNames = ["qwen", "qwen-code"];
  override readonly binaryTool = "qwen" as const;

  installPlan(): InstallPlan {
    return {
      application: "Qwen Code CLI",
      command: "Check Alibaba Cloud Model Studio docs for the current installer",
      source: "https://www.alibabacloud.com/help/model-studio",
      automatic: false,
      notes: "Manual installation required — installer varies by region.",
    };
  }
}

export class OpenCodeExecutorAdapter extends CliExecutorAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly binaryNames = ["opencode"];
  override readonly binaryTool = "opencode" as const;

  installPlan(): InstallPlan {
    return {
      application: "OpenCode",
      command: "npm install -g opencode-ai",
      source: "https://github.com/sst/opencode",
      automatic: true,
      notes: "Confirm package name against current OpenCode docs before install.",
    };
  }
}

export function buildExecutorRegistry(
  options: ExecutorRuntimeOptions = {},
): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new CursorExecutorAdapter(options));
  registry.register(new ClaudeCodeExecutorAdapter(options));
  registry.register(new AntigravityExecutorAdapter(options));
  registry.register(new CodexExecutorAdapter(options));
  registry.register(new QwenExecutorAdapter(options));
  registry.register(new OpenCodeExecutorAdapter(options));
  return registry;
}

/** Shared by print-mode CLI adapters (Claude, Gemini, Antigravity, …). */
export function createPrintCliExecutor(
  id: string,
  options: ExecutorRuntimeOptions = {},
): PrintCliExecutor | undefined {
  const recipe = PRINT_CLI_RECIPES[id];
  if (!recipe) {
    return undefined;
  }
  return new PrintCliExecutor({
    recipe,
    timeoutMs: options.timeoutMs,
    onOutput: options.onOutput,
    onStatus: options.onStatus,
  });
}
