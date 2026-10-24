import type { BinaryTool } from "../../../executors/cli-locator.js";

export type PrintCliOutputFormat = "text" | "json" | "stream-json";

export interface PrintCliRecipe {
  id: string;
  name: string;
  tool: BinaryTool;
  /** Flags before the prompt string (print / non-interactive). */
  printArgs: string[];
  /** Extra flags so the CLI can edit without pausing for approval. */
  unattendedArgs?: string[];
  /** Flag used with a session id, e.g. `--resume` or `--conversation`. */
  resumeFlag?: string;
  /** When continuing without a session id (e.g. agy `--continue`). */
  continueFlag?: string;
  /** NDJSON stream for live tool/status updates when supported. */
  outputFormat?: PrintCliOutputFormat;
  /** How `-p` CLIs accept the task prompt. */
  promptStyle?: "attached" | "positional";
  /** Flag that selects the model, e.g. `--model`. Unset when the CLI has none (or it is unverified). */
  modelFlag?: string;
}

/** Trimmed model id, or `undefined` when none was requested (empty or `AUTO`). */
export function requestedModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed !== "AUTO" ? trimmed : undefined;
}

export const PRINT_CLI_RECIPES: Record<string, PrintCliRecipe> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    tool: "claude",
    printArgs: ["-p"],
    unattendedArgs: ["--dangerously-skip-permissions"],
    resumeFlag: "--resume",
    outputFormat: "stream-json",
    promptStyle: "positional",
    modelFlag: "--model",
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    tool: "agy",
    printArgs: ["-p"],
    unattendedArgs: ["--dangerously-skip-permissions"],
    resumeFlag: "--conversation",
    continueFlag: "--continue",
    outputFormat: "stream-json",
    promptStyle: "attached",
    modelFlag: "--model",
  },
  codex: {
    id: "codex",
    name: "Codex",
    tool: "codex",
    printArgs: ["exec", "--skip-git-repo-check"],
    unattendedArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    outputFormat: "text",
    modelFlag: "-m",
  },
  qwen: {
    id: "qwen",
    name: "Qwen Code",
    tool: "qwen",
    printArgs: ["-p"],
    unattendedArgs: ["--yolo"],
    outputFormat: "stream-json",
    promptStyle: "attached",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    tool: "opencode",
    printArgs: ["run"],
    outputFormat: "text",
  },
};

export function buildPrintCliArgs(
  recipe: PrintCliRecipe,
  prompt: string,
  options: { sessionId?: string; continueRecent?: boolean; model?: string } = {},
): string[] {
  const args: string[] = [...(recipe.unattendedArgs ?? [])];

  if (options.sessionId && recipe.resumeFlag) {
    args.push(recipe.resumeFlag, options.sessionId);
  } else if (options.continueRecent && recipe.continueFlag) {
    args.push(recipe.continueFlag);
  }

  const formatArgs: string[] =
    recipe.outputFormat && recipe.outputFormat !== "text"
      ? ["--output-format", recipe.outputFormat]
      : [];

  // Model flag goes right before the prompt so codex gets `exec ... -m <m> <prompt>`.
  const model = requestedModel(options.model);
  const modelArgs: string[] =
    model && recipe.modelFlag ? [recipe.modelFlag, model] : [];

  const attachPrompt = recipe.promptStyle === "attached";

  if (attachPrompt) {
    args.push(...formatArgs, ...modelArgs, `-p=${prompt}`);
    return args;
  }

  args.push(...recipe.printArgs, ...formatArgs, ...modelArgs, prompt);
  return args;
}
