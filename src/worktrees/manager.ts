import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AssentorError } from "../core/errors.js";
import { isId } from "../core/ids.js";
import { GitError } from "../git/local.js";
import { ASSENTOR_DIR, writeJsonAtomic } from "../persistence/paths.js";

/**
 * Per-seat git worktrees (T02-01).
 *
 * Layout: `<repo>/.assentor/worktrees/<session[0..8]>/<short-seat>` on branch
 * `assentor/<session[0..8]>/<short-seat>`. Paths and branch names are derived
 * from validated ids, never taken from user text or the manifest.
 *
 * Safety model:
 * - Only worktrees/branches recorded in `.assentor/worktrees/manifest.json`
 *   are ever removed. Unrecorded ones are reported as orphans, never deleted.
 * - Every mutation writes its intent to the manifest first (`creating`,
 *   `removing`), so a crash at any point is detected and finished or rolled
 *   back by `reconcile()` (and by `cleanup`, which is idempotent).
 * - Git is run with `execFile` (no shell), fixed argv and a timeout. All calls
 *   for one repository are serialized in-process; cross-process `.lock`
 *   contention is retried with backoff.
 */

export class WorktreeError extends AssentorError {
  constructor(message: string, options?: ErrorOptions) {
    super("WORKTREE_ERROR", message, options);
    this.name = "WorktreeError";
  }
}

export interface WorktreeManagerOptions {
  /** Any path inside the main checkout; its top level is the "main" target. */
  repoPath: string;
  /** Create worktrees even when the main checkout has uncommitted changes. Default false. */
  allowDirtyMain?: boolean;
  /** Timeout per git call. Default 120 s. */
  timeoutMs?: number;
}

/** Seat ids are unique only within a session, so seats are addressed by both. */
export interface SeatKey {
  sessionId: string;
  seatId: string;
}

export type WorktreeState = "creating" | "ready" | "removing";
/** `applied-patch`: the work exists in the target only as staged changes, so the branch is kept. */
export type WorktreeOutcome = "applied" | "applied-patch" | "failed";

export interface WorktreeInfo extends SeatKey {
  path: string;
  branch: string;
  baseSha: string;
  state: WorktreeState;
  outcome?: WorktreeOutcome;
  /** Seat branch tip that was merged/squashed into a target. */
  appliedTip?: string;
  createdAt: string;
}

export interface WorktreeDiff {
  baseSha: string;
  head: string;
  /** Uncommitted (incl. untracked) changes present in the worktree. */
  dirty: boolean;
  /** Files changed since `baseSha`, committed or not, untracked included. */
  files: string[];
  diff: string;
}

export type ApplyStrategy = "merge" | "squash" | "patch";

export type ApplyResult =
  | {
      ok: true;
      strategy: ApplyStrategy;
      changed: boolean;
      commit?: string;
      /** Set when the commit landed but a later hook (post-commit / post-merge) failed or was killed. */
      warning?: string;
    }
  | { ok: false; strategy: ApplyStrategy; conflicts: string[]; message: string };

export interface CleanupReport {
  removed: SeatKey[];
  kept: Array<SeatKey & { reason: "failed" | "dirty" | "unmerged" | "error"; detail?: string }>;
}

export interface ReconcileReport {
  actions: Array<
    SeatKey & {
      action: "completed" | "rolled-back" | "removed" | "missing" | "failed";
      detail?: string;
    }
  >;
  /** Registered worktrees under the Assentor root with no manifest record. Never deleted. */
  orphanWorktrees: string[];
  /** `assentor/*` branches with no manifest record. Never deleted. */
  orphanBranches: string[];
}

// ---------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------

/** Lower-case dot/dash-separated segments; rules out `..`, leading `-`, separators. */
const SEAT_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHORT_SEAT_MAX = 20;

export function assertSeatKey(seat: SeatKey): void {
  if (!isId(seat.sessionId)) {
    throw new WorktreeError(`Invalid session id: ${JSON.stringify(seat.sessionId)}`);
  }
  if (
    seat.seatId.length > 100 ||
    !SEAT_ID_RE.test(seat.seatId) ||
    seat.seatId.endsWith(".lock") ||
    WINDOWS_RESERVED_RE.test(seat.seatId)
  ) {
    throw new WorktreeError(`Invalid seat id: ${JSON.stringify(seat.seatId)}`);
  }
}

/** Short, path- and ref-safe seat component; long ids keep a hash so they stay unique. */
export function shortSeatName(seatId: string): string {
  if (seatId.length <= SHORT_SEAT_MAX) return seatId;
  const hash = createHash("sha256").update(seatId).digest("hex").slice(0, 6);
  return `${seatId.slice(0, SHORT_SEAT_MAX - 7)}-${hash}`;
}

