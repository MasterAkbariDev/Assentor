import { describe, expect, it, afterEach } from "vitest";
import { parseAssentorConfig } from "../../src/index.js";
import { doctorAssentor, initAssentorProject } from "../../src/cli/commands.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const TEMP_ROOT = path.join(process.cwd(), ".tmp", "cli-tests");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("config + cli helpers", () => {
  it("parses default assentor config", () => {
    const config = parseAssentorConfig({});
    expect(config.executor.provider).toBe("mock");
    expect(config.reviewers[0]?.provider).toBe("mock");
    expect(config.limits.maxRounds).toBe(8);
    expect(config.routing.strategy).toBe("BALANCED");
    expect(config.models.default).toBe("AUTO");
    expect(config.run.mode).toBe("supervised");
  });

  it("normalizes executor aliases including Antigravity", () => {
    expect(parseAssentorConfig({ executor: { provider: "agy" } }).executor.provider).toBe(
      "antigravity",
    );
    expect(
      parseAssentorConfig({ executor: { provider: "claude" } }).executor.provider,
    ).toBe("claude-code");
    expect(
      parseAssentorConfig({ executor: { provider: "gemini" } }).executor.provider,
    ).toBe("antigravity");
    expect(
      parseAssentorConfig({ executor: { provider: "gemini-cli" } }).executor
        .provider,
    ).toBe("antigravity");
    expect(
      parseAssentorConfig({
        reviewers: [{ provider: "gemini-cli", transport: "cli" }],
      }).reviewers[0]?.provider,
    ).toBe("antigravity");
    expect(
      parseAssentorConfig({
        executor: { provider: "antigravity" },
        run: { mode: "autopilot" },
      }).run.mode,
    ).toBe("autopilot");
  });

  it("initializes optional project .assentor/config.yaml override", async () => {
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
    tempDirs.push(dir);

    const configPath = await initAssentorProject(dir);
    expect(configPath).toContain(path.join(dir, ".assentor"));
    const raw = await fs.readFile(configPath, "utf8");
    expect(raw).toContain("executor:");
    expect(raw).toContain("provider: mock");
    expect(raw).toContain("routing:");
    expect(raw).toContain("models:");
    expect(raw).toContain("verification:");
  });

  it("saves and reloads project overrides", async () => {
    const { loadAssentorConfig, saveAssentorConfig, parseAssentorConfig } =
      await import("../../src/config/load.js");
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
    tempDirs.push(dir);

    const config = parseAssentorConfig({
      executor: { provider: "cursor" },
      reviewers: [{ provider: "gemini", role: "general" }],
      models: { default: "AUTO", gemini: "gemini-2.5-flash", openai: "AUTO" },
    });
    await saveAssentorConfig(dir, config, { scope: "project" });
    const loaded = await loadAssentorConfig(dir);
    expect(loaded.executor.provider).toBe("cursor");
    expect(loaded.reviewers[0]?.provider).toBe("gemini");
    expect(loaded.models.gemini).toBe("gemini-2.5-flash");
  });

  it("merges user defaults under project overrides", async () => {
    const {
      loadAssentorConfig,
      saveAssentorConfig,
      parseAssentorConfig,
      mergeConfigLayers,
    } = await import("../../src/config/load.js");

    const merged = mergeConfigLayers(
      { executor: { provider: "cursor" }, models: { gemini: "AUTO" } },
      { models: { gemini: "gemini-2.5-flash" } },
    );
    expect(merged).toEqual({
      executor: { provider: "cursor" },
      models: { gemini: "gemini-2.5-flash" },
    });

    // Project-only override without touching real ~/.assentor
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
    tempDirs.push(dir);
    await saveAssentorConfig(
      dir,
      parseAssentorConfig({
        executor: { provider: "mock" },
        reviewers: [{ provider: "openai", role: "general" }],
      }),
      { scope: "project" },
    );
    const loaded = await loadAssentorConfig(dir);
    expect(loaded.reviewers[0]?.provider).toBe("openai");
    // ensure we did not require a project path === home
    expect(path.resolve(loaded.project.path)).toBe(path.resolve(dir));
    expect(path.resolve(dir)).not.toBe(path.resolve(os.homedir()));
  });

  it("doctor reports runtime info", async () => {
    const lines = await doctorAssentor();
    expect(lines.some((line) => line.startsWith("node:"))).toBe(true);
  });
});
