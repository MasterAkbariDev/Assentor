import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CliModelCatalog,
  parseDiscoveryOutput,
} from "../../src/models/cli-catalog.js";

// Real output of `agy models` on the dev machine, verbatim (tab-separated).
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

// Excerpt of `agent --list-models`, lines verbatim (" - " separated).
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

type Result = { stdout: string; stderr: string; code: number };

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

  it("discover runs the agy command with the located path in quotes, caches, and lists the models", async () => {
    const run = vi.fn(async (): Promise<Result> => ({ stdout: AGY_OUTPUT, stderr: "", code: 0 }));
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/opt/my tools/agy",
    });

    const result = await catalog.discover("antigravity");

    expect(run).toHaveBeenCalledWith(`"/opt/my tools/agy" models`, process.cwd(), {
      timeoutMs: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.entries).toHaveLength(6);
    expect(result.entries.every((e) => e.source === "discovered")).toBe(true);

    const reopened = new CliModelCatalog({ cachePath: cachePath(), run, locate: () => undefined });
    expect(reopened.list("antigravity").map((e) => e.id)).toContain("gemini-3.8-flash-high");
  });

  it("cursor uses agent --list-models for the agent binary", async () => {
    const run = vi.fn(async (): Promise<Result> => ({ stdout: AGENT_OUTPUT, stderr: "", code: 0 }));
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/fake/bin/agent",
    });

    await catalog.discover("cursor");

    expect(run).toHaveBeenCalledWith(`"/fake/bin/agent" --list-models`, process.cwd(), {
      timeoutMs: 15_000,
    });
  });

  it("a failed discovery returns an error and keeps the previous cache", async () => {
    let next: Result = { stdout: AGY_OUTPUT, stderr: "", code: 0 };
    const run = vi.fn(async () => next);
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/fake/bin/agy",
    });
    await catalog.discover("antigravity");
    const before = await fs.readFile(cachePath(), "utf8");

    next = { stdout: "", stderr: "not logged in", code: 1 };
    const failed = await catalog.discover("antigravity");

    expect(failed.error).toContain("not logged in");
    expect(failed.entries).toEqual([]);
    expect(await fs.readFile(cachePath(), "utf8")).toEqual(before);
    expect(catalog.list("antigravity").map((e) => e.id)).toContain("gemini-3.8-flash-high");
  });

  it("a timeout returns an error and keeps the previous cache", async () => {
    const run = vi.fn(async (): Promise<Result> => ({ stdout: "", stderr: "(timed out)", code: 124 }));
    const catalog = new CliModelCatalog({
      cachePath: cachePath(),
      run,
      locate: () => "/fake/bin/agy",
    });

    const result = await catalog.discover("antigravity");

    expect(result.error).toContain("timed out");
    await expect(fs.access(cachePath())).rejects.toThrow();
  });

  it("does not run a command when the binary is missing or the provider has no discovery", async () => {
    const run = vi.fn(async (): Promise<Result> => ({ stdout: "", stderr: "", code: 0 }));
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

  it("uses ASSENTOR_USER_DIR for the default cache path", async () => {
    process.env.ASSENTOR_USER_DIR = dir;
    const catalog = new CliModelCatalog();
    await catalog.addUserModel("claude-code", "default-path-model");

    const written = await fs.readFile(path.join(dir, "models-cache.json"), "utf8");
    expect(written).toContain("default-path-model");
  });
});
