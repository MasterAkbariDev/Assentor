import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorktreeManager,
  shortSeatName,
  worktreeRelativePath,
  type SeatKey,
} from "../../src/worktrees/index.js";

const exec = promisify(execFile);
// Every test drives real git in temp repos; Windows CI is slow at process spawns.
vi.setConfig({ testTimeout: 60_000 });
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-wt-")));
  dirs.push(dir);
  await git(dir, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "assentor@test");
  await git(dir, "config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n");
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const manifestPath = (repo: string) => path.join(repo, ".assentor", "worktrees", "manifest.json");

async function readManifest(repo: string): Promise<{ version: 1; records: Array<Record<string, unknown>> }> {
  return JSON.parse(await fs.readFile(manifestPath(repo), "utf8"));
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("WorktreeManager: create / diff / apply / cleanup", () => {
  it("creates a short-path worktree on its own branch and diffs everything since base", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create(S1, "opus-1");
    expect(info.path).toBe(path.join(repo, ".assentor", "worktrees", "11111111", "opus-1"));
    expect(info.branch).toBe("assentor/11111111/opus-1");
    expect(info.state).toBe("ready");
    expect(await git(info.path, "symbolic-ref", "HEAD")).toBe("refs/heads/assentor/11111111/opus-1");

    await fs.writeFile(path.join(info.path, "a.txt"), "two\n");
    await fs.writeFile(path.join(info.path, "new.txt"), "fresh\n");
    const d = await wm.diff({ sessionId: S1, seatId: "opus-1" });
    expect(d.dirty).toBe(true);
    expect(d.files.sort()).toEqual(["a.txt", "new.txt"]);
    expect(d.diff).toContain("+two");
    expect(d.diff).toContain("+fresh");
    // The seat's own index is untouched: new.txt is still untracked there.
    expect(await git(info.path, "status", "--porcelain")).toContain("?? new.txt");

    expect((await wm.list(S1)).map((w) => w.seatId)).toEqual(["opus-1"]);
    expect(await wm.list(S2)).toEqual([]);
  });

  it("merges a seat into main, then cleanup removes its worktree and branch", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const seat = { sessionId: S1, seatId: "opus-1" };
    const info = await wm.create(S1, "opus-1");
    await fs.writeFile(path.join(info.path, "b.txt"), "seat work\n");

    const res = await wm.applyTo("main", seat, { strategy: "merge" });
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(await fs.readFile(path.join(repo, "b.txt"), "utf8")).toBe("seat work\n");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect((await wm.list(S1))[0]?.outcome).toBe("applied");

    const report = await wm.cleanup(S1);
    expect(report.removed).toEqual([seat]);
    expect(await exists(info.path)).toBe(false);
    expect(await branchExists(repo, info.branch)).toBe(false);
    expect((await readManifest(repo)).records).toEqual([]);
    expect(await exists(path.join(repo, "a.txt"))).toBe(true);
  });

  it("squashes into another seat's worktree and patches main without committing", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const task = await wm.create(S1, "task");
    const coder = await wm.create(S1, "coder-1");
    await fs.writeFile(path.join(coder.path, "c.txt"), "coded\n");

    const squash = await wm.applyTo({ sessionId: S1, seatId: "task" }, { sessionId: S1, seatId: "coder-1" }, { strategy: "squash" });
    expect(squash).toMatchObject({ ok: true, changed: true });
    expect(await fs.readFile(path.join(task.path, "c.txt"), "utf8")).toBe("coded\n");
    expect(await git(task.path, "rev-list", "--count", "HEAD")).toBe("2");

    const head = await git(repo, "rev-parse", "HEAD");
    const patch = await wm.applyTo("main", { sessionId: S1, seatId: "task" }, { strategy: "patch" });
    expect(patch).toMatchObject({ ok: true, changed: true });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await git(repo, "status", "--porcelain")).toBe("A  c.txt");
  });

  it("reports no change when the seat did nothing", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await wm.create(S1, "idle-1");
    expect(await wm.applyTo("main", { sessionId: S1, seatId: "idle-1" }, { strategy: "merge" })).toEqual({
      ok: true,
      strategy: "merge",
      changed: false,
    });
  });
});

