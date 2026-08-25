import { AssentorError } from "../core/errors.js";

export class CommandPolicyError extends AssentorError {
  constructor(message: string) {
    super("COMMAND_POLICY", message);
    this.name = "CommandPolicyError";
  }
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\//i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bwget\b.*\|\s*(ba)?sh/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fdx\b/i,
];

const DEFAULT_ALLOWED_PREFIXES = [
  "npm ",
  "npm\t",
  "pnpm ",
  "yarn ",
  "node ",
  "npx ",
  "vitest",
  "tsc",
  "git status",
  "git diff",
  "git log",
  "git rev-parse",
  "git show",
  "ls",
  "cat ",
  "head ",
  "tail ",
  "wc ",
  "echo ",
  "pwd",
  "whoami",
  "uname",
];

export interface CommandPolicy {
  allowedPrefixes?: string[];
  allowDangerous?: boolean;
}

/**
 * Validates reviewer/executor-requested commands against a conservative policy.
 * Does not execute anything.
 */
export function assertCommandAllowed(
  command: string,
  policy: CommandPolicy = {},
): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new CommandPolicyError("Command must be non-empty");
  }

  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new CommandPolicyError("Multi-line commands are not allowed");
  }

  if (!policy.allowDangerous) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new CommandPolicyError(
          `Command blocked by safety policy: ${trimmed}`,
        );
      }
    }
  }

  const allowed = policy.allowedPrefixes ?? DEFAULT_ALLOWED_PREFIXES;
  const ok = allowed.some((prefix) => {
    const normalized = prefix.trimEnd();
    return (
      trimmed === normalized ||
      trimmed.startsWith(`${normalized} `) ||
      trimmed.startsWith(prefix)
    );
  });

  if (!ok) {
    throw new CommandPolicyError(
      `Command not in allowlist: ${trimmed}`,
    );
  }
}
