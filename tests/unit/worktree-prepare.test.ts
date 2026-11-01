import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAssentorConfig } from "../../packages/engine/src/config/schema.js";
import { prepareWorktree, worktreeInstallCommand } from "../../packages/engine/src/worktrees/index.js";

const exec = promisify(execFile);
// Real git and process spawns; slow on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
let bin = "";
let log = "";

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A committed git checkout holding `files`, like a fresh seat worktree. */
async function checkout(files: Record<string, string>): Promise<string> {
  const dir = await tempDir("assentor-prep-");
  const git = (...args: string[]) => exec("git", args, { cwd: dir });
  await git("-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git("config", "user.email", "assentor@test");
  await git("config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  return dir;
}

/** A fake package manager on PATH: logs `<name> <args>`, then runs `body`. */
async function fakeTool(name: string, body = "mkdir -p node_modules"): Promise<void> {
  const script = `#!/bin/sh\necho "${name} $* CI=$CI pid=$$" >> "$FAKE_PM_LOG"\n${body}\n`;
  await fs.writeFile(path.join(bin, name), script, { mode: 0o755 });
}

const logged = async () => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

describe.skipIf(process.platform === "win32")("prepareWorktree (fake package managers on PATH)", () => {
  beforeEach(async () => {
    bin = await tempDir("assentor-bin-");
    log = path.join(bin, "calls.log");
    for (const pm of ["pnpm", "npm", "yarn", "bun"]) await fakeTool(pm);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("FAKE_PM_LOG", log);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --prefer-offline"],
    ["package-lock.json", "npm ci --prefer-offline"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
  ])("auto: %s runs `%s` in the worktree, non-interactive", async (lockfile, command) => {
    const wt = await checkout({ [lockfile]: "lock\n" });
    expect(await prepareWorktree(wt, "auto")).toEqual({ ok: true, command });
    const calls = await logged();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`${command} CI=1`);
    expect((await fs.stat(path.join(wt, "node_modules"))).isDirectory()).toBe(true);
  });

  it("runs nothing without a JS lockfile, or when off", async () => {
    const plain = await checkout({ "requirements.txt": "pytest\n", "package.json": "{}\n" });
    expect(await prepareWorktree(plain, "auto")).toEqual({ ok: true });
    expect(await prepareWorktree(plain, undefined)).toEqual({ ok: true });
    const locked = await checkout({ "pnpm-lock.yaml": "lock\n" });
    expect(await prepareWorktree(locked, "off")).toEqual({ ok: true });
    expect(await logged()).toEqual([]);
  });

  it("a configured command overrides detection", async () => {
    await fakeTool("uv");
    const wt = await checkout({ "pnpm-lock.yaml": "lock\n", "uv.lock": "lock\n" });
    expect(await prepareWorktree(wt, "uv sync --frozen")).toEqual({ ok: true, command: "uv sync --frozen" });
    expect(await logged()).toEqual([expect.stringContaining("uv sync --frozen CI=1")]);
    expect(await worktreeInstallCommand(wt, "auto")).toBe("pnpm install --frozen-lockfile --prefer-offline");
  });

  it("a failing install is a blocked reason with the output tail, not a throw", async () => {
    await fakeTool("pnpm", 'echo "ERR_PNPM_OUTDATED_LOCKFILE boom" >&2; exit 3');
    const wt = await checkout({ "pnpm-lock.yaml": "lock\n" });
    const result = await prepareWorktree(wt, "auto");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("`pnpm install --frozen-lockfile --prefer-offline` exited 3");
    expect(result.reason).toContain("ERR_PNPM_OUTDATED_LOCKFILE boom");
    expect(result.reason).toContain(`worktree kept at ${wt}`);
    expect(await fs.readFile(path.join(wt, "pnpm-lock.yaml"), "utf8")).toBe("lock\n");
  });

  it("an install that leaves unignored files behind is refused", async () => {
    await fakeTool("npm", "echo x > stray.txt");
    const wt = await checkout({ "package-lock.json": "{}\n" });
    const result = await prepareWorktree(wt, "auto");
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("changed files git tracks or does not ignore (stray.txt)") });
  });

  it("an install that rewrites an already-modified file is refused", async () => {
    await fakeTool("npm", "echo again >> notes.txt");
    const wt = await checkout({ "package-lock.json": "{}\n", "notes.txt": "one\n" });
    await fs.writeFile(path.join(wt, "notes.txt"), "work in progress\n");
    expect(await prepareWorktree(wt, "auto")).toMatchObject({ ok: false, reason: expect.stringContaining("(notes.txt)") });
  });

  it("an install that adds a file inside an untracked directory is refused", async () => {
    await fakeTool("npm", "echo y > scratch/new.txt");
    const wt = await checkout({ "package-lock.json": "{}\n" });
    await fs.mkdir(path.join(wt, "scratch"));
    await fs.writeFile(path.join(wt, "scratch", "old.txt"), "mine\n");
    expect(await prepareWorktree(wt, "auto")).toMatchObject({ ok: false, reason: expect.stringContaining("(scratch/new.txt)") });
  });

  it("existing work (including a staged rename) is not blamed on a clean install", async () => {
    const wt = await checkout({ "package-lock.json": "{}\n", "old name.txt": "x\n" });
    await exec("git", ["mv", "old name.txt", "new name.txt"], { cwd: wt });
    await fs.writeFile(path.join(wt, "draft.txt"), "draft\n");
    expect(await prepareWorktree(wt, "auto")).toEqual({ ok: true, command: "npm ci --prefer-offline" });
  });

  it("times out", async () => {
    await fakeTool("yarn", "sleep 20");
    const wt = await checkout({ "yarn.lock": "\n" });
    const result = await prepareWorktree(wt, "auto", { timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("timed out after 1 s") });
  });

  it("abort kills the install and reports cancelled", async () => {
    await fakeTool("pnpm", "sleep 20");
    const wt = await checkout({ "pnpm-lock.yaml": "lock\n" });
    const controller = new AbortController();
    const started = Date.now();
    const pending = prepareWorktree(wt, "auto", { signal: controller.signal });
    let pid = 0;
    for (let i = 0; i < 400 && !pid; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      pid = Number(/pid=(\d+)/.exec((await logged())[0] ?? "")?.[1] ?? 0);
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "cancelled" });
    expect(Date.now() - started).toBeLessThan(15_000);
    let alive = true;
    for (let i = 0; i < 40 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

describe("worktrees.install config", () => {
  it("defaults to auto and accepts off or a command", () => {
    expect(parseAssentorConfig({}).worktrees.install).toBe("auto");
    expect(parseAssentorConfig({ worktrees: { install: " off " } }).worktrees.install).toBe("off");
    expect(parseAssentorConfig({ worktrees: { install: "uv sync --frozen" } }).worktrees.install).toBe("uv sync --frozen");
  });
  it("rejects empty, multi-line or non-string values", () => {
    for (const install of ["", "   ", "npm ci\nrm -rf /", 42]) {
      expect(() => parseAssentorConfig({ worktrees: { install } })).toThrow();
    }
  });
});
