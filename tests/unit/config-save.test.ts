import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AssentorConfigSchema,
  loadAssentorConfig,
  parseAssentorConfig,
  saveAssentorConfig,
  userConfigPath,
} from "../../src/index.js";
import { saveGlobalDefaults, type AssentorServices } from "../../src/services/app.js";

const TEMP_ROOT = path.join(process.cwd(), ".tmp", "config-save-tests");
const tempDirs: string[] = [];

beforeEach(async () => {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const userDir = await fs.mkdtemp(path.join(TEMP_ROOT, "user-"));
  tempDirs.push(userDir);
  process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
});

afterEach(async () => {
  delete process.env.ASSENTOR_USER_DIR;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function projectDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
  tempDirs.push(dir);
  return dir;
}

async function readYaml(file: string): Promise<Record<string, unknown>> {
  return parseYaml(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

/** Every section set to a non-default value, so a dropped field changes the result. */
const FULL_CONFIG = {
  executor: { provider: "claude-code", model: "opus" },
  run: { mode: "autopilot" },
  reviewers: [
    {
      provider: "claude",
      transport: "cli",
      role: "security",
      name: "Sec",
      model: "sonnet",
      fallback: { transport: "api", provider: "gemini", model: "gemini-2.5-flash" },
    },
    { provider: "gemini", transport: "api", role: "general", keyId: "key-1" },
  ],
  teams: {
    "review-panel": {
      description: "Mixed panel",
      seats: [
        { provider: "claude-code", model: "opus", count: 2, role: "code-reviewer" },
        { provider: "gemini", transport: "api", role: "security-reviewer" },
      ],
    },
  },
  modes: {
    review: { team: "review-panel", policy: "majority", tiebreak: "negotiate" },
    negotiate: { team: "review-panel", strategy: "vote", maxRounds: 2, consensus: 0.6 },
  },
  routing: { strategy: "BEST", reviewStrategy: "PANEL" },
  models: { default: "AUTO", gemini: "gemini-2.5-flash", openai: "gpt-4o-mini" },
  limits: { maxRounds: 3, maxMessages: 20, maxRuntimeMinutes: 30, maxToolCalls: 50 },
  binaries: { claude: "/opt/claude", codex: "/opt/codex" },
  git: { checkpoints: false, autoCommit: true },
  security: { redactSecrets: true, allowExternalPaths: true },
  artifacts: { diff: false, tests: true, logs: false, screenshots: true },
  verification: {
    enabled: false,
    commands: { typecheck: "tsc", test: "vitest", lint: "", build: "tsc -b" },
    skipReviewOnFailure: { typecheck: false, build: true, test: false, lint: true },
  },
};

describe("saveAssentorConfig", () => {
  it("round-trips every section, including teams, modes and executor.model", async () => {
    const dir = await projectDir();
    const config = parseAssentorConfig(FULL_CONFIG);

    await saveAssentorConfig(dir, config, { scope: "project" });
    const loaded = await loadAssentorConfig(dir);

    expect(loaded).toEqual({ ...config, project: { path: path.resolve(dir) } });
  });

  it("writes every top-level schema section", async () => {
    const dir = await projectDir();
    const file = await saveAssentorConfig(dir, parseAssentorConfig({}), {
      scope: "project",
    });
    const written = await readYaml(file);

    expect(Object.keys(written).sort()).toEqual(
      Object.keys(AssentorConfigSchema.shape).sort(),
    );
    expect(written.project).toEqual({ path: "." });
  });

  it("omits optional fields that are unset instead of writing nulls", async () => {
    const dir = await projectDir();
    const file = await saveAssentorConfig(dir, parseAssentorConfig({}), {
      scope: "project",
    });
    const text = await fs.readFile(file, "utf8");

    expect(text).not.toContain("null");
    expect((await readYaml(file)).executor).toEqual({ provider: "mock" });
  });

  it("keeps the user file's own teams and modes when asked to preserve them", async () => {
    const dir = await projectDir();
    await fs.mkdir(path.dirname(userConfigPath()), { recursive: true });
    await fs.writeFile(
      userConfigPath(),
      [
        "teams:",
        "  alpha:",
        "    seats:",
        "      - { provider: claude-code, model: opus }",
        "modes:",
        "  review: { team: alpha }",
      ].join("\n"),
      "utf8",
    );
    await fs.mkdir(path.join(dir, ".assentor"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".assentor", "config.yaml"),
      ["teams:", "  beta:", "    seats:", "      - { provider: codex }"].join("\n"),
      "utf8",
    );

    const merged = await loadAssentorConfig(dir);
    expect(Object.keys(merged.teams).sort()).toEqual(["alpha", "beta"]);

    merged.executor.provider = "cursor";
    await saveAssentorConfig(dir, merged, {
      scope: "user",
      preserveFromExisting: ["teams", "modes"],
    });

    const written = await readYaml(userConfigPath());
    expect(Object.keys(written.teams as object)).toEqual(["alpha"]);
    expect(written.modes).toEqual({ review: { team: "alpha" } });
    expect((written.executor as { provider: string }).provider).toBe("cursor");
  });

  it("refuses to save over an unparseable file when preserving, leaving it unchanged", async () => {
    const dir = await projectDir();
    const broken = "teams:\n  alpha: [unclosed\n";
    await fs.mkdir(path.dirname(userConfigPath()), { recursive: true });
    await fs.writeFile(userConfigPath(), broken, "utf8");

    await expect(
      saveAssentorConfig(dir, parseAssentorConfig({}), {
        scope: "user",
        preserveFromExisting: ["teams", "modes"],
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(userConfigPath(), "utf8")).toBe(broken);
  });

  it("omits preserved sections the existing file does not have", async () => {
    const dir = await projectDir();
    const config = parseAssentorConfig({
      teams: { solo: { seats: [{ provider: "mock" }] } },
    });

    await saveAssentorConfig(dir, config, {
      scope: "user",
      preserveFromExisting: ["teams", "modes"],
    });

    const written = await readYaml(userConfigPath());
    expect(written).not.toHaveProperty("teams");
    expect(written).not.toHaveProperty("modes");
  });
});

describe("saveGlobalDefaults (TUI save)", () => {
  it("does not copy project-only teams into the user config", async () => {
    const dir = await projectDir();
    await fs.mkdir(path.join(dir, ".assentor"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".assentor", "config.yaml"),
      ["teams:", "  project-only:", "    seats:", "      - { provider: codex }"].join("\n"),
      "utf8",
    );
    const merged = await loadAssentorConfig(dir);
    expect(merged.teams).toHaveProperty("project-only");

    const services = {
      projectPath: dir,
      audit: { append: async () => undefined },
    } as unknown as AssentorServices;
    await saveGlobalDefaults(services, merged);

    const written = await readYaml(userConfigPath());
    expect(written).not.toHaveProperty("teams");
    expect(written.executor).toEqual({ provider: "mock" });
  });
});
