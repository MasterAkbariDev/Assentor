import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

/**
 * Fake package managers on PATH for dependency-install tests (no network).
 * Each tool appends `<name> <args>` to a log, then runs its body (default: makes
 * node_modules). Call `restore()` in afterEach.
 */
export async function fakePackageManagers(bodies: Record<string, string> = {}) {
  const bin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-fakepm-")));
  const log = path.join(bin, "calls.log");
  for (const name of ["pnpm", "npm", "yarn", "bun"]) {
    const body = bodies[name] ?? "mkdir -p node_modules";
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$FAKE_PM_LOG"\n${body}\n`, { mode: 0o755 });
  }
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_PM_LOG", log);
  return {
    log,
    logged: async () => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
    restore: async () => {
      vi.unstubAllEnvs();
      await fs.rm(bin, { recursive: true, force: true });
    },
  };
}

/** Commits `yarn.lock` and a `node_modules/` ignore rule, so `auto` runs `yarn install`. */
export async function addYarnLock(repo: string, git: (cwd: string, ...args: string[]) => Promise<unknown>): Promise<void> {
  await fs.appendFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await fs.writeFile(path.join(repo, "yarn.lock"), "# lock\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "lockfile");
}
