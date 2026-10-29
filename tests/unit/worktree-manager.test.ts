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
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n.env\n");
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
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    const task = await wm.create({ sessionId: S1, seatId: "task" });
    const coder = await wm.create({ sessionId: S1, seatId: "coder-1" });
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
    await wm.create({ sessionId: S1, seatId: "idle-1" });
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
      const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    await expect(new WorktreeManager({ repoPath: repo }).create({ sessionId: S1, seatId: "opus-1" })).rejects.toThrow(/uncommitted changes/);
    expect(await exists(manifestPath(repo))).toBe(false);
    const info = await new WorktreeManager({ repoPath: repo, allowDirtyMain: true }).create({ sessionId: S1, seatId: "opus-1" });
    expect(await exists(info.path)).toBe(true);
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("refuses to apply into a dirty target", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
    await fs.writeFile(path.join(info.path, "b.txt"), "x\n");
    await fs.writeFile(path.join(repo, "user.txt"), "user work\n");
    await expect(wm.applyTo("main", { sessionId: S1, seatId: "opus-1" }, { strategy: "merge" })).rejects.toThrow(/uncommitted/);
    expect(await fs.readFile(path.join(repo, "user.txt"), "utf8")).toBe("user work\n");
  });

  it("refuses to discard a worktree with uncommitted changes unless forced", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const seat = { sessionId: S1, seatId: "opus-1" };
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    const dirty = await wm.create({ sessionId: S1, seatId: "dirty-1" });
    const failed = await wm.create({ sessionId: S1, seatId: "failed-1" });
    const unmerged = await wm.create({ sessionId: S1, seatId: "unmerged-1" });
    const idle = await wm.create({ sessionId: S1, seatId: "idle-1" });
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
    await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    await expect(new WorktreeManager({ repoPath: repo }).create({ sessionId: S1, seatId: "opus-1" })).rejects.toThrow(/symlink/);
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
      await expect(wm.create({ sessionId: S1, seatId: seatId }), seatId).rejects.toThrow(/Invalid seat id/);
      await expect(wm.discard({ sessionId: S1, seatId }), seatId).rejects.toThrow(/Invalid seat id/);
    }
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(".assentor");
    expect(await git(repo, "for-each-ref", "refs/heads/assentor/")).toBe("");
  });

  it("rejects non-UUID session ids and option-like or unknown base refs", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await expect(wm.create({ sessionId: "../../etc", seatId: "opus-1" })).rejects.toThrow(/Invalid session id/);
    await expect(wm.create({ sessionId: S1, seatId: "opus-1" }, "--output=/tmp/pwned")).rejects.toThrow(/Invalid base ref/);
    await expect(wm.create({ sessionId: S1, seatId: "opus-1" }, "HEAD; rm -rf /")).rejects.toThrow(/Invalid base ref/);
    await expect(wm.create({ sessionId: S1, seatId: "opus-1" }, "no-such-ref")).rejects.toThrow(/does not name a commit/);
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
  async function setState(repo: string, seatId: string, state: string, extra: Record<string, unknown> = {}): Promise<void> {
    const m = await readManifest(repo);
    for (const r of m.records) if (r.seatId === seatId) Object.assign(r, { state, ...extra });
    await fs.writeFile(manifestPath(repo), JSON.stringify(m));
  }

  it("completes a create that crashed after `git worktree add`", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    expect((await wm.create({ sessionId: S1, seatId: "opus-1" })).state).toBe("ready");
  });

  it("does not roll back a crashed create whose branch already has commits", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    const a = await wm.create({ sessionId: S1, seatId: "a-1" });
    const b = await wm.create({ sessionId: S1, seatId: "b-1" });
    // Crash after the worktree was removed but before branch deletion / record drop.
    const base = await git(repo, "rev-parse", "HEAD");
    await setState(repo, "a-1", "removing", { removeTip: base });
    await setState(repo, "b-1", "removing", { removeTip: base });
    await git(repo, "worktree", "remove", a.path);

    expect((await wm.cleanup(S1)).removed).toEqual([{ sessionId: S1, seatId: "a-1" }, { sessionId: S1, seatId: "b-1" }]);
    expect(await branchExists(repo, a.branch)).toBe(false);
    expect(await exists(b.path)).toBe(false);
    expect((await wm.cleanup(S1)).removed).toEqual([]);
    expect((await wm.reconcile()).actions).toEqual([]);
  });

  it("an interrupted removal keeps a branch that moved past the verified tip", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
    const base = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(info.path, "late.txt"), "late\n");
    await git(info.path, "add", ".");
    await git(info.path, "commit", "-q", "-m", "late work");
    const late = await git(info.path, "rev-parse", "HEAD");
    await git(repo, "worktree", "remove", info.path);
    await setState(repo, "opus-1", "removing", { removeTip: base });

    const report = await wm.reconcile();
    expect(report.actions[0]).toMatchObject({ action: "failed", detail: expect.stringMatching(/moved after removal began; run discard/) });
    expect(await git(repo, "rev-parse", info.branch)).toBe(late);
    // A removal record without a verified tip never deletes the branch either.
    await setState(repo, "opus-1", "removing", { removeTip: undefined });
    expect((await wm.cleanup(S1)).kept[0]?.reason).toBe("error");
    expect(await git(repo, "rev-parse", info.branch)).toBe(late);
  });

  it("reports a recorded worktree whose directory vanished; discard drops it", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
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
    await expect(wm.create({ sessionId: S1, seatId: "opus-1" })).rejects.toThrow(/manifest is unreadable/);
    await expect(wm.reconcile()).rejects.toThrow(/manifest is unreadable/);
    expect(await fs.readFile(manifestPath(repo), "utf8")).toBe("{ not json");
  });

  it("refuses an existing path or branch it did not create", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    await git(repo, "branch", "assentor/11111111/opus-1");
    await expect(wm.create({ sessionId: S1, seatId: "opus-1" })).rejects.toThrow(/existing branch/);
    await fs.mkdir(path.join(repo, ".assentor", "worktrees", "11111111", "opus-2"), { recursive: true });
    await expect(wm.create({ sessionId: S1, seatId: "opus-2" })).rejects.toThrow(/existing path/);
    expect(await wm.list()).toEqual([]);
  });
});