describe("WorktreeManager: conflicts leave nothing behind", () => {
  for (const strategy of ["merge", "squash", "patch"] as const) {
    it(`${strategy}: returns conflicting files and restores the target`, async () => {
      const repo = await makeRepo();
      const wm = new WorktreeManager({ repoPath: repo });
      const info = await wm.create(S1, "opus-1");
      await fs.writeFile(path.join(info.path, "a.txt"), "seat\n");
      await fs.writeFile(path.join(repo, "a.txt"), "main\n");
      await git(repo, "commit", "-q", "-am", "main change");
      const head = await git(repo, "rev-parse", "HEAD");

      const res = await wm.applyTo("main", { sessionId: S1, seatId: "opus-1" }, { strategy });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.conflicts).toEqual(["a.txt"]);
      expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
      expect(await git(repo, "status", "--porcelain")).toBe("");
      expect(await exists(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
      expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("main\n");
      expect((await wm.list(S1))[0]?.outcome).toBeUndefined();
    });
  }
});

describe("WorktreeManager: refusals", () => {
  it("refuses to create from a dirty main checkout unless opted in", async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, "a.txt"), "uncommitted\n");
    await expect(new WorktreeManager({ repoPath: repo }).create(S1, "opus-1")).rejects.toThrow(/uncommitted changes/);
    expect(await exists(manifestPath(repo))).toBe(false);
    const info = await new WorktreeManager({ repoPath: repo, allowDirtyMain: true }).create(S1, "opus-1");
    expect(await exists(info.path)).toBe(true);
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("refuses to apply into a dirty target", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create(S1, "opus-1");
    await fs.writeFile(path.join(info.path, "b.txt"), "x\n");
    await fs.writeFile(path.join(repo, "user.txt"), "user work\n");
    await expect(wm.applyTo("main", { sessionId: S1, seatId: "opus-1" }, { strategy: "merge" })).rejects.toThrow(/uncommitted/);
    expect(await fs.readFile(path.join(repo, "user.txt"), "utf8")).toBe("user work\n");
  });

  it("refuses to discard a worktree with uncommitted changes unless forced", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const seat = { sessionId: S1, seatId: "opus-1" };
    const info = await wm.create(S1, "opus-1");
    await fs.writeFile(path.join(info.path, "wip.txt"), "wip\n");
    await expect(wm.discard(seat)).rejects.toThrow(/uncommitted changes/);
    expect(await fs.readFile(path.join(info.path, "wip.txt"), "utf8")).toBe("wip\n");

    await wm.discard(seat, { force: true });
    expect(await exists(info.path)).toBe(false);
    expect(await branchExists(repo, info.branch)).toBe(false);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await exists(path.join(repo, "a.txt"))).toBe(true);
  });

  it("explicit discard deletes unmerged commits; cleanup keeps dirty, failed and unmerged work", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const dirty = await wm.create(S1, "dirty-1");
    const failed = await wm.create(S1, "failed-1");
    const unmerged = await wm.create(S1, "unmerged-1");
    const idle = await wm.create(S1, "idle-1");
    await fs.writeFile(path.join(dirty.path, "x.txt"), "x\n");
    await wm.markFailed({ sessionId: S1, seatId: "failed-1" });
    await fs.writeFile(path.join(unmerged.path, "u.txt"), "u\n");
    await git(unmerged.path, "add", ".");
    await git(unmerged.path, "commit", "-q", "-m", "seat commit");

    const report = await wm.cleanup(S1);
    expect(report.removed).toEqual([{ sessionId: S1, seatId: "idle-1" }]);
    expect(report.kept.map((k) => [k.seatId, k.reason]).sort()).toEqual([
      ["dirty-1", "dirty"],
      ["failed-1", "failed"],
      ["unmerged-1", "unmerged"],
    ]);
    expect(await exists(idle.path)).toBe(false);
    for (const p of [dirty.path, failed.path, unmerged.path]) expect(await exists(p)).toBe(true);

    expect((await wm.cleanup(S1, { keepFailed: false })).removed).toEqual([{ sessionId: S1, seatId: "failed-1" }]);
    await wm.discard({ sessionId: S1, seatId: "unmerged-1" });
    expect(await branchExists(repo, unmerged.branch)).toBe(false);
  });

  it("never removes worktrees or branches it did not record", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await wm.create(S1, "opus-1");
    const foreign = path.join(repo, ".assentor", "worktrees", "11111111", "foreign");
    await git(repo, "worktree", "add", "-q", "-b", "assentor/11111111/foreign", foreign);
    await git(repo, "branch", "assentor/99999999/stray");

    await expect(wm.discard({ sessionId: S1, seatId: "foreign" })).rejects.toThrow(/No worktree recorded/);
    expect((await wm.cleanup(S1)).removed).toEqual([{ sessionId: S1, seatId: "opus-1" }]);
    const report = await wm.reconcile();
    expect(report.orphanWorktrees).toEqual([foreign]);
    expect(report.orphanBranches.sort()).toEqual(["assentor/11111111/foreign", "assentor/99999999/stray"]);
    expect(await exists(foreign)).toBe(true);
    expect(await branchExists(repo, "assentor/99999999/stray")).toBe(true);
  });

  it("refuses to work through a symlinked .assentor directory", async () => {
    if (process.platform === "win32") return;
    const repo = await makeRepo();
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-elsewhere-"));
    dirs.push(elsewhere);
    await fs.symlink(elsewhere, path.join(repo, ".assentor"));
    await expect(new WorktreeManager({ repoPath: repo }).create(S1, "opus-1")).rejects.toThrow(/symlink/);
    expect(await fs.readdir(elsewhere)).toEqual(["worktrees"]);
    expect(await fs.readdir(path.join(elsewhere, "worktrees"))).toEqual([]);
  });
});

