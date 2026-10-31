import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CliModelCatalog,
  parseDiscoveryOutput,
  type CliRunResult,
} from "../../packages/engine/src/models/cli-catalog.js";

// Lets a test make the real spawn throw synchronously, as Node does for a NUL byte in an argument.
const spawnControl = vi.hoisted(() => ({ throwMessage: undefined as string | undefined }));

vi.mock("../../packages/engine/src/executors/cli-locator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/engine/src/executors/cli-locator.js")>();
  return {
    ...actual,
    spawnCliProcess: (...args: Parameters<typeof actual.spawnCliProcess>) => {
      if (spawnControl.throwMessage !== undefined) {
        throw new Error(spawnControl.throwMessage);
      }
      return actual.spawnCliProcess(...args);
    },
  };
});

// Copied from `agy models` on the dev machine. Tab characters checked with `od -c`.
const AGY_OUTPUT = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

// Excerpt of `agent --list-models` on the dev machine, lines copied verbatim.
const AGENT_OUTPUT = [
  "Available models",
  "",
  "auto - Auto (current, default)",
  "gpt-5.3-codex-low - Codex 5.3 Low",
  "gpt-5.3-codex - Codex 5.3",
  "claude-opus-5-high - Claude Opus 5 1M",
  "claude-opus-5-high-fast - Claude Opus 5 1M Fast",
  "",
].join("\n");

function ok(stdout: string): CliRunResult {
  return { stdout, stderr: "", code: 0, timedOut: false };
}