/** Path of a seat's worktree relative to the repo top level (POSIX separators). */
export function worktreeRelativePath(seat: SeatKey): string {
  assertSeatKey(seat);
  return [ASSENTOR_DIR, "worktrees", seat.sessionId.slice(0, 8), shortSeatName(seat.seatId)].join("/");
}

export function worktreeBranch(seat: SeatKey): string {
  assertSeatKey(seat);
  return `assentor/${seat.sessionId.slice(0, 8)}/${shortSeatName(seat.seatId)}`;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

// ---------------------------------------------------------------------------
// Git runner
// ---------------------------------------------------------------------------

const LOCK_ERROR_RE = /\.lock'?:? File exists|Unable to create '[^']*\.lock'|unable to lock|another git process/i;
const LOCK_RETRIES = 5;
/** Merge and commit steps run user hooks (lint, tests), so they get far longer than plumbing calls. */
const HOOK_TIMEOUT_MS = 600_000;

interface GitRun {
  stdout: string;
  stderr: string;
  code: number;
}

function execGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<GitRun> {
  // core.longpaths lets Git for Windows handle paths past MAX_PATH; harmless elsewhere.
  const argv = process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      argv,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (typeof err.code === "number") {
          resolve({ stdout, stderr, code: err.code });
          return;
        }
        const reason = err.killed ? `timed out after ${timeoutMs} ms` : err.message;
        reject(new GitError(`git ${args[0] ?? ""} failed: ${reason}`, { cause: error }));
      },
    );
  });
}

// One queue per repository so concurrent seats never race on `.git` locks or the manifest.
const repoQueues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  repoQueues.set(key, run.catch(() => undefined));
  return run;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const RecordSchema = z.object({
  sessionId: z.string().refine(isId, "sessionId must be a UUID"),
  seatId: z.string().regex(SEAT_ID_RE),
  baseSha: z.string().regex(SHA_RE),
  state: z.enum(["creating", "ready", "removing"]),
  outcome: z.enum(["applied", "applied-patch", "failed"]).optional(),
  appliedTip: z.string().regex(SHA_RE).optional(),
  /** Branch tip a started removal may delete (compare-and-delete); absent = keep the branch. */
  removeTip: z.string().regex(SHA_RE).optional(),
  createdAt: z.string(),
});
type WorktreeRecord = z.infer<typeof RecordSchema>;

const ManifestSchema = z.object({
  version: z.literal(1),
  records: z.array(RecordSchema),
});
type Manifest = z.infer<typeof ManifestSchema>;

const sameSeat = (a: SeatKey, b: SeatKey) => a.sessionId === b.sessionId && a.seatId === b.seatId;
const keyOf = (r: SeatKey): SeatKey => ({ sessionId: r.sessionId, seatId: r.seatId });

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface RepoContext {
  /** Real path of the main checkout's top level. */
  top: string;
  /** `<top>/.assentor/worktrees` */
  root: string;
  manifestFile: string;
}

interface RegisteredWorktree {
  path: string;
  head?: string;
  branch?: string;
}

export class WorktreeManager {
  private readonly repoPath: string;
  private readonly allowDirtyMain: boolean;
  private readonly timeoutMs: number;
  private ctx?: RepoContext;

