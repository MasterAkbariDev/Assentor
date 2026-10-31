export interface GitStatusSummary {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  porcelain: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitCheckpoint {
  id: string;
  createdAt: string;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  statusPorcelain: string;
  /** Optional stash ref created when dirty and stashOnCheckpoint is enabled. */
  stashRef?: string;
}

export interface GitService {
  isRepo(): Promise<boolean>;
  status(): Promise<GitStatusSummary>;
  diff(options?: { staged?: boolean }): Promise<string>;
  changedFiles(): Promise<string[]>;
  /**
   * Files + combined diff since a baseline commit (task start).
   * Includes later commits, staged, unstaged, and untracked — not just a dirty tree.
   */
  changesSince(baseline?: string | null): Promise<{ files: string[]; diff: string }>;
  createCheckpoint(label?: string): Promise<GitCheckpoint>;
  /**
   * Restores working tree to a checkpoint when safe.
   * Never runs destructive commands unless explicitly allowed.
   */
  rollback(checkpoint: GitCheckpoint, options?: { allowDestructive?: boolean }): Promise<void>;
}