describe("parseDiscoveryOutput", () => {
  it("parses agy's tab-separated format and skips the header", () => {
    const models = parseDiscoveryOutput(AGY_OUTPUT);
    expect(models).toHaveLength(6);
    expect(models[0]).toEqual({ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" });
    expect(models.map((m) => m.id)).not.toContain("Fetching");
  });

  it("parses agent's ' - ' format, drops the auto line, and never surfaces its label", () => {
    const models = parseDiscoveryOutput(AGENT_OUTPUT);
    expect(models.map((m) => m.id)).toEqual([
      "gpt-5.3-codex-low",
      "gpt-5.3-codex",
      "claude-opus-5-high",
      "claude-opus-5-high-fast",
    ]);
    expect(models.find((m) => m.id === "gpt-5.3-codex")).toEqual({
      id: "gpt-5.3-codex",
      label: "Codex 5.3",
    });
    expect(JSON.stringify(models)).not.toContain("Auto (current, default)");
  });

  it("skips header lines that have no separator", () => {
    expect(parseDiscoveryOutput("Available models\n\nFetching available models...\n")).toEqual([]);
  });

  it("uses TAB over ' - ' when a line has both", () => {
    expect(parseDiscoveryOutput("id\tLabel - x\n")).toEqual([{ id: "id", label: "Label - x" }]);
  });

  it("skips a trailing-tab line in separator mode", () => {
    expect(parseDiscoveryOutput("a\tA\nid\t\n")).toEqual([{ id: "a", label: "A" }]);
  });

  it("falls back to bare ids only when no line has a separator", () => {
    const models = parseDiscoveryOutput("gpt-a\ngpt-b\nnot a bare id\n");
    expect(models).toEqual([
      { id: "gpt-a", label: "gpt-a" },
      { id: "gpt-b", label: "gpt-b" },
    ]);

    const mixed = parseDiscoveryOutput("gpt-a\nreal-id\tReal\n");
    expect(mixed).toEqual([{ id: "real-id", label: "Real" }]);
  });

  it("rejects ids that do not match the pattern", () => {
    const models = parseDiscoveryOutput(
      ["-leading-dash\tx", "has space\ty", "bad$char\tz", "ok-id\tfine"].join("\n"),
    );
    expect(models).toEqual([{ id: "ok-id", label: "fine" }]);
  });

  it("removes duplicate ids, keeping the first occurrence", () => {
    const models = parseDiscoveryOutput("dup\tFirst\nother\tO\ndup\tSecond\n");
    expect(models).toEqual([
      { id: "dup", label: "First" },
      { id: "other", label: "O" },
    ]);
  });
});

describe("CliModelCatalog", () => {
  let dir: string;
  const savedUserDir = process.env.ASSENTOR_USER_DIR;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-catalog-"));
  });

  afterEach(async () => {
    if (savedUserDir === undefined) delete process.env.ASSENTOR_USER_DIR;
    else process.env.ASSENTOR_USER_DIR = savedUserDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const cachePath = () => path.join(dir, "models-cache.json");

  it("lists AUTO, then the claude-code seed aliases", () => {
    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    const entries = catalog.list("claude-code");
    expect(entries.map((e) => e.id)).toEqual(["AUTO", "opus", "sonnet", "haiku"]);
    expect(entries[0]).toEqual({
      provider: "claude-code",
      id: "AUTO",
      label: "Auto (CLI default)",
      source: "seed",
    });
  });

  it("a CLI with no seed lists only AUTO until discovery or a user adds models", () => {
    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    expect(catalog.list("antigravity").map((e) => e.id)).toEqual(["AUTO"]);
  });

  it("discover runs agy with fixed args and the binary path passed directly, then caches", async () => {
    const run = vi.fn(async (): Promise<CliRunResult> => ok(AGY_OUTPUT));
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/opt/my tools/agy",
    });

    const result = await catalog.discover("antigravity");

    expect(run).toHaveBeenCalledWith("/opt/my tools/agy", ["models"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.entries).toHaveLength(6);
    expect(result.entries.every((e) => e.source === "discovered")).toBe(true);

    const reopened = new CliModelCatalog({ cachePath: cachePath(), run, locate: () => undefined });
    expect(reopened.list("antigravity").map((e) => e.id)).toContain("gemini-3.8-flash-high");
  });

  it("cursor uses --list-models for the agent binary", async () => {
    const run = vi.fn(async (): Promise<CliRunResult> => ok(AGENT_OUTPUT));
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/fake/bin/agent",
    });

    await catalog.discover("cursor");

    expect(run).toHaveBeenCalledWith("/fake/bin/agent", ["--list-models"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
  });

  it("cursor uses agent --list-models for the Cursor app binary", async () => {
    const run = vi.fn(async (): Promise<CliRunResult> => ok(AGENT_OUTPUT));
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    });

    await catalog.discover("cursor");

    expect(run).toHaveBeenCalledWith(
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      ["agent", "--list-models"],
      { cwd: process.cwd(), timeoutMs: 15_000 },
    );
  });

  it.each([
    ['/x/a"b;touch pwn/agy'],
    ["/x/$(id)/agy"],
    ["/x/`id`/agy"],
    ["/x/%PATH%/agy"],
    ["/x/a|b/agy"],
  ])("refuses an unsafe binary path without running it: %s", async (binary) => {
    const run = vi.fn(async (): Promise<CliRunResult> => ok(AGY_OUTPUT));
    const catalog = new CliModelCatalog({ cachePath: cachePath(), run, locate: () => binary });

    const result = await catalog.discover("antigravity");

    expect(result.error).toBe("binary path contains unsafe characters");
    expect(run).not.toHaveBeenCalled();
  });

  it("a path with spaces is allowed", async () => {
    const run = vi.fn(async (): Promise<CliRunResult> => ok(AGY_OUTPUT));
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/Users/Some User/bin/agy",
    });

    const result = await catalog.discover("antigravity");

    expect(result.error).toBeUndefined();
    expect(run).toHaveBeenCalledWith("/Users/Some User/bin/agy", ["models"], expect.any(Object));
  });

  it("a failed discovery returns an error and keeps the previous cache", async () => {
    let next: CliRunResult = ok(AGY_OUTPUT);
    const run = vi.fn(async () => next);
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/fake/bin/agy",
    });
    await catalog.discover("antigravity");
    const before = await fs.readFile(cachePath(), "utf8");

    next = { stdout: "", stderr: "not logged in", code: 1, timedOut: false };
    const failed = await catalog.discover("antigravity");

    expect(failed.error).toContain("not logged in");
    expect(failed.entries).toEqual([]);
    expect(await fs.readFile(cachePath(), "utf8")).toEqual(before);
    expect(catalog.list("antigravity").map((e) => e.id)).toContain("gemini-3.8-flash-high");
  });

  it("a timeout returns an error and keeps the previous cache", async () => {
    let next: CliRunResult = ok(AGY_OUTPUT);
    const run = vi.fn(async () => next);
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/fake/bin/agy",
    });
    await catalog.discover("antigravity");
    const before = await fs.readFile(cachePath(), "utf8");

    next = { stdout: "", stderr: "", code: null, timedOut: true };
    const result = await catalog.discover("antigravity");

    expect(result.error).toContain("timed out");
    expect(await fs.readFile(cachePath(), "utf8")).toEqual(before);
    expect(catalog.list("antigravity").map((e) => e.id)).toContain("gemini-3.8-flash-high");
  });

  it("does not run a command when the binary is missing or the provider has no discovery", async () => {
    const run = vi.fn(async (): Promise<CliRunResult> => ok(""));
    const catalog = new CliModelCatalog({ cachePath: cachePath(), run, locate: () => undefined });

    expect((await catalog.discover("antigravity")).error).toContain("not found");
    expect((await catalog.discover("claude-code")).error).toContain("no model discovery");
    expect(run).not.toHaveBeenCalled();
  });

  it("user models persist across instances and can be removed", async () => {
    const first = new CliModelCatalog({ cachePath: cachePath() });
    await first.addUserModel("claude-code", "my-model", "Mine");

    const second = new CliModelCatalog({ cachePath: cachePath() });
    expect(second.list("claude-code")).toContainEqual({
      provider: "claude-code",
      id: "my-model",
      label: "Mine",
      source: "user",
    });

    await second.removeUserModel("claude-code", "my-model");
    const third = new CliModelCatalog({ cachePath: cachePath() });
    expect(third.list("claude-code").map((e) => e.id)).not.toContain("my-model");
  });

  it("user models survive a successful discover", async () => {
    const run = vi.fn(async (): Promise<CliRunResult> => ok(AGY_OUTPUT));
    const catalog = new CliModelCatalog({ cachePath: cachePath(), run, locate: () => "/fake/bin/agy" });
    await catalog.addUserModel("antigravity", "my-agy-model", "Mine");

    await catalog.discover("antigravity");

    const reopened = new CliModelCatalog({ cachePath: cachePath() });
    const ids = reopened.list("antigravity").map((e) => e.id);
    expect(ids).toContain("my-agy-model");
    expect(ids).toContain("gemini-3.8-flash-high");
  });

  it("a user model overrides the seed label for the same id", async () => {
    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    await catalog.addUserModel("claude-code", "opus", "Opus (mine)");

    const opus = catalog.list("claude-code").filter((e) => e.id === "opus");
    expect(opus).toEqual([
      { provider: "claude-code", id: "opus", label: "Opus (mine)", source: "user" },
    ]);
  });

  it("rejects AUTO and invalid ids as user models", async () => {
    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    await expect(catalog.addUserModel("claude-code", "auto")).rejects.toThrow("reserved");
    await expect(catalog.addUserModel("claude-code", "bad id")).rejects.toThrow("Invalid model id");
  });

  it("corrupt JSON is backed up, the catalog still works, and the next write succeeds", async () => {
    await fs.writeFile(cachePath(), "{not json", "utf8");

    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    expect(catalog.list("claude-code").map((e) => e.id)).toEqual(["AUTO", "opus", "sonnet", "haiku"]);

    const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("models-cache.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, backups[0]!), "utf8")).toBe("{not json");

    await catalog.addUserModel("claude-code", "after-corrupt");
    expect(new CliModelCatalog({ cachePath: cachePath() }).list("claude-code").map((e) => e.id)).toContain(
      "after-corrupt",
    );
  });

  it("a wrong top-level shape is backed up and treated as empty", async () => {
    await fs.writeFile(cachePath(), JSON.stringify({ discovered: [], user: {} }), "utf8");

    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    expect(catalog.list("claude-code").map((e) => e.id)).toEqual(["AUTO", "opus", "sonnet", "haiku"]);
    const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("models-cache.json.corrupt-"));
    expect(backups).toHaveLength(1);
  });

  it("drops invalid entries instead of throwing later", async () => {
    await fs.writeFile(
      cachePath(),
      JSON.stringify({
        discovered: {},
        user: {
          "claude-code": [
            { id: "ok", label: "Ok" },
            { id: 5, label: "number id" },
            "not an object",
            { id: "bad id", label: "space" },
            { id: "auto", label: "reserved" },
          ],
          "not-a-provider": [{ id: "x", label: "x" }],
        },
      }),
      "utf8",
    );

    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    expect(catalog.list("claude-code").map((e) => e.id)).toEqual(["AUTO", "opus", "sonnet", "haiku", "ok"]);
    expect(catalog.list("claude-code").some((e) => e.id === "bad id")).toBe(false);
  });

  it("a missing cache file is empty and creates no backup", async () => {
    new CliModelCatalog({ cachePath: cachePath() });
    expect((await fs.readdir(dir)).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("refuses to overwrite a corrupt cache that could not be backed up", async () => {
    // A directory at the cache path cannot be read as a file or copied, so no backup exists.
    await fs.mkdir(cachePath());

    const catalog = new CliModelCatalog({ cachePath: cachePath() });
    await expect(catalog.addUserModel("claude-code", "x")).rejects.toThrow("refusing to overwrite");
    expect((await fs.stat(cachePath())).isDirectory()).toBe(true);
  });

  it("a spawn that throws synchronously becomes an error, not a rejection", async () => {
    spawnControl.throwMessage = "The argument 'args[0]' must be a string without null bytes";
    try {
      const catalog = new CliModelCatalog({ cachePath: cachePath(), locate: () => "/fake/bin/agy" });

      const result = await catalog.discover("antigravity");

      expect(result.error).toContain("without null bytes");
      expect(result.entries).toEqual([]);
    } finally {
      spawnControl.throwMessage = undefined;
    }
  });

  it("a failed save rolls back add and remove, so a throw means nothing changed", async () => {
    // A regular file where the cache directory should be makes every save fail.
    const blocker = path.join(dir, "blocker");
    await fs.writeFile(blocker, "x", "utf8");
    const catalog = new CliModelCatalog({ cachePath: path.join(blocker, "models-cache.json") });

    await expect(catalog.addUserModel("claude-code", "rolled-back")).rejects.toThrow();
    expect(catalog.list("claude-code").map((e) => e.id)).not.toContain("rolled-back");

    await expect(catalog.removeUserModel("claude-code", "opus")).rejects.toThrow();
    expect(catalog.list("claude-code").map((e) => e.id)).toEqual(["AUTO", "opus", "sonnet", "haiku"]);
  });

  it("a discover save failure keeps the models in memory and returns them with an error", async () => {
    const blocker = path.join(dir, "blocker");
    await fs.writeFile(blocker, "x", "utf8");
    const run = vi.fn(async (): Promise<CliRunResult> => ok(AGY_OUTPUT));
    const catalog = new CliModelCatalog({
      cachePath: path.join(blocker, "models-cache.json"),
      run,
      locate: () => "/fake/bin/agy",
    });

    const result = await catalog.discover("antigravity");

    expect(result.error).toContain("could not be saved");
    expect(result.entries).toHaveLength(6);
    expect(catalog.list("antigravity").map((e) => e.id)).toContain("gemini-3.8-flash-high");
  });

  it("uses ASSENTOR_USER_DIR for the default cache path", async () => {
    process.env.ASSENTOR_USER_DIR = dir;
    const catalog = new CliModelCatalog();
    await catalog.addUserModel("claude-code", "default-path-model");

    const written = await fs.readFile(path.join(dir, "models-cache.json"), "utf8");
    expect(written).toContain("default-path-model");
  });
});