  constructor(options: WorktreeManagerOptions) {
    this.repoPath = path.resolve(options.repoPath);
    this.allowDirtyMain = options.allowDirtyMain ?? false;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * Create a worktree + branch for an `edit` seat at `baseRef` (default `HEAD`).
   * Refuses when the main checkout is dirty (unless `allowDirtyMain`), when the
   * seat already has a worktree, or when the derived path/branch already exists.
   */
  async create(seat: SeatKey, baseRef = "HEAD"): Promise<WorktreeInfo> {
    assertSeatKey(seat);
    if (!baseRef || baseRef.startsWith("-") || /[\0\s]/.test(baseRef)) {
      throw new WorktreeError(`Invalid base ref: ${JSON.stringify(baseRef)}`);
    }
    return this.locked(async (ctx) => {
      if (!this.allowDirtyMain && (await this.isDirty(ctx.top))) {
        throw new WorktreeError(
          "The main checkout has uncommitted changes; commit or stash them, or opt in with allowDirtyMain",
        );
      }
      const manifest = await this.readManifest(ctx);
      const wtPath = this.pathFor(ctx, seat);
      const branch = worktreeBranch(seat);
      const clash = manifest.records.find(
        (r) => sameSeat(r, seat) || samePath(this.pathFor(ctx, r), wtPath),
      );
      if (clash) {
        throw new WorktreeError(
          `A worktree is already recorded for ${clash.sessionId}/${clash.seatId} at ${wtPath}`,
        );
      }
      if (await exists(wtPath)) {
        throw new WorktreeError(`Refusing to use existing path ${wtPath} (not created by Assentor)`);
      }
      if (await this.branchExists(ctx, branch)) {
        throw new WorktreeError(`Refusing to reuse existing branch ${branch}`);
      }
      await this.assertNoSymlink(ctx, wtPath);
      const resolved = await this.git(ctx.top, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
      const baseSha = resolved.stdout.trim();
      if (resolved.code !== 0 || !SHA_RE.test(baseSha)) {
        throw new WorktreeError(`Base ref does not name a commit: ${baseRef}`);
      }

      // Intent first: a crash after this point leaves a `creating` record for reconcile().
      const record: WorktreeRecord = {
        ...keyOf(seat),
        baseSha,
        state: "creating",
        createdAt: new Date().toISOString(),
      };
      manifest.records.push(record);
      await this.writeManifest(ctx, manifest);

      try {
        await this.gitOk(ctx.top, ["worktree", "add", "-b", branch, "--", wtPath, baseSha]);
      } catch (error) {
        // Roll back what git managed to create; a fresh branch still at base holds no work.
        const tip = await this.registeredWorktrees(ctx)
          .then((registered) => this.disposableTip(ctx, record, registered, { unchangedOnly: true }))
          .catch(() => false as const);
        if (tip !== false) {
          await this.remove(ctx, manifest, record, false, tip).catch(() => undefined);
        }
        throw error;
      }

      record.state = "ready";
      await this.writeManifest(ctx, manifest);
      return this.info(ctx, record);
    });
  }

  /** Recorded worktrees, optionally for one session. */
  async list(sessionId?: string): Promise<WorktreeInfo[]> {
    return this.locked(async (ctx) => {
      const manifest = await this.readManifest(ctx);
      return manifest.records
        .filter((r) => sessionId === undefined || r.sessionId === sessionId)
        .map((r) => this.info(ctx, r));
    });
  }

  /**
   * Everything the seat changed since its base: commits, staged, unstaged and
   * untracked files. Uses a throwaway index so the seat's own index is untouched.
   */
  async diff(seat: SeatKey): Promise<WorktreeDiff> {
    return this.locked(async (ctx) => {
      const record = await this.requireReady(ctx, seat);
      const wt = this.pathFor(ctx, record);
      const head = (await this.gitOk(wt, ["rev-parse", "HEAD"])).stdout.trim();
      const dirty = await this.isDirty(wt);
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-idx-"));
      try {
        const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
        const realIndex = path.resolve(wt, (await this.gitOk(wt, ["rev-parse", "--git-path", "index"])).stdout.trim());
        await fs.copyFile(realIndex, env.GIT_INDEX_FILE).catch(() => undefined);
        await this.gitOk(wt, ["add", "-A"], env);
        const files = (await this.gitOk(wt, ["diff", "--cached", "--name-only", "-z", record.baseSha], env)).stdout
          .split("\0")
          .filter(Boolean);
        const diff = (await this.gitOk(wt, ["diff", "--cached", record.baseSha], env)).stdout;
        return { baseSha: record.baseSha, head, dirty, files, diff };
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  }

  /**
   * Apply a seat's work to `"main"` (the main checkout's current branch) or to
   * another seat's worktree. Pending seat changes are first committed on the
   * seat branch, and the tip seen at that moment is what gets applied. The
   * target must be clean and on a branch, and the seat must not touch
   * `.assentor/` or any untracked/ignored file present in the target. On any
   * failure (conflict, hook, timeout) the target is reset to its previous state;
   * conflicts are returned, other failures rethrown. `patch` leaves the changes
   * staged but uncommitted and keeps the seat branch.
   */
  async applyTo(
    target: "main" | SeatKey,
    seat: SeatKey,
    options: { strategy: ApplyStrategy; message?: string },
  ): Promise<ApplyResult> {
    const { strategy } = options;
    return this.locked(async (ctx) => {
      const record = await this.requireReady(ctx, seat);
      const wt = this.pathFor(ctx, record);
      const branch = worktreeBranch(record);
      let targetPath = ctx.top;
      let targetBranch: string | undefined;
      if (target !== "main") {
        if (sameSeat(target, seat)) throw new WorktreeError("Cannot apply a worktree to itself");
        const targetRecord = await this.requireReady(ctx, target);
        targetPath = this.pathFor(ctx, targetRecord);
        targetBranch = worktreeBranch(targetRecord);
      }
      const targetHead = (await this.git(targetPath, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
      if (!targetHead || (targetBranch !== undefined && targetHead !== `refs/heads/${targetBranch}`)) {
        throw new WorktreeError(
          `Target ${targetPath} is not on ${targetBranch ?? "a branch"} (detached HEAD?); refusing to apply`,
        );
      }
      if (await this.isDirty(targetPath)) {
        throw new WorktreeError(`Target ${targetPath} has uncommitted changes; refusing to apply`);
      }
      const onBranch = await this.git(wt, ["symbolic-ref", "--quiet", "HEAD"]);
      if (onBranch.stdout.trim() !== `refs/heads/${branch}`) {
        throw new WorktreeError(`Seat worktree ${wt} is no longer on ${branch}; refusing to apply`);
      }

      if (await this.isDirty(wt)) {
        await this.gitOk(wt, ["add", "-A"]);
        // Assentor's own gates verify seat work; user hooks run on the real apply below.
        await this.gitOk(wt, [
          ...(await this.identityFallback(wt)),
          "commit", "--no-verify", "-m", `assentor: snapshot ${record.seatId}`,
        ]);
      }
      // Apply this exact SHA: later seat commits and same-named tags cannot slip in.
      const tip = (await this.gitOk(wt, ["rev-parse", "HEAD"])).stdout.trim();
      if (tip === record.baseSha) {
        return { ok: true, strategy, changed: false };
      }
      await this.assertSafeToWrite(targetPath, strategy, record.baseSha, tip);
      const message = options.message ?? `assentor: apply ${record.seatId} (${strategy})`;
      const result = await this.runApply(targetPath, strategy, record.baseSha, tip, message);
      if (result.ok) {
        const manifest = await this.readManifest(ctx);
        const current = manifest.records.find((r) => sameSeat(r, seat));
        if (current) {
          if (strategy === "patch") {
            current.outcome = "applied-patch";
            delete current.appliedTip;
          } else {
            current.outcome = "applied";
            current.appliedTip = tip;
          }
          await this.writeManifest(ctx, manifest);
        }
      }
      return result;
    });
  }

  /** Mark a seat's work as failed so `cleanup({ keepFailed })` keeps it for inspection. */
  async markFailed(seat: SeatKey): Promise<void> {
    await this.locked(async (ctx) => {
      const manifest = await this.readManifest(ctx);
      const record = manifest.records.find((r) => sameSeat(r, seat));
      if (!record) throw new WorktreeError(`No worktree recorded for ${seat.sessionId}/${seat.seatId}`);
      record.outcome = "failed";
      await this.writeManifest(ctx, manifest);
    });
  }

  /**
   * Explicitly throw away a seat's worktree and branch (even unmerged commits).
   * Refuses when the worktree has uncommitted changes unless `force`.
   */
  async discard(seat: SeatKey, options: { force?: boolean } = {}): Promise<void> {
    assertSeatKey(seat);
    await this.locked(async (ctx) => {
      const manifest = await this.readManifest(ctx);
      const record = manifest.records.find((r) => sameSeat(r, seat));
      if (!record) {
        throw new WorktreeError(`No worktree recorded for ${seat.sessionId}/${seat.seatId}; refusing to remove`);
      }
      const wt = this.pathFor(ctx, record);
      if (!options.force && (await exists(wt)) && (await this.isDirty(wt))) {
        throw new WorktreeError(`Worktree ${wt} has uncommitted changes; pass force to discard them`);
      }
      // Explicit discard: the branch goes even with unmerged commits, but only at the tip seen now.
      await this.remove(ctx, manifest, record, options.force ?? false, await this.branchTip(ctx, record));
    });
  }

  /**
   * Remove a session's worktrees that are safe to remove: clean, and either
   * applied, unchanged, or merged into the main checkout's HEAD. Dirty or
   * unmerged worktrees are kept (and reported); failed ones too when
   * `keepFailed` (default true). Re-running after an interruption finishes it.
   */
  async cleanup(sessionId: string, options: { keepFailed?: boolean } = {}): Promise<CleanupReport> {
    const keepFailed = options.keepFailed ?? true;
    return this.locked(async (ctx) => {
      const report: CleanupReport = { removed: [], kept: [] };
      const manifest = await this.readManifest(ctx);
      const registered = await this.registeredWorktrees(ctx);
      for (const record of manifest.records.filter((r) => r.sessionId === sessionId)) {
        const key = keyOf(record);
        try {
          let tip: string | null | undefined;
          if (record.state !== "removing") {
            if (keepFailed && record.outcome === "failed") {
              report.kept.push({ ...key, reason: "failed" });
              continue;
            }
            const wt = this.pathFor(ctx, record);
            if ((await exists(wt)) && (await this.isDirty(wt))) {
              report.kept.push({ ...key, reason: "dirty" });
              continue;
            }
            const disposable = await this.disposableTip(ctx, record, registered);
            if (disposable === false) {
              report.kept.push({ ...key, reason: "unmerged" });
              continue;
            }
            tip = disposable;
          }
          await this.remove(ctx, manifest, record, false, tip);
          report.removed.push(key);
        } catch (error) {
          report.kept.push({ ...key, reason: "error", detail: (error as Error).message });
        }
      }
      return report;
    });
  }

  /**
   * Startup recovery. Finishes or rolls back interrupted creates/removals that
   * the manifest recorded, reports recorded worktrees whose directory is gone,
   * and reports (never deletes) worktrees/branches in Assentor's namespace that
   * have no record.
   */
  async reconcile(): Promise<ReconcileReport> {
    return this.locked(async (ctx) => {
      const report: ReconcileReport = { actions: [], orphanWorktrees: [], orphanBranches: [] };
      const manifest = await this.readManifest(ctx);
      const registered = await this.registeredWorktrees(ctx);
      const isRegistered = (p: string) => registered.some((w) => samePath(w.path, p));

      for (const record of [...manifest.records]) {
        const key = keyOf(record);
        const wt = this.pathFor(ctx, record);
        const live = isRegistered(wt) && (await exists(wt));
        let tip: string | null | false;
        try {
          if (record.state === "creating") {
            if (live) {
              record.state = "ready";
              await this.writeManifest(ctx, manifest);
              report.actions.push({ ...key, action: "completed" });
            } else if ((tip = await this.disposableTip(ctx, record, registered, { unchangedOnly: true })) !== false) {
              await this.remove(ctx, manifest, record, false, tip);
              report.actions.push({ ...key, action: "rolled-back" });
            } else {
              report.actions.push({
                ...key,
                action: "failed",
                detail: `branch ${worktreeBranch(record)} or its worktree holds commits; discard explicitly`,
              });
            }
          } else if (record.state === "removing") {
            await this.remove(ctx, manifest, record, false);
            report.actions.push({ ...key, action: "removed" });
          } else if (!live) {
            report.actions.push({ ...key, action: "missing", detail: `${wt} is gone; discard to drop the record` });
          }
        } catch (error) {
          report.actions.push({ ...key, action: "failed", detail: (error as Error).message });
        }
      }

      const recordedPaths = manifest.records.map((r) => this.pathFor(ctx, r));
      report.orphanWorktrees = registered
        .map((w) => path.resolve(w.path))
        .filter((p) => isInside(ctx.root, p) && !recordedPaths.some((r) => samePath(r, p)));
      const branches = (await this.gitOk(ctx.top, ["for-each-ref", "--format=%(refname)", "refs/heads/assentor/"])).stdout
        .split("\n")
        .map((line) => line.trim().replace(/^refs\/heads\//, ""))
        .filter(Boolean);
      const recordedBranches = new Set(manifest.records.map((r) => worktreeBranch(r)));
      report.orphanBranches = branches.filter((b) => !recordedBranches.has(b));
      return report;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async context(): Promise<RepoContext> {
    if (this.ctx) return this.ctx;
    const res = await execGit(this.repoPath, ["rev-parse", "--show-toplevel"], this.timeoutMs);
    if (res.code !== 0) {
      throw new WorktreeError(`Not a git checkout: ${this.repoPath}`);
    }
    const top = await fs.realpath(res.stdout.trim());
    const root = path.join(top, ASSENTOR_DIR, "worktrees");
    this.ctx = { top, root, manifestFile: path.join(root, "manifest.json") };
    return this.ctx;
  }

  private async locked<T>(fn: (ctx: RepoContext) => Promise<T>): Promise<T> {
    const ctx = await this.context();
    return serialize(ctx.top, async () => {
      await fs.mkdir(ctx.root, { recursive: true });
      await this.assertNoSymlink(ctx, ctx.root);
      return fn(ctx);
    });
  }

  private pathFor(ctx: RepoContext, seat: SeatKey): string {
    const p = path.join(ctx.top, ...worktreeRelativePath(seat).split("/"));
    if (!isInside(ctx.root, p)) {
      throw new WorktreeError(`Worktree path escapes ${ctx.root}: ${p}`);
    }
    return p;
  }

  private info(ctx: RepoContext, r: WorktreeRecord): WorktreeInfo {
    return { ...r, path: this.pathFor(ctx, r), branch: worktreeBranch(r) };
  }

  private async git(
    cwd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    timeoutMs = this.timeoutMs,
  ): Promise<GitRun> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await execGit(cwd, args, timeoutMs, env);
      if (res.code === 0 || attempt >= LOCK_RETRIES || !LOCK_ERROR_RE.test(res.stderr)) {
        return res;
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }

  private async gitOk(
    cwd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    timeoutMs = this.timeoutMs,
  ): Promise<GitRun> {
    const res = await this.git(cwd, args, env, timeoutMs);
    if (res.code !== 0) {
      throw new GitError(res.stderr.trim() || `git ${args.join(" ")} exited ${res.code}`);
    }
    return res;
  }

  /** Uncommitted changes, untracked files included; Assentor's own dir excluded. */
  private async isDirty(cwd: string): Promise<boolean> {
    const res = await this.gitOk(cwd, [
      "status", "--porcelain", "--untracked-files=all", "--", ".", `:(exclude)${ASSENTOR_DIR}`,
    ]);
    return res.stdout.trim().length > 0;
  }

  private async branchExists(ctx: RepoContext, branch: string): Promise<boolean> {
    return (await this.git(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }

  private async branchTip(ctx: RepoContext, record: SeatKey): Promise<string | null> {
    const res = await this.git(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktreeBranch(record)}`]);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  /**
   * The branch tip that may be deleted without losing work (`null`: no branch),
   * or `false` when removing the seat would lose commits. Safe means: the seat
   * worktree (if registered) is on its branch at that tip, and the tip is the
   * base, the tip that was applied, or (unless `unchangedOnly`) merged into the
   * main checkout's HEAD.
   */
  private async disposableTip(
    ctx: RepoContext,
    record: WorktreeRecord,
    registered: RegisteredWorktree[],
    options: { unchangedOnly?: boolean } = {},
  ): Promise<string | null | false> {
    const branch = worktreeBranch(record);
    const tip = await this.branchTip(ctx, record);
    const wt = registered.find((w) => samePath(w.path, this.pathFor(ctx, record)));
    // Commits on a detached HEAD or another branch in the seat worktree would vanish with it.
    if (wt && (wt.branch !== branch || wt.head !== tip)) return false;
    if (tip === null || tip === record.baseSha) return tip;
    if (options.unchangedOnly) return false;
    if (record.outcome === "applied" && record.appliedTip === tip) return tip;
    return (await this.git(ctx.top, ["merge-base", "--is-ancestor", tip, "HEAD"])).code === 0 ? tip : false;
  }

  /** `-c` identity for internal commits, only for the parts the user has not configured. */
  private async identityFallback(cwd: string): Promise<string[]> {
    const args: string[] = [];
    if ((await this.git(cwd, ["config", "--get", "user.name"])).code !== 0) args.push("-c", "user.name=Assentor");
    if ((await this.git(cwd, ["config", "--get", "user.email"])).code !== 0) args.push("-c", "user.email=assentor@localhost");
    return args;
  }

  /** Refuse when `p` (or its deepest existing ancestor) is reached through a symlink. */
  private async assertNoSymlink(ctx: RepoContext, p: string): Promise<void> {
    for (let dir = p; samePath(dir, ctx.root) || isInside(ctx.root, dir); dir = path.dirname(dir)) {
      let real: string;
      try {
        real = await fs.realpath(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!samePath(real, dir)) {
        throw new WorktreeError(`${dir} resolves to ${real}; refusing to manage worktrees through a symlink`);
      }
      return;
    }
  }

  /**
   * Git overwrites untracked and ignored files when a merge brings in the same
   * path (e.g. a seat force-adding `.env`). Refuse those, and any change to
   * Assentor's own state under `.assentor/`. Compared case-insensitively so it
   * also holds on macOS/Windows file systems.
   */
  private async assertSafeToWrite(targetPath: string, strategy: ApplyStrategy, baseSha: string, tip: string): Promise<void> {
    let from = baseSha;
    if (strategy !== "patch") {
      const mergeBase = await this.git(targetPath, ["merge-base", "HEAD", tip]);
      if (mergeBase.code === 0) from = mergeBase.stdout.trim();
    }
    const changed = (await this.gitOk(targetPath, ["diff-tree", "-r", "--name-only", "--no-renames", "-z", from, tip])).stdout
      .split("\0")
      .filter(Boolean);
    const internal = changed.filter((p) => {
      const lower = p.toLowerCase();
      return lower === ASSENTOR_DIR || lower.startsWith(`${ASSENTOR_DIR}/`);
    });
    if (internal.length > 0) {
      throw new WorktreeError(`Seat work changes Assentor state (${internal.join(", ")}); refusing to apply`);
    }
    const present = (await this.gitOk(targetPath, [
      "status", "--porcelain", "-z", "--ignored=matching", "--untracked-files=normal",
    ])).stdout
      .split("\0")
      .filter((entry) => entry.startsWith("?? ") || entry.startsWith("!! "))
      .map((entry) => entry.slice(3).toLowerCase().replace(/\/$/, ""));
    // Either side may contain the other: a seat file `build` replaces an ignored dir
    // `build/`, and a seat file `cfg/x` replaces an ignored file or symlink `cfg`.
    const clobbered = changed.filter((p) => {
      const lower = p.toLowerCase();
      return present.some((e) => lower === e || lower.startsWith(`${e}/`) || e.startsWith(`${lower}/`));
    });
    if (clobbered.length > 0) {
      throw new WorktreeError(
        `Applying would overwrite untracked or ignored files in ${targetPath}: ${clobbered.join(", ")}`,
      );
    }
  }

  private async registeredWorktrees(ctx: RepoContext): Promise<RegisteredWorktree[]> {
    const out = (await this.gitOk(ctx.top, ["worktree", "list", "--porcelain", "-z"])).stdout;
    const list: RegisteredWorktree[] = [];
    for (const field of out.split("\0")) {
      const last = list[list.length - 1];
      if (field.startsWith("worktree ")) list.push({ path: field.slice("worktree ".length) });
      else if (field.startsWith("HEAD ") && last) last.head = field.slice("HEAD ".length);
      else if (field.startsWith("branch ") && last) last.branch = field.slice("branch refs/heads/".length);
    }
    return list;
  }

  private async requireReady(ctx: RepoContext, seat: SeatKey): Promise<WorktreeRecord> {
    assertSeatKey(seat);
    const record = (await this.readManifest(ctx)).records.find((r) => sameSeat(r, seat));
    if (!record || record.state !== "ready") {
      throw new WorktreeError(
        `No ready worktree for ${seat.sessionId}/${seat.seatId}${record ? ` (state: ${record.state}; run reconcile)` : ""}`,
      );
    }
    const wt = this.pathFor(ctx, record);
    await this.assertNoSymlink(ctx, wt);
    if (!(await exists(wt))) {
      throw new WorktreeError(`Worktree for ${seat.sessionId}/${seat.seatId} is missing on disk; discard it`);
    }
    return record;
  }

  /**
   * Idempotent removal of a recorded worktree and its branch, intent recorded
   * first. `tip` is the branch tip the caller verified as safe to delete (`null`:
   * none); `undefined` keeps the tip stored by an earlier, interrupted removal.
   * The branch is deleted compare-and-delete, so a branch that moved is kept.
   */
  private async remove(
    ctx: RepoContext,
    manifest: Manifest,
    record: WorktreeRecord,
    force: boolean,
    tip?: string | null,
  ): Promise<void> {
    if (record.state !== "removing" || tip !== undefined) {
      record.state = "removing";
      if (tip !== undefined) {
        if (tip === null) delete record.removeTip;
        else record.removeTip = tip;
      }
      await this.writeManifest(ctx, manifest);
    }
    const wt = this.pathFor(ctx, record);
    await this.assertNoSymlink(ctx, wt);
    const registered = await this.registeredWorktrees(ctx);
    if (samePath(wt, ctx.top) || samePath(wt, registered[0]?.path ?? ctx.top)) {
      throw new WorktreeError("Refusing to remove the main checkout");
    }
    const isRegistered = registered.some((w) => samePath(w.path, wt));
    if (isRegistered) {
      await this.gitOk(ctx.top, ["worktree", "remove", ...(force ? ["--force"] : []), "--", wt]);
    } else if (await exists(wt)) {
      throw new WorktreeError(`${wt} exists but is not a registered git worktree; remove it by hand`);
    }
    const branch = worktreeBranch(record);
    const current = await this.branchTip(ctx, record);
    if (current !== null) {
      if (current !== record.removeTip) {
        throw new WorktreeError(
          `Seat branch ${branch} moved after removal began; run discard to drop it, or apply it first`,
        );
      }
      // Atomic check-and-delete: fails, keeping the branch, if it moved since it was verified.
      await this.gitOk(ctx.top, ["update-ref", "-d", `refs/heads/${branch}`, record.removeTip]);
    }
    manifest.records = manifest.records.filter((r) => r !== record);
    await this.writeManifest(ctx, manifest);
    // Only removes the session dir when empty; anything else in it is left alone.
    await fs.rmdir(path.dirname(wt)).catch(() => undefined);
  }

  private async runApply(
    targetPath: string,
    strategy: ApplyStrategy,
    baseSha: string,
    tip: string,
    message: string,
  ): Promise<ApplyResult> {
    if (strategy === "patch") {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-patch-"));
      try {
        const patchFile = path.join(tmp, "seat.patch");
        // Plumbing: no external diff drivers, textconv, colour or custom prefixes from user config.
        const patch = (await this.gitOk(targetPath, ["diff-tree", "-p", "--binary", "--full-index", baseSha, tip])).stdout;
        if (!patch.trim()) {
          throw new WorktreeError(`Seat commits ${baseSha.slice(0, 12)}..${tip.slice(0, 12)} have no net changes; nothing to patch`);
        }
        await fs.writeFile(patchFile, patch);
        // `git apply` is atomic: on any failure nothing is written.
        const res = await this.git(targetPath, ["apply", "--index", "--", patchFile]);
        if (res.code === 0) return { ok: true, strategy, changed: true };
        const conflicts = [...res.stderr.matchAll(/^error: (?!patch failed)(.+?): /gm)].map((m) => m[1]!);
        return { ok: false, strategy, conflicts: [...new Set(conflicts)], message: res.stderr.trim() };
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }

    const before = (await this.gitOk(targetPath, ["rev-parse", "HEAD"])).stdout.trim();
    const args =
      strategy === "merge"
        ? ["merge", "--no-ff", "-m", message, tip]
        : ["merge", "--squash", tip];
    try {
      const res = await this.git(targetPath, args, undefined, HOOK_TIMEOUT_MS);
      if (res.code !== 0) {
        const conflicts = (await this.git(targetPath, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout
          .split("\0")
          .filter(Boolean);
        await this.restoreTarget(targetPath);
        return { ok: false, strategy, conflicts, message: (res.stderr || res.stdout).trim() };
      }
      if (strategy === "squash") {
        if ((await this.git(targetPath, ["diff", "--cached", "--quiet"])).code === 0) {
          return { ok: true, strategy, changed: false };
        }
        await this.gitOk(targetPath, ["commit", "-m", message], undefined, HOOK_TIMEOUT_MS);
      }
      const commit = (await this.gitOk(targetPath, ["rev-parse", "HEAD"])).stdout.trim();
      return { ok: true, strategy, changed: commit !== before, commit };
    } catch (error) {
      // The commit landed and only a later hook failed or was killed: the apply succeeded.
      const now = (await this.git(targetPath, ["rev-parse", "HEAD"]).catch(() => undefined))?.stdout.trim();
      if (now && now !== before) {
        return {
          ok: true,
          strategy,
          changed: true,
          commit: now,
          warning: `Applied as ${now.slice(0, 12)}, but a hook after the commit failed: ${(error as Error).message}`,
        };
      }
      // Hook failure, timeout or kill mid-merge: never leave a partial merge behind.
      try {
        await this.restoreTarget(targetPath);
      } catch (restoreError) {
        throw new WorktreeError(
          `Apply failed (${(error as Error).message}) and restoring ${targetPath} also failed ` +
            `(${(restoreError as Error).message}); inspect it by hand`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** The target was verified clean before applying, so this restores it exactly. */
  private async restoreTarget(targetPath: string): Promise<void> {
    await this.gitOk(targetPath, ["reset", "--merge"]);
  }

  private async readManifest(ctx: RepoContext): Promise<Manifest> {
    let raw: string;
    try {
      raw = await fs.readFile(ctx.manifestFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
      throw error;
    }
    try {
      return ManifestSchema.parse(JSON.parse(raw));
    } catch (error) {
      // Never overwrite a manifest we cannot read: it is the only proof of ownership.
      throw new WorktreeError(`Worktree manifest is unreadable: ${ctx.manifestFile}. Fix or move it aside.`, { cause: error });
    }
  }

  private async writeManifest(ctx: RepoContext, manifest: Manifest): Promise<void> {
    await writeJsonAtomic(ctx.manifestFile, manifest);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
