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
} from "../../packages/engine/src/index.js";
import { saveGlobalDefaults, type AssentorServices } from "../../packages/engine/src/services/app.js";
import { initAssentorProject } from "../../packages/cli/src/cli/commands.js";
import { cycleRunMode } from "../../packages/cli/src/tui/screens/settings.js";

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

/** A user file and an optional project file; returns the project dir. */
async function layered(user: string[], project: string[] | null): Promise<string> {
  const dir = await projectDir();
  await fs.mkdir(path.dirname(userConfigPath()), { recursive: true });
  await fs.writeFile(userConfigPath(), user.join("\n"), "utf8");
  if (project) {
    await fs.mkdir(path.join(dir, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(dir, ".assentor", "config.yaml"), project.join("\n"), "utf8");
  }
  return dir;
}

const tui = (dir: string) =>
  ({ projectPath: dir, audit: { append: async () => undefined } }) as unknown as AssentorServices;

/** Every section set to a non-default value, so a dropped field changes the result. */
const FULL_CONFIG = {
  executor: { provider: "claude-code", model: "opus" },
  run: { mode: "autopilot", autonomy: "manual" },
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
    // Not typed yet (T02B-02): kept as written and round-tripped.
    lead: {
      lead: { provider: "claude-code", model: "opus" },
      limits: { maxSeats: 6, maxTasks: 20 },
      policy: { integrate: "approve", reviewBeforeAccept: true },
    },
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

  it("keeps a modes.<id> section it does not type yet, and rejects unknown mode ids", async () => {
    const dir = await projectDir();
    const file = await saveAssentorConfig(dir, parseAssentorConfig(FULL_CONFIG), { scope: "project" });

    expect((await readYaml(file)).modes).toMatchObject({ lead: FULL_CONFIG.modes.lead });
    expect((await loadAssentorConfig(dir)).modes.lead).toEqual(FULL_CONFIG.modes.lead);
    expect(() => parseAssentorConfig({ modes: { reveiw: { team: "x" } } })).toThrow(/unknown mode .{0,2}"reveiw/);
    expect(() => parseAssentorConfig({ modes: { lead: "opus" } })).toThrow();
    expect(() => parseAssentorConfig({ modes: { supervisor: {} } })).toThrow(/did you mean modes\.lead/);
    // Inherited Object keys are not aliases.
    expect(() => parseAssentorConfig({ modes: { constructor: {} } })).toThrow(/unknown mode \\?"constructor/);
    expect(() => parseAssentorConfig({ modes: { constructor: {} } })).not.toThrow(/did you mean/);
    expect(() => parseAssentorConfig({ modes: { review: { policy: "majority" } } })).toThrow(); // typed: team required
  });

  it("keeps untyped modes.cascade keys and adds no dangerAreas default", () => {
    const config = parseAssentorConfig({ modes: { cascade: { tiers: [{ team: "fast" }], future: 1 } } });
    expect(config.modes.cascade).toEqual({ tiers: [{ team: "fast" }], future: 1 });
  });

  it("keeps run.autonomy and writes run.mode to match it for older readers", async () => {
    const dir = await projectDir();
    const file = await saveAssentorConfig(
      dir,
      parseAssentorConfig({ run: { mode: "supervised", autonomy: "autopilot" } }),
      { scope: "project" },
    );

    expect((await readYaml(file)).run).toEqual({ mode: "autopilot", autonomy: "autopilot" });
    expect((await loadAssentorConfig(dir)).run).toEqual({ mode: "autopilot", autonomy: "autopilot" });
  });

  it("does not add run.autonomy to a legacy config", async () => {
    const dir = await projectDir();
    const file = await saveAssentorConfig(dir, parseAssentorConfig({ run: { mode: "autopilot" } }), {
      scope: "project",
    });

    expect((await readYaml(file)).run).toStrictEqual({ mode: "autopilot" });
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

  it("does not copy a project's run.autonomy into the user config", async () => {
    const dir = await layered(["executor:", "  provider: mock"], ["run:", "  autonomy: manual"]);
    const merged = await loadAssentorConfig(dir);
    expect(merged.run).toEqual({ mode: "supervised", autonomy: "manual" });

    await saveGlobalDefaults(tui(dir), merged);

    expect(await readYaml(userConfigPath())).not.toHaveProperty("run");
  });

  it("(a) a save without a toggle keeps the user's own run section, ignoring a project autopilot", async () => {
    const dir = await layered(["run:", "  autonomy: manual"], ["run:", "  mode: autopilot"]);
    const merged = await loadAssentorConfig(dir);
    expect(merged.run.mode).toBe("autopilot");

    await saveGlobalDefaults(tui(dir), { ...merged, executor: { provider: "codex" } });

    const written = await readYaml(userConfigPath());
    expect(written.run).toStrictEqual({ autonomy: "manual" });
    expect(written.executor).toEqual({ provider: "codex" });
  });

  it("(b) a save without a toggle adds no run section from a project autopilot", async () => {
    for (const project of [["run:", "  mode: autopilot"], ["run:", "  autonomy: autopilot"]]) {
      const dir = await layered(["executor:", "  provider: mock"], project);
      await saveGlobalDefaults(tui(dir), await loadAssentorConfig(dir));
      expect(await readYaml(userConfigPath())).not.toHaveProperty("run");
    }
  });

  it("(c) a mode toggle is saved, keeping the user's own autonomy when it agrees", async () => {
    const dir = await layered(["run:", "  autonomy: autopilot"], ["run:", "  mode: supervised"]);
    const merged = await loadAssentorConfig(dir);
    expect(merged.run).toStrictEqual({ mode: "supervised" });

    await saveGlobalDefaults(tui(dir), cycleRunMode(merged), { runChanged: true });

    expect((await readYaml(userConfigPath())).run).toEqual({ mode: "autopilot", autonomy: "autopilot" });
  });

  it("a toggle away from the user's own autonomy drops it so the toggle survives a reload", async () => {
    const dir = await layered(["run:", "  autonomy: manual"], null);
    const merged = await loadAssentorConfig(dir);

    await saveGlobalDefaults(tui(dir), cycleRunMode(merged), { runChanged: true });

    expect((await readYaml(userConfigPath())).run).toStrictEqual({ mode: "autopilot" });
    expect((await loadAssentorConfig(dir)).run.mode).toBe("autopilot");
  });
});

describe("autonomy across user and project layers", () => {
  it("a project's run.mode beats the user's run.autonomy", async () => {
    const dir = await layered(["run:", "  autonomy: autopilot"], ["run:", "  mode: supervised"]);
    expect((await loadAssentorConfig(dir)).run).toStrictEqual({ mode: "supervised" });
  });

  it("a project's run.autonomy beats the user's run.mode", async () => {
    const dir = await layered(["run:", "  mode: autopilot"], ["run:", "  autonomy: supervised"]);
    expect((await loadAssentorConfig(dir)).run).toEqual({ mode: "supervised", autonomy: "supervised" });
  });

  it("the user's run.autonomy applies when the project has no run section", async () => {
    const dir = await layered(["run:", "  autonomy: manual"], ["executor:", "  provider: mock"]);
    expect((await loadAssentorConfig(dir)).run).toEqual({ mode: "supervised", autonomy: "manual" });
  });

  it("an `assentor init` project file pins the project against a user autopilot", async () => {
    const dir = await layered(["run:", "  autonomy: autopilot"], null);
    await initAssentorProject(dir);
    expect((await loadAssentorConfig(dir)).run.mode).toBe("supervised");
  });

  it("a blank project run.autonomy inherits the user's value", async () => {
    const dir = await layered(["run:", "  autonomy: manual"], ["run:", "  autonomy:"]);
    expect((await loadAssentorConfig(dir)).run).toEqual({ mode: "supervised", autonomy: "manual" });
  });

  it("treats a null or blank run.autonomy as unset", async () => {
    const dir = await layered(["run:", "  mode: autopilot", "  autonomy:"], null);
    expect((await loadAssentorConfig(dir)).run).toStrictEqual({ mode: "autopilot" });
    expect(parseAssentorConfig({ run: { mode: "autopilot", autonomy: "  " } }).run).toStrictEqual({
      mode: "autopilot",
    });
  });
});

describe("saveAssentorConfig on a symlinked config file", () => {
  it("writes through the symlink, keeps it a symlink and keeps the file mode", async () => {
    const project = await projectDir();
    const dotfiles = await fs.mkdtemp(path.join(TEMP_ROOT, "dotfiles-"));
    tempDirs.push(dotfiles);
    const real = path.join(dotfiles, "config.yaml");
    await fs.writeFile(real, "routing:\n  strategy: CHEAPEST\n", { mode: 0o640 });
    await fs.mkdir(path.dirname(userConfigPath()), { recursive: true });
    await fs.symlink(real, userConfigPath());

    const config = await loadAssentorConfig(project);
    config.routing.strategy = "BEST";
    await saveAssentorConfig(project, config, { scope: "user" });

    expect((await fs.lstat(userConfigPath())).isSymbolicLink()).toBe(true);
    expect(((await readYaml(real)).routing as { strategy: string }).strategy).toBe("BEST");
    expect((await fs.stat(real)).mode & 0o777).toBe(0o640);
    expect((await fs.readdir(dotfiles)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