describe("WorktreeManager: concurrency", () => {
  it("parallel creates from several managers never collide", async () => {
    const repo = await makeRepo();
    const managers = [new WorktreeManager({ repoPath: repo }), new WorktreeManager({ repoPath: path.join(repo, ".") })];
    const seats: SeatKey[] = [];
    for (const sessionId of [S1, S2]) for (let i = 1; i <= 4; i += 1) seats.push({ sessionId, seatId: `opus-${i}` });

    const created = await Promise.all(seats.map((s, i) => managers[i % 2]!.create({ sessionId: s.sessionId, seatId: s.seatId })));
    expect(new Set(created.map((c) => c.path)).size).toBe(8);
    expect(new Set(created.map((c) => c.branch)).size).toBe(8);
    expect((await readManifest(repo)).records).toHaveLength(8);

    const dup = await Promise.allSettled([managers[0]!.create({ sessionId: S1, seatId: "dup-1" }), managers[1]!.create({ sessionId: S1, seatId: "dup-1" })]);
    expect(dup.map((d) => d.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await managers[0]!.list(S1)).toHaveLength(5);
  });

  it("retries when another git process holds the index lock", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const info = await wm.create({ sessionId: S1, seatId: "opus-1" });
    await fs.writeFile(path.join(info.path, "b.txt"), "x\n");
    const lock = path.join(repo, ".git", "index.lock");
    await fs.writeFile(lock, "");
    setTimeout(() => void fs.rm(lock, { force: true }), 400);
    const res = await wm.applyTo("main", { sessionId: S1, seatId: "opus-1" }, { strategy: "merge" });
    expect(res).toMatchObject({ ok: true, changed: true });
  });
});

