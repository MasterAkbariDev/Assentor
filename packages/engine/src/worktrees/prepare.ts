import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runShellCommand } from "../process/run-shell.js";
import type { RunVerificationCommand } from "../review/verification-gates.js";
import { redactSecrets } from "../security/redact.js";

/**
 * Installs dependencies in a fresh seat worktree before any gate runs (FU-10).
 *
 * A new git worktree has the committed files only: no `node_modules`, no venv,
 * so test/typecheck gates fail on real projects. `worktrees.install` decides:
 * - `"auto"` (default): a JS lockfile at the worktree root picks the install
 *   (first match: pnpm, npm, yarn, bun); no lockfile runs nothing. Other
 *   ecosystems (Python, Ruby, ...) are never guessed; set a command.
 * - `"off"`: nothing runs.
 * - any other text: that shell command, through the same runner as the gates.
 *
 * Design choices:
 * - Always a real install, never a link/clone of the main checkout's
 *   `node_modules`: a `node_modules` symlink is not matched by the usual
 *   `node_modules/` ignore rule (so it shows up in the seat's diff and could be
 *   applied), and writes through it would change the main checkout. pnpm/bun
 *   hard-link from their store and `--prefer-offline` skips the registry when
 *   the cache has everything, so the install is usually cheap.
 * - Lifecycle scripts (postinstall, prepare) run as the package manager does by
 *   default: the main checkout already ran the same ones from the same lockfile,
 *   and skipping them breaks native dependencies. A worktree built from a seat
 *   branch (swarm) may carry seat-edited `package.json` scripts; the gates run
 *   seat-written code anyway, so this adds no new trust boundary.
 * - `CI=1` keeps package managers non-interactive (and skips husky-style git
 *   hook installers that would write the shared git config).
 * - Afterwards the worktree must still be clean in git: an install that writes
 *   tracked or unignored files would be blamed on the seat later.
 */

export type WorktreeInstallSetting = string;

export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL_CHARS = 2_000;

/** Lockfile → install command, in detection order. */
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --prefer-offline"],
  ["package-lock.json", "npm ci --prefer-offline"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
  ["bun.lock", "bun install --frozen-lockfile"],
];

export type PrepareResult = { ok: true; command?: string } | { ok: false; reason: string };

/** The install command `setting` resolves to in `worktreePath`, or undefined for none. */
export async function worktreeInstallCommand(worktreePath: string, setting: WorktreeInstallSetting = "auto"): Promise<string | undefined> {
  if (setting === "off") return undefined;
  if (setting !== "auto") return setting;
  for (const [file, command] of LOCKFILES) {
    const stat = await fs.stat(path.join(worktreePath, file)).catch(() => undefined);
    if (stat?.isFile()) return command;
  }
  return undefined;
}

/**
 * Runs the install for a new worktree. Never throws for an install problem: a
 * failure, timeout or cancel comes back as `{ ok: false, reason }` for the mode
 * to end `blocked` with (the worktree is left as it is).
 */
export async function prepareWorktree(
  worktreePath: string,
  setting: WorktreeInstallSetting | undefined,
  options: { signal?: AbortSignal; run?: RunVerificationCommand; timeoutMs?: number } = {},
): Promise<PrepareResult> {
  const command = await worktreeInstallCommand(worktreePath, setting);
  if (!command) return { ok: true };
  if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const run = options.run ?? runShellCommand;
  const result = await run(command, worktreePath, {
    timeoutMs,
    env: { CI: "1" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
  const where = `(worktree kept at ${worktreePath}; set worktrees.install to a working command, or "off")`;
  if (result.code !== 0) {
    const why = result.code === 124 ? `timed out after ${Math.ceil(timeoutMs / 1000)} s` : `exited ${result.code}`;
    const tail = redactSecrets([result.stdout, result.stderr].filter(Boolean).join("\n").slice(-OUTPUT_TAIL_CHARS)).text;
    return { ok: false, reason: `installing dependencies in the worktree failed: \`${command}\` ${why} ${where}\n${tail}` };
  }
  const changed = await gitStatus(worktreePath);
  if (changed === undefined || changed.length > 0) {
    const files = changed?.slice(0, 10).join(", ") ?? "git status failed";
    return {
      ok: false,
      reason: `installing dependencies with \`${command}\` changed files git tracks or does not ignore (${files}); ignore them (e.g. node_modules) or change worktrees.install ${where}`,
    };
  }
  return { ok: true, command };
}

/** Paths `git status` reports in `cwd`; undefined when git fails. */
function gitStatus(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=normal"],
      { cwd, encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout.split("\0").filter(Boolean).map((e) => e.slice(3))),
    );
  });
}
