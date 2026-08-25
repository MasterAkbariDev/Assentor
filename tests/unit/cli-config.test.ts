import { describe, expect, it } from "vitest";
import { parseAssentorConfig } from "../../src/index.js";
import { doctorAssentor, initAssentorProject } from "../../src/cli/commands.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";

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
  });

  it("initializes .assentor/config.yaml", async () => {
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
    tempDirs.push(dir);

    const configPath = await initAssentorProject(dir);
    const raw = await fs.readFile(configPath, "utf8");
    expect(raw).toContain("executor:");
    expect(raw).toContain("provider: mock");
    expect(raw).toContain("routing:");
    expect(raw).toContain("models:");
  });

  it("saves and reloads run defaults", async () => {
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
    await saveAssentorConfig(dir, config);
    const loaded = await loadAssentorConfig(dir);
    expect(loaded.executor.provider).toBe("cursor");
    expect(loaded.reviewers[0]?.provider).toBe("gemini");
    expect(loaded.models.gemini).toBe("gemini-2.5-flash");
  });

  it("doctor reports runtime info", async () => {
    const lines = await doctorAssentor();
    expect(lines.some((line) => line.startsWith("node:"))).toBe(true);
  });
});