describe("WorktreeManager: path and name validation", () => {
  const bad = ["../x", "..", "a..b", "a/b", "a\\b", "-rf", "--force", "", "Opus-1", "x.lock", "con", "nul.opus-1", "a b", ".hidden", "trail."];
  it("rejects traversal, option-like and unsafe seat ids without touching git", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    for (const seatId of bad) {
      await expect(wm.create(S1, seatId), seatId).rejects.toThrow(/Invalid seat id/);
      await expect(wm.discard({ sessionId: S1, seatId }), seatId).rejects.toThrow(/Invalid seat id/);
    }
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(".assentor");
    expect(await git(repo, "for-each-ref", "refs/heads/assentor/")).toBe("");
  });

  it("rejects non-UUID session ids and option-like or unknown base refs", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await expect(wm.create("../../etc", "opus-1")).rejects.toThrow(/Invalid session id/);
    await expect(wm.create(S1, "opus-1", "--output=/tmp/pwned")).rejects.toThrow(/Invalid base ref/);
    await expect(wm.create(S1, "opus-1", "HEAD; rm -rf /")).rejects.toThrow(/Invalid base ref/);
    await expect(wm.create(S1, "opus-1", "no-such-ref")).rejects.toThrow(/does not name a commit/);
    expect(await wm.list()).toEqual([]);
    expect(await branchExists(repo, "assentor/11111111/opus-1")).toBe(false);
  });

  it("keeps worktree paths short for Windows MAX_PATH and unique for long ids", () => {
    const longA = `${"review-panel.".repeat(7)}opus-1`.slice(0, 98) + "-1";
    const longB = `${"review-panel.".repeat(7)}opus-1`.slice(0, 98) + "-2";
    const rel = worktreeRelativePath({ sessionId: S1, seatId: longA });
    expect(rel.length).toBeLessThanOrEqual(50);
    expect(shortSeatName(longA)).not.toBe(shortSeatName(longB));
    expect(shortSeatName(longA)).toMatch(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
  });
});

