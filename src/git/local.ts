import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createId } from "../core/ids.js";
import { AssentorError } from "../core/errors.js";
import type { GitCheckpoint, GitService, GitStatusSummary } from "./types.js";

const execFileAsync = promisify(execFile);

export class GitError extends AssentorError {
  constructor(message: string, options?: ErrorOptions) {
    super("GIT_ERROR", message, options);
    this.name = "GitError";
  }
}

export interface LocalGitServiceOptions {
  cwd: string;
  /** When dirty, create a stash entry as part of checkpoint. Default false. */
  stashOnCheckpoint?: boolean;
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number;
    };
    // git status --porcelain returns exit 0 even when dirty; other commands may fail.
    if (typeof err.stdout === "string" || typeof err.stderr === "string") {
      throw new GitError(
        err.stderr?.trim() || err.message || `git ${args.join(" ")} failed`,
        { cause: error },
      );
    }
    throw new GitError(`git ${args.join(" ")} failed`, { cause: error });
  }
}

function parsePorcelain(porcelain: string): Pick<
  GitStatusSummary,
  "staged" | "unstaged" | "untracked"
> {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of porcelain.split("\n")) {
    if (!line) {
      continue;
    }
    if (line.startsWith("?? ")) {
      untracked.push(line.slice(3));
      continue;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const file = line.slice(3);
    if (x !== " " && x !== "?") {
      staged.push(file);
    }
    if (y !== " " && y !== "?") {
      unstaged.push(file);
    }
  }

  return { staged, unstaged, untracked };
}

/**
 * Real git integration via `git` CLI. Never runs destructive commands
 * unless rollback is explicitly authorized.
 */
export class LocalGitService implements GitService {
  private readonly cwd: string;
  private readonly stashOnCheckpoint: boolean;

  constructor(options: LocalGitServiceOptions) {
    this.cwd = options.cwd;
    this.stashOnCheckpoint = options.stashOnCheckpoint ?? false;
  }

  async isRepo(): Promise<boolean> {
    try {
      const result = await git(this.cwd, ["rev-parse", "--is-inside-work-tree"]);
      return result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async status(): Promise<GitStatusSummary> {
    const [headResult, branchResult, porcelainResult] = await Promise.all([
      git(this.cwd, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "", stderr: "" })),
      git(this.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      git(this.cwd, ["status", "--porcelain"]),
    ]);

    const porcelain = porcelainResult.stdout;
    const parsed = parsePorcelain(porcelain);

    return {
      branch: branchResult.stdout.trim() || null,
      head: headResult.stdout.trim() || null,
      dirty: porcelain.trim().length > 0,
      porcelain,
      ...parsed,
    };
  }

  async diff(options: { staged?: boolean } = {}): Promise<string> {
    const args = options.staged ? ["diff", "--cached"] : ["diff"];
    const result = await git(this.cwd, args);
    return result.stdout;
  }

  async changedFiles(): Promise<string[]> {
    const result = await git(this.cwd, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    const files = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      if (!line) {
        continue;
      }
      if (line.startsWith("?? ")) {
        files.add(line.slice(3));
        continue;
      }
      const pathPart = line.slice(3);
      // Handle renames: "R  old -> new"
      if (pathPart.includes(" -> ")) {
        const parts = pathPart.split(" -> ");
        const next = parts[1];
        if (next) {
          files.add(next);
        }
      } else {
        files.add(pathPart);
      }
    }
    return [...files].sort();
  }

  async changesSince(
    baseline?: string | null,
  ): Promise<{ files: string[]; diff: string }> {
    const files = new Set<string>(await this.changedFiles());
    const ref = baseline?.trim() || undefined;

    if (ref) {
      await this.addNameOnly(files, ["diff", "--name-only", ref]);
      await this.addNameOnly(files, ["diff", "--name-only", "--cached", ref]);
      const diff = await git(this.cwd, ["diff", ref]).catch(() => ({
        stdout: "",
        stderr: "",
      }));
      return { files: [...files].sort(), diff: diff.stdout };
    }

    const unstaged = await this.diff();
    const staged = await this.diff({ staged: true });
    const parts = [unstaged, staged].filter((part) => part.trim());
    return { files: [...files].sort(), diff: parts.join("\n") };
  }

  private async addNameOnly(
    files: Set<string>,
    args: string[],
  ): Promise<void> {
    try {
      const result = await git(this.cwd, args);
      for (const line of result.stdout.split("\n")) {
        const name = line.trim();
        if (name) {
          files.add(name);
        }
      }
    } catch {
      // baseline may be missing in a brand-new repo
    }
  }

  async createCheckpoint(label?: string): Promise<GitCheckpoint> {
    const status = await this.status();
    const checkpoint: GitCheckpoint = {
      id: createId(),
      createdAt: new Date().toISOString(),
      head: status.head,
      branch: status.branch,
      dirty: status.dirty,
      statusPorcelain: status.porcelain,
    };

    if (status.dirty && this.stashOnCheckpoint) {
      const message = label
        ? `assentor-checkpoint:${checkpoint.id}:${label}`
        : `assentor-checkpoint:${checkpoint.id}`;
      await git(this.cwd, ["stash", "push", "-u", "-m", message]);
      const stashRef = await git(this.cwd, ["rev-parse", "-q", "--verify", "refs/stash"]);
      checkpoint.stashRef = stashRef.stdout.trim() || undefined;
      // Re-read cleanliness after stash.
      const after = await this.status();
      checkpoint.dirty = after.dirty;
      checkpoint.statusPorcelain = after.porcelain;
    }

    return checkpoint;
  }

  async rollback(
    checkpoint: GitCheckpoint,
    options: { allowDestructive?: boolean } = {},
  ): Promise<void> {
    if (!options.allowDestructive) {
      throw new GitError(
        "Refusing rollback without allowDestructive: true (won't destroy user changes silently)",
      );
    }

    if (checkpoint.stashRef) {
      // Best-effort: apply the stash created for this checkpoint.
      await git(this.cwd, ["stash", "pop"]);
      return;
    }

    if (!checkpoint.head) {
      throw new GitError("Checkpoint has no HEAD to restore");
    }

    // Explicitly authorized destructive restore of tracked files.
    await git(this.cwd, ["reset", "--hard", checkpoint.head]);
  }
}
