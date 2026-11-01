import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
 * - Afterwards git must show nothing new: an install that writes tracked or
 *   unignored files would be blamed on the seat later.
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

/**
 * `worktrees.install`, or `"off"` when the mode's gates are disabled
 * (`verification.enabled: false`, `--skip-gates`): then nothing needs the deps.
 */
export function installSetting(
  config: { worktrees?: { install?: string }; verification: { enabled?: boolean } },
  skipGates?: boolean,
): WorktreeInstallSetting | undefined {
  return config.verification.enabled === false || skipGates ? "off" : config.worktrees?.install;
}

/** Hash of the JS lockfiles at the worktree root: an install is stale once this changes. */
export async function lockfileFingerprint(worktreePath: string): Promise<string> {
  const hash = createHash("sha256");
  for (const [file] of LOCKFILES) {
    const bytes = await fs.readFile(path.join(worktreePath, file)).catch(() => undefined);
    if (bytes) hash.update(`${file}\0`).update(bytes);
  }
  return hash.digest("hex");
}

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
  // A reused worktree (lead after a resume) may hold work already; only what the install adds counts.
  const before = await dirtySnapshot(worktreePath);
  const result = await run(command, worktreePath, {
    timeoutMs,
    env: { CI: "1" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
  const where = `(worktree kept at ${worktreePath}; set worktrees.install to a working command, or "off")`;
  if (result.code !== 0) {
    const why = result.code === 124 ? `timed out after ${Math.ceil(timeoutMs / 1000)} s` : `exited ${result.code}`;
    // Redact first: cutting first could split a secret so the redactor no longer recognises it.
    const tail = redactSecrets([result.stdout, result.stderr].filter(Boolean).join("\n")).text.slice(-OUTPUT_TAIL_CHARS);
    return { ok: false, reason: `installing dependencies in the worktree failed: \`${command}\` ${why} ${where}\n${tail}` };
  }
  const after = await dirtySnapshot(worktreePath);
  const changed =
    before && after
      ? [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file))
      : undefined;
  if (changed === undefined || changed.length > 0) {
    const files = changed?.slice(0, 10).join(", ") ?? "git status failed";
    return {
      ok: false,
      reason: `installing dependencies with \`${command}\` changed files git tracks or does not ignore (${files}); ignore them (e.g. node_modules) or change worktrees.install ${where}`,
    };
  }
  return { ok: true, command };
}

/**
 * Every path `git status` reports in `cwd` (untracked files one by one) with a
 * hash of its content, so a rewrite of an already-dirty file shows; undefined
 * when git fails.
 */
async function dirtySnapshot(cwd: string): Promise<Map<string, string> | undefined> {
  const out = await new Promise<string | undefined>((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
  if (out === undefined) return undefined;
  const files: string[] = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i += 1; // the next field is the rename/copy source
  }
  const snapshot = new Map<string, string>();
  for (const file of files) snapshot.set(file, await contentHash(path.join(cwd, file)));
  return snapshot;
}

async function contentHash(file: string): Promise<string> {
  try {
    const stat = await fs.lstat(file);
    const bytes = stat.isSymbolicLink() ? `link:${await fs.readlink(file)}` : stat.isFile() ? await fs.readFile(file) : `type:${stat.mode}`;
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return "missing";
  }
}