describe("WorktreeManager: crash recovery", () => {
  async function setState(repo: string, seatId: string, state: string): Promise<void> {
    const m = await readManifest(repo);
    for (const r of m.records) if (r.seatId === seatId) r.state = state;
    await fs.writeFile(manifestPath(repo), JSON.stringify(m));
  }

  it("completes a create that crashed after `git worktree add`", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await wm.create(S1, "opus-1");
    await setState(repo, "opus-1", "creating");
    await expect(wm.diff({ sessionId: S1, seatId: "opus-1" })).rejects.toThrow(/run reconcile/);

    const report = await wm.reconcile();
    expect(report.actions).toEqual([{ sessionId: S1, seatId: "opus-1", action: "completed" }]);
    expect((await wm.list())[0]?.state).toBe("ready");
  });

  it("rolls back a create that crashed before the worktree existed", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const head = await git(repo, "rev-parse", "HEAD");
    // Intent written and branch created, then the process died.
    await fs.mkdir(path.dirname(manifestPath(repo)), { recursive: true });
    await fs.writeFile(
      manifestPath(repo),
      JSON.stringify({ version: 1, records: [{ sessionId: S1, seatId: "opus-1", baseSha: head, state: "creating", createdAt: "x" }] }),
    );
    await git(repo, "branch", "assentor/11111111/opus-1", head);

    const report = await wm.reconcile();
    expect(report.actions).toEqual([{ sessionId: S1, seatId: "opus-1", action: "rolled-back" }]);
    expect(await branchExists(repo, "assentor/11111111/opus-1")).toBe(false);
    expect(await wm.list()).toEqual([]);
    // The seat can be created again afterwards.
    expect((await wm.create(S1, "opus-1")).state).toBe("ready");
  });

  it("does not roll back a crashed create whose branch already has commits", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create(S1, "opus-1");
    await fs.writeFile(path.join(info.path, "w.txt"), "w\n");
    await git(info.path, "add", ".");
    await git(info.path, "commit", "-q", "-m", "work");
    await git(repo, "worktree", "remove", info.path);
    await setState(repo, "opus-1", "creating");

    const report = await wm.reconcile();
    expect(report.actions[0]?.action).toBe("failed");
    expect(await branchExists(repo, info.branch)).toBe(true);
  });

  it("interrupted removal is finished idempotently by cleanup and reconcile", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const a = await wm.create(S1, "a-1");
    const b = await wm.create(S1, "b-1");
    // Crash after the worktree was removed but before branch deletion / record drop.
    await setState(repo, "a-1", "removing");
    await setState(repo, "b-1", "removing");
    await git(repo, "worktree", "remove", a.path);

    expect((await wm.cleanup(S1)).removed).toEqual([{ sessionId: S1, seatId: "a-1" }, { sessionId: S1, seatId: "b-1" }]);
    expect(await branchExists(repo, a.branch)).toBe(false);
    expect(await exists(b.path)).toBe(false);
    expect((await wm.cleanup(S1)).removed).toEqual([]);
    expect((await wm.reconcile()).actions).toEqual([]);
  });

  it("reports a recorded worktree whose directory vanished; discard drops it", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create(S1, "opus-1");
    await fs.rm(info.path, { recursive: true, force: true });

    const report = await wm.reconcile();
    expect(report.actions.map((a) => a.action)).toEqual(["missing"]);
    await wm.discard({ sessionId: S1, seatId: "opus-1" });
    expect(await wm.list()).toEqual([]);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(".assentor");
  });

  it("never overwrites an unreadable manifest", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.dirname(manifestPath(repo)), { recursive: true });
    await fs.writeFile(manifestPath(repo), "{ not json");
    const wm = new WorktreeManager({ repoPath: repo });
    await expect(wm.create(S1, "opus-1")).rejects.toThrow(/manifest is unreadable/);
    await expect(wm.reconcile()).rejects.toThrow(/manifest is unreadable/);
    expect(await fs.readFile(manifestPath(repo), "utf8")).toBe("{ not json");
  });

  it("refuses an existing path or branch it did not create", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await git(repo, "branch", "assentor/11111111/opus-1");
    await expect(wm.create(S1, "opus-1")).rejects.toThrow(/existing branch/);
    await fs.mkdir(path.join(repo, ".assentor", "worktrees", "11111111", "opus-2"), { recursive: true });
    await expect(wm.create(S1, "opus-2")).rejects.toThrow(/existing path/);
    expect(await wm.list()).toEqual([]);
  });
});

describe("WorktreeManager: concurrency", () => {
  it("parallel creates from several managers never collide", async () => {
    const repo = await makeRepo();
    const managers = [new WorktreeManager({ repoPath: repo }), new WorktreeManager({ repoPath: path.join(repo, ".") })];
    const seats: SeatKey[] = [];
    for (const sessionId of [S1, S2]) for (let i = 1; i <= 4; i += 1) seats.push({ sessionId, seatId: `opus-${i}` });

    const created = await Promise.all(seats.map((s, i) => managers[i % 2]!.create(s.sessionId, s.seatId)));
    expect(new Set(created.map((c) => c.path)).size).toBe(8);
    expect(new Set(created.map((c) => c.branch)).size).toBe(8);
    expect((await readManifest(repo)).records).toHaveLength(8);

    const dup = await Promise.allSettled([managers[0]!.create(S1, "dup-1"), managers[1]!.create(S1, "dup-1")]);
    expect(dup.map((d) => d.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await managers[0]!.list(S1)).toHaveLength(5);
  });

  it("retries when another git process holds the index lock", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create(S1, "opus-1");
    await fs.writeFile(path.join(info.path, "b.txt"), "x\n");
    const lock = path.join(repo, ".git", "index.lock");
    await fs.writeFile(lock, "");
    setTimeout(() => void fs.rm(lock, { force: true }), 400);
    const res = await wm.applyTo("main", { sessionId: S1, seatId: "opus-1" }, { strategy: "merge" });
    expect(res).toMatchObject({ ok: true, changed: true });
  });
});
