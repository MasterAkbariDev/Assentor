import type { BinaryTool } from "../../../executors/cli-locator.js";

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
}

export const PRINT_CLI_RECIPES: Record<string, PrintCliRecipe> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    tool: "claude",
    printArgs: ["-p", "--output-format", "text"],
    unattendedArgs: ["--dangerously-skip-permissions"],
    resumeFlag: "--resume",
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    tool: "agy",
    printArgs: ["-p"],
    unattendedArgs: ["--dangerously-skip-permissions"],
    resumeFlag: "--resume",
  },
  codex: {
    id: "codex",
    name: "Codex",
    tool: "codex",
    printArgs: ["exec", "--skip-git-repo-check"],
    unattendedArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  qwen: {
    id: "qwen",
    name: "Qwen Code",
    tool: "qwen",
    printArgs: ["-p"],
    unattendedArgs: ["--yolo"],
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    tool: "opencode",
    printArgs: ["run"],
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

  // CLIs such as agy/qwen treat `-p` as `--prompt=<text>`; flags after a bare `-p`
  // become the prompt and the real task text is dropped.
  const lonePromptFlag =
    recipe.printArgs.length === 1 && recipe.printArgs[0] === "-p";

  if (lonePromptFlag) {
    args.push(`-p=${prompt}`);
    return args;
  }

  args.push(...recipe.printArgs, prompt);
  return args;
}
