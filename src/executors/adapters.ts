import {
  CursorExecutor,
  resolveCursorBinary,
  type CursorExecutorOptions,
} from "../providers/executors/cursor/index.js";
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

export class CursorExecutorAdapter implements ExecutorAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
  private readonly inner: CursorExecutor;

  constructor(options: CursorExecutorOptions = {}) {
    this.inner = new CursorExecutor(options);
  }

  capabilities() {
    return this.inner.capabilities();
  }

  async detect(): Promise<DetectionResult> {
    const binary = resolveCursorBinary();
    return {
      installed: Boolean(binary),
      available: Boolean(binary),
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

export class GeminiCliExecutorAdapter extends CliExecutorAdapter {
  readonly id = "gemini-cli";
  readonly name = "Gemini CLI";
  readonly binaryNames = ["gemini"];

  installPlan(): InstallPlan {
    return {
      application: "Gemini CLI",
      command: "npm install -g @google/gemini-cli",
      source: "https://github.com/google-gemini/gemini-cli",
      automatic: true,
    };
  }
}

export class QwenExecutorAdapter extends CliExecutorAdapter {
  readonly id = "qwen";
  readonly name = "Qwen Code";
  readonly binaryNames = ["qwen", "qwen-code"];

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
  cursorOptions: CursorExecutorOptions = {},
): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new CursorExecutorAdapter(cursorOptions));
  registry.register(new ClaudeCodeExecutorAdapter());
  registry.register(new CodexExecutorAdapter());
  registry.register(new GeminiCliExecutorAdapter());
  registry.register(new QwenExecutorAdapter());
  registry.register(new OpenCodeExecutorAdapter());
  return registry;
}