describe("WorktreeManager: review regressions (O2 probe)", () => {
  const seat = { sessionId: S1, seatId: "seat" };

  it("P1: refuses a merge that would overwrite an ignored file in main", async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, ".env"), "SECRET=user\n");
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, ".env"), "SECRET=model\n");
    await git(w.path, "add", "-f", ".env");
    await git(w.path, "commit", "-q", "-m", "x");
    const head = await git(repo, "rev-parse", "HEAD");
    for (const strategy of ["merge", "squash", "patch"] as const) {
      await expect(wm.applyTo("main", seat, { strategy })).rejects.toThrow(/overwrite untracked or ignored files.*\.env/);
    }
    expect(await fs.readFile(path.join(repo, ".env"), "utf8")).toBe("SECRET=user\n");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
  });

  it("P1: also refuses untracked files inside an ignored directory and case variants", async () => {
    const repo = await makeRepo();
    await fs.appendFile(path.join(repo, ".gitignore"), "cache/\n");
    await git(repo, "commit", "-q", "-am", "ignore cache");
    await fs.mkdir(path.join(repo, "cache"));
    await fs.writeFile(path.join(repo, "cache", "data.bin"), "user\n");
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.mkdir(path.join(w.path, "cache"));
    await fs.writeFile(path.join(w.path, "cache", "data.bin"), "model\n");
    await git(w.path, "add", "-f", "cache/data.bin");
    await git(w.path, "commit", "-q", "-m", "x");
    await expect(wm.applyTo("main", seat, { strategy: "merge" })).rejects.toThrow(/cache\/data\.bin/);
    expect(await fs.readFile(path.join(repo, "cache", "data.bin"), "utf8")).toBe("user\n");
  });

  it("P1b: refuses seat work that touches .assentor/ (forged manifest)", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    const forged = path.join(w.path, ".assentor", "worktrees", "manifest.json");
    await fs.mkdir(path.dirname(forged), { recursive: true });
    await fs.writeFile(forged, JSON.stringify({ version: 1, records: [] }));
    await git(w.path, "add", "-f", ".assentor");
    await git(w.path, "commit", "-q", "-m", "x");
    await expect(wm.applyTo("main", seat, { strategy: "merge" })).rejects.toThrow(/Assentor state/);
    expect((await readManifest(repo)).records).toHaveLength(1);
  });

  it("P2: cleanup keeps commits made after a squash apply", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    expect((await wm.applyTo("main", seat, { strategy: "squash" })).ok).toBe(true);
    await fs.writeFile(path.join(w.path, "b.txt"), "2 later work\n");
    await git(w.path, "commit", "-q", "-am", "later");
    const later = await git(w.path, "rev-parse", "HEAD");

    const report = await wm.cleanup(S1);
    expect(report.kept).toEqual([{ ...seat, reason: "unmerged" }]);
    expect(await git(repo, "rev-parse", w.branch)).toBe(later);
  });

  it("P2: cleanup removes a squash-applied seat whose tip did not move", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    await wm.applyTo("main", seat, { strategy: "squash" });
    expect((await wm.cleanup(S1)).removed).toEqual([seat]);
    expect(await branchExists(repo, w.branch)).toBe(false);
  });

  it("P3: cleanup keeps a seat whose worktree has detached-HEAD commits", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await git(w.path, "checkout", "-q", "--detach");
    await fs.writeFile(path.join(w.path, "c.txt"), "work\n");
    await git(w.path, "add", ".");
    await git(w.path, "commit", "-q", "-m", "detached work");
    const sha = await git(w.path, "rev-parse", "HEAD");

    expect((await wm.cleanup(S1)).kept).toEqual([{ ...seat, reason: "unmerged" }]);
    expect(await exists(w.path)).toBe(true);
    expect(await git(w.path, "rev-parse", "HEAD")).toBe(sha);
    // A crashed create in that state is not rolled back either.
    const m = await readManifest(repo);
    m.records[0]!.state = "creating";
    await fs.writeFile(manifestPath(repo), JSON.stringify(m));
    await fs.rename(w.path, `${w.path}-moved`);
    dirs.push(`${w.path}-moved`);
    expect((await wm.reconcile()).actions[0]?.action).toBe("failed");
  });

  it("P4: a squash conflict with added files leaves no state files behind", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "a.txt"), "seat\n");
    await fs.writeFile(path.join(w.path, "new.txt"), "n\n");
    await fs.writeFile(path.join(repo, "a.txt"), "main\n");
    await git(repo, "commit", "-q", "-am", "m");
    const res = await wm.applyTo("main", seat, { strategy: "squash" });
    expect(res.ok).toBe(false);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await exists(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await exists(path.join(repo, ".git", "SQUASH_MSG"))).toBe(false);
    expect(await exists(path.join(repo, "new.txt"))).toBe(false);
  });

  it("P5: a failing pre-commit hook leaves main exactly as it was", async () => {
    if (process.platform === "win32") return;
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const head = await git(repo, "rev-parse", "HEAD");

    await expect(wm.applyTo("main", seat, { strategy: "squash" })).rejects.toThrow();
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
    expect((await wm.list())[0]?.outcome).toBeUndefined();
  });

  it("P6: create on an empty repo records nothing; apply into a detached main is refused", async () => {
    const empty = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-wt-empty-")));
    dirs.push(empty);
    await git(empty, "-c", "init.templateDir=", "init", "-q");
    const e = new WorktreeManager({ repoPath: empty });
    await expect(e.create(seat)).rejects.toThrow(/does not name a commit/);
    expect(await e.list()).toEqual([]);

    const repo = await makeRepo();
    await git(repo, "checkout", "-q", "--detach");
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    await expect(wm.applyTo("main", seat, { strategy: "merge" })).rejects.toThrow(/detached HEAD/);
  });

  it("P7: merges the captured tip, not a same-named tag", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "reviewed\n");
    await git(w.path, "add", ".");
    await git(w.path, "commit", "-q", "-m", "reviewed");
    await fs.writeFile(path.join(w.path, "evil.txt"), "x\n");
    await git(w.path, "add", ".");
    await git(w.path, "commit", "-q", "-m", "unreviewed");
    await git(w.path, "tag", w.branch);
    await git(w.path, "reset", "-q", "--hard", "HEAD~1");

    expect((await wm.applyTo("main", seat, { strategy: "merge" })).ok).toBe(true);
    expect(await exists(path.join(repo, "b.txt"))).toBe(true);
    expect(await exists(path.join(repo, "evil.txt"))).toBe(false);
  });

  it("O2: patch ignores user diff config; an empty net diff is a clear error", async () => {
    const repo = await makeRepo();
    await git(repo, "config", "diff.noprefix", "true");
    await git(repo, "config", "diff.external", "false");
    await git(repo, "config", "color.ui", "always");
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    expect(await wm.applyTo("main", seat, { strategy: "patch" })).toMatchObject({ ok: true, changed: true });
    expect(await git(repo, "status", "--porcelain")).toBe("A  b.txt");

    const other = { sessionId: S1, seatId: "noop" };
    await git(repo, "reset", "-q", "--hard");
    const n = await wm.create(other);
    await fs.writeFile(path.join(n.path, "x.txt"), "x\n");
    await git(n.path, "add", ".");
    await git(n.path, "commit", "-q", "-m", "add");
    await git(n.path, "rm", "-q", "x.txt");
    await git(n.path, "commit", "-q", "-m", "remove");
    await expect(wm.applyTo("main", other, { strategy: "patch" })).rejects.toThrow(/no net changes/);
  });

  it("O4: a patch-applied seat keeps its branch through cleanup", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    await wm.applyTo("main", seat, { strategy: "patch" });
    expect((await wm.list())[0]?.outcome).toBe("applied-patch");
    await git(repo, "reset", "-q", "--hard");
    expect((await wm.cleanup(S1)).kept).toEqual([{ ...seat, reason: "unmerged" }]);
    expect(await branchExists(repo, w.branch)).toBe(true);
  });

  it("O5: snapshot commits fall back to an Assentor identity only when none is configured", async () => {
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    await git(repo, "config", "--unset", "user.email");
    await git(repo, "config", "--unset", "user.name");
    const emptyGlobal = path.join(repo, ".git", "empty-global-config");
    await fs.writeFile(emptyGlobal, "");
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1" });
    for (const k of ["EMAIL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete process.env[k];
    try {
      // Patch needs no commit in main, so only the seat snapshot needs an identity.
      const res = await wm.applyTo("main", seat, { strategy: "patch" });
      expect(res.ok).toBe(true);
      expect(await git(w.path, "log", "-1", "--format=%an <%ae>")).toBe("Assentor <assentor@localhost>");
    } finally {
      process.env = saved;
    }
  });

  it("O6: refuses a symlinked session directory", async () => {
    if (process.platform === "win32") return;
    const repo = await makeRepo();
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-elsewhere-"));
    dirs.push(elsewhere);
    await fs.mkdir(path.join(repo, ".assentor", "worktrees"), { recursive: true });
    await fs.symlink(elsewhere, path.join(repo, ".assentor", "worktrees", "11111111"));
    await expect(new WorktreeManager({ repoPath: repo }).create(seat)).rejects.toThrow(/symlink/);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it("P8: refuses a seat file that would replace an ignored directory", async () => {
    const repo = await makeRepo();
    await fs.appendFile(path.join(repo, ".gitignore"), "build/\n");
    await git(repo, "commit", "-q", "-am", "ignore build");
    await fs.mkdir(path.join(repo, "build"));
    await fs.writeFile(path.join(repo, "build", "keep.bin"), "user\n");
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "build"), "seat\n");
    await git(w.path, "add", "-f", "build");
    await git(w.path, "commit", "-q", "-m", "x");
    for (const strategy of ["merge", "squash", "patch"] as const) {
      await expect(wm.applyTo("main", seat, { strategy })).rejects.toThrow(/overwrite untracked or ignored files.*build/);
    }
    expect(await fs.readFile(path.join(repo, "build", "keep.bin"), "utf8")).toBe("user\n");
  });

  it("Q1: refuses a seat directory that would replace an ignored file", async () => {
    const repo = await makeRepo();
    await fs.appendFile(path.join(repo, ".gitignore"), "cfg\n");
    await git(repo, "commit", "-q", "-am", "ignore cfg");
    await fs.writeFile(path.join(repo, "cfg"), "user secret\n");
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.mkdir(path.join(w.path, "cfg"));
    await fs.writeFile(path.join(w.path, "cfg", "x"), "seat\n");
    await git(w.path, "add", "-f", "cfg");
    await git(w.path, "commit", "-q", "-m", "x");
    for (const strategy of ["merge", "squash", "patch"] as const) {
      await expect(wm.applyTo("main", seat, { strategy })).rejects.toThrow(/overwrite untracked or ignored files.*cfg\/x/);
    }
    expect(await fs.readFile(path.join(repo, "cfg"), "utf8")).toBe("user secret\n");
  });

  it("Q3: refuses a seat path that runs through an ignored symlink", async () => {
    if (process.platform === "win32") return;
    const repo = await makeRepo();
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-out-")));
    dirs.push(outside);
    await fs.appendFile(path.join(repo, ".gitignore"), "link\n");
    await git(repo, "commit", "-q", "-am", "ignore link");
    await fs.symlink(outside, path.join(repo, "link"));
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.mkdir(path.join(w.path, "link"));
    await fs.writeFile(path.join(w.path, "link", "x"), "x\n");
    await git(w.path, "add", "-f", "link");
    await git(w.path, "commit", "-q", "-m", "x");
    await expect(wm.applyTo("main", seat, { strategy: "merge" })).rejects.toThrow(/link\/x/);
    expect((await fs.lstat(path.join(repo, "link"))).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("a hook killed after the commit landed still counts as applied, with a warning", async () => {
    if (process.platform === "win32") return;
    const repo = await makeRepo();
    const wm = new WorktreeManager({ repoPath: repo });
    const w = await wm.create(seat);
    await fs.writeFile(path.join(w.path, "b.txt"), "1\n");
    // Commit the seat work first: hooks are shared by all worktrees of the repo.
    await git(w.path, "add", ".");
    await git(w.path, "commit", "-q", "-m", "seat work");
    const hook = path.join(repo, ".git", "hooks", "post-commit");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    // Kills the `git commit` that ran it, after the commit was written.
    await fs.writeFile(hook, "#!/bin/sh\nkill -9 $PPID\n", { mode: 0o755 });
    const head = await git(repo, "rev-parse", "HEAD");

    const res = await wm.applyTo("main", seat, { strategy: "squash" });
    expect(res).toMatchObject({ ok: true, changed: true });
    if (res.ok) {
      expect(res.warning).toMatch(/hook after the commit failed/);
      expect(res.commit).toBe(await git(repo, "rev-parse", "HEAD"));
    }
    expect(await git(repo, "rev-parse", "HEAD")).not.toBe(head);
    expect(await fs.readFile(path.join(repo, "b.txt"), "utf8")).toBe("1\n");
    expect((await wm.list())[0]?.outcome).toBe("applied");
  });
});
