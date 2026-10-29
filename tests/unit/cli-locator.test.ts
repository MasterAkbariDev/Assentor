import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  findOnPath,
  locateBinary,
  rememberBinary,
  wellKnownBinaryPaths,
} from "../../src/executors/cli-locator.js";
import { isCursorAppBinary } from "../../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.ASSENTOR_BINARY_CACHE_PATH;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-bin-"));
  tempDirs.push(dir);
  return dir;
}

describe("CLI locator", () => {
  it("lists Windows cursor-agent as a default location", () => {
    const paths = wellKnownBinaryPaths("cursor", {
      platform: "win32",
      homedir: "C:\\Users\\sam",
      env: {
        USERPROFILE: "C:\\Users\\sam",
        LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
        APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
      },
    });
    expect(
      paths.some((p) => p.replace(/\\/g, "/").endsWith("AppData/Local/cursor-agent/agent.cmd")),
    ).toBe(true);
  });

  it("finds agent.cmd on PATH via PATHEXT", async () => {
    const dir = await tempDir();
    const cmd = path.join(dir, "agent.cmd");
    await fs.writeFile(cmd, "@echo off\r\n");
    const found = findOnPath("agent", {
      platform: "win32",
      homedir: dir,
      env: {
        PATH: dir,
        PATHEXT: ".cmd;.exe",
      },
    });
    expect(found).toBe(cmd);
  });

  it("locates cursor from a well-known Windows folder when not on PATH", async () => {
    const home = await tempDir();
    const localAppData = path.join(home, "AppData", "Local");
    const agentDir = path.join(localAppData, "cursor-agent");
    await fs.mkdir(agentDir, { recursive: true });
    const cmd = path.join(agentDir, "agent.cmd");
    await fs.writeFile(cmd, "@echo off\r\n");

    const found = locateBinary("cursor", {
      persist: false,
      host: {
        platform: "win32",
        homedir: home,
        env: {
          USERPROFILE: home,
          LOCALAPPDATA: localAppData,
          APPDATA: path.join(home, "AppData", "Roaming"),
          PATH: path.join(home, "empty-path"),
        },
      },
    });
    expect(found).toBe(cmd);
  });

  it("stores a discovered binary path in config", async () => {
    const home = await tempDir();
    const cache = path.join(home, "config.yaml");
    process.env.ASSENTOR_BINARY_CACHE_PATH = cache;
    const cmd = path.join(home, "claude.cmd");
    await fs.writeFile(cmd, "@echo off\r\n");
    rememberBinary("claude", cmd);
    const found = locateBinary("claude", {
      persist: false,
      host: {
        platform: "win32",
        homedir: home,
        env: { PATH: path.join(home, "none") },
      },
    });
    expect(found).toBe(cmd);
  });

  describe("rememberBinary and the user config file", () => {
    async function cachePath(): Promise<string> {
      const cache = path.join(await tempDir(), "config.yaml");
      process.env.ASSENTOR_BINARY_CACHE_PATH = cache;
      return cache;
    }

    it("leaves a corrupt YAML file byte-for-byte unchanged", async () => {
      const cache = await cachePath();
      const corrupt = "run:\n  mode: [unclosed\n\tbad: : yaml\n";
      await fs.writeFile(cache, corrupt);
      expect(() => rememberBinary("claude", "/bin/claude")).not.toThrow();
      expect(await fs.readFile(cache, "utf8")).toBe(corrupt);
      expect(await fs.readdir(path.dirname(cache))).toEqual(["config.yaml"]);
    });

    it("leaves a file that is not a mapping unchanged", async () => {
      const cache = await cachePath();
      await fs.writeFile(cache, "- a\n- b\n");
      rememberBinary("claude", "/bin/claude");
      expect(await fs.readFile(cache, "utf8")).toBe("- a\n- b\n");
    });

    it("creates a missing file with just binaries", async () => {
      const cache = await cachePath();
      rememberBinary("claude", "/bin/claude");
      expect(parseYaml(await fs.readFile(cache, "utf8"))).toEqual({
        binaries: { claude: "/bin/claude" },
      });
      expect(await fs.readdir(path.dirname(cache))).toEqual(["config.yaml"]);
    });

    it("keeps every other key of a valid file", async () => {
      const cache = await cachePath();
      await fs.writeFile(
        cache,
        "run:\n  mode: supervised\nbinaries:\n  codex: /bin/codex\n",
      );
      rememberBinary("claude", "/bin/claude");
      expect(parseYaml(await fs.readFile(cache, "utf8"))).toEqual({
        run: { mode: "supervised" },
        binaries: { codex: "/bin/codex", claude: "/bin/claude" },
      });
    });

    it.skipIf(process.platform === "win32")("writes through a symlinked config and keeps the link", async () => {
      const cache = await cachePath();
      const real = path.join(await tempDir(), "dotfiles-config.yaml");
      await fs.writeFile(real, "run:\n  mode: supervised\n");
      await fs.symlink(real, cache);
      rememberBinary("claude", "/bin/claude");
      expect((await fs.lstat(cache)).isSymbolicLink()).toBe(true);
      expect(parseYaml(await fs.readFile(real, "utf8"))).toEqual({
        run: { mode: "supervised" },
        binaries: { claude: "/bin/claude" },
      });
    });
  });

  it("treats cursor.cmd as the Cursor.app-style binary", () => {
    expect(isCursorAppBinary("cursor.cmd")).toBe(true);
    expect(isCursorAppBinary("cursor.exe")).toBe(true);
    expect(isCursorAppBinary("agent.cmd")).toBe(false);
  });

  it("lists ~/.local/bin/agy as a default Antigravity location", () => {
    const paths = wellKnownBinaryPaths("agy", {
      platform: "linux",
      homedir: "/home/sam",
      env: { HOME: "/home/sam" },
    });
    expect(paths.some((p) => p.replace(/\\/g, "/").endsWith("/.local/bin/agy"))).toBe(true);
  });
});
