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
  /** Flag used with a session id, e.g. `--resume`. */
  resumeFlag?: string;
  /** NDJSON stream for live tool/status updates when supported. */
  outputFormat?: PrintCliOutputFormat;
  /** How `-p` CLIs accept the task prompt. */
  promptStyle?: "attached" | "positional";
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
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    tool: "agy",
    printArgs: ["-p"],
    unattendedArgs: ["--dangerously-skip-permissions"],
    resumeFlag: "--resume",
    outputFormat: "stream-json",
    promptStyle: "attached",
  },
  codex: {
    id: "codex",
    name: "Codex",
    tool: "codex",
    printArgs: ["exec", "--skip-git-repo-check"],
    unattendedArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    outputFormat: "text",
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
  options: { sessionId?: string } = {},
): string[] {
  const args: string[] = [...(recipe.unattendedArgs ?? [])];

  if (options.sessionId && recipe.resumeFlag) {
    args.push(recipe.resumeFlag, options.sessionId);
  }

  const formatArgs: string[] =
    recipe.outputFormat && recipe.outputFormat !== "text"
      ? ["--output-format", recipe.outputFormat]
      : [];

  const attachPrompt = recipe.promptStyle === "attached";

  if (attachPrompt) {
    args.push(...formatArgs, `-p=${prompt}`);
    return args;
  }

  args.push(...recipe.printArgs, ...formatArgs, prompt);
  return args;
}
