import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTONOMY_LEVELS,
  MODE_IDS,
  ModeIdSchema,
  getMode,
  listModes,
  loadAssentorConfig,
  parseAssentorConfig,
} from "../../packages/engine/src/index.js";
import {
  parseModeFlags,
  runAssentorTask,
  type RunAssentorInput,
} from "../../packages/cli/src/cli/commands.js";
import { MockExecutor } from "../../packages/engine/src/providers/executors/mock/index.js";
import { cycleRunMode } from "../../packages/cli/src/tui/screens/settings.js";

describe("mode registry", () => {
  it("lists every modes.md §3 mode in catalog order with complete metadata", () => {
    const modes = listModes();
    expect(modes.map((m) => m.id)).toEqual([...MODE_IDS]);
    expect(modes).toHaveLength(17);
    for (const m of modes) {
      expect(m.title).not.toBe("");
      expect(m.description).not.toBe("");
      expect(AUTONOMY_LEVELS).toContain(m.defaultAutonomy);
      expect(["static", "dynamic"]).toContain(m.kind);
    }
  });

  it("marks only solo available, because only solo runs from the CLI today", () => {
    expect(listModes().filter((m) => m.available).map((m) => m.id)).toEqual(["solo"]);
    expect(getMode("review")?.available).toBe(false);
    expect(getMode("negotiate")?.available).toBe(false);
  });

  it("records the kind and read-only modes from the design", () => {
    expect(getMode("lead")).toMatchObject({ kind: "dynamic", editsCode: true, title: "Lead (Supervisor)" });
    expect(getMode("solo")).toMatchObject({ kind: "static", editsCode: true, defaultAutonomy: "supervised" });
    expect(listModes().filter((m) => !m.editsCode).map((m) => m.id)).toEqual(["review", "explore"]);
    expect(listModes().filter((m) => m.kind === "dynamic").map((m) => m.id)).toEqual([
      "lead",
      "cascade",
      "pair",
      "redteam",
      "swarm",
      "debug",
      "interactive",
      "auto",
    ]);
  });

  it("resolves the supervisor alias and any case, and rejects unknown ids", () => {
    expect(getMode("supervisor")?.id).toBe("lead");
    expect(getMode(" Lead ")?.id).toBe("lead");
    expect(getMode("nope")).toBeUndefined();
    expect(ModeIdSchema.parse("SUPERVISOR")).toBe("lead");
    expect(ModeIdSchema.safeParse("autopilot").success).toBe(false);
    expect(ModeIdSchema.safeParse(3).success).toBe(false);
  });
});

describe("--mode / --autonomy / --autopilot flags", () => {
  it("maps legacy --mode supervised|autopilot to autonomy with a deprecation notice", () => {
    expect(parseModeFlags({ mode: "autopilot" })).toEqual({
      autonomy: "autopilot",
      notice: "Note: --mode autopilot is deprecated; use --autonomy autopilot.",
    });
    expect(parseModeFlags({ mode: "supervised" })).toEqual({
      autonomy: "supervised",
      notice: "Note: --mode supervised is deprecated; use --autonomy supervised.",
    });
  });

  it("keeps --autopilot as before, with no notice, and still beating --mode supervised", () => {
    expect(parseModeFlags({ autopilot: true })).toEqual({ autonomy: "autopilot" });
    expect(parseModeFlags({ autopilot: true, mode: "supervised" }).autonomy).toBe("autopilot");
    expect(parseModeFlags({ autopilot: false })).toEqual({});
  });

  it("parses --autonomy, any case, and rejects unknown levels", () => {
    expect(parseModeFlags({ autonomy: "manual" })).toEqual({ autonomy: "manual" });
    expect(parseModeFlags({ autonomy: "AutoPilot" })).toEqual({ autonomy: "autopilot" });
    expect(() => parseModeFlags({ autonomy: "yolo" })).toThrow(
      'Unknown autonomy "yolo". Use one of: manual, supervised, autopilot.',
    );
  });

  it("rejects --autonomy that disagrees with a legacy flag, and accepts one that agrees", () => {
    expect(() => parseModeFlags({ autonomy: "manual", mode: "autopilot" })).toThrow(
      "--autonomy manual conflicts with --mode autopilot.",
    );
    expect(() => parseModeFlags({ autonomy: "supervised", autopilot: true })).toThrow(
      "--autonomy supervised conflicts with --autopilot.",
    );
    expect(parseModeFlags({ autonomy: "autopilot", mode: "autopilot" }).autonomy).toBe("autopilot");
  });

  it("passes a registry id through as modeId and rejects unknown modes", () => {
    expect(parseModeFlags({ mode: "solo" })).toEqual({ modeId: "solo" });
    expect(parseModeFlags({ mode: "supervisor", autonomy: "manual" })).toEqual({
      modeId: "lead",
      autonomy: "manual",
    });
    expect(() => parseModeFlags({ mode: "nope" })).toThrow(/^Unknown mode "nope"\. Modes: solo, .*, watch\.$/);
    expect(() => parseModeFlags({ mode: "" })).toThrow('Unknown mode "".');
  });

  it("points a mis-cased legacy --mode at --autonomy", () => {
    expect(() => parseModeFlags({ mode: "Autopilot" })).toThrow(
      /Unknown mode "Autopilot"\..* Did you mean --autonomy autopilot\?$/,
    );
    expect(() => parseModeFlags({ mode: "MANUAL" })).toThrow("Did you mean --autonomy manual?");
  });
});

describe("run.autonomy in config", () => {
  it("leaves legacy configs exactly as before", () => {
    expect(parseAssentorConfig({}).run).toEqual({ mode: "supervised" });
    expect(parseAssentorConfig({ run: { mode: "autopilot" } }).run).toStrictEqual({
      mode: "autopilot",
    });
    expect(parseAssentorConfig({ run: { mode: "bogus" } }).run.mode).toBe("supervised");
  });

  it("run.autonomy wins over run.mode and rewrites mode to match", () => {
    expect(parseAssentorConfig({ run: { mode: "supervised", autonomy: "autopilot" } }).run).toEqual({
      mode: "autopilot",
      autonomy: "autopilot",
    });
    expect(parseAssentorConfig({ run: { mode: "autopilot", autonomy: "manual" } }).run).toEqual({
      mode: "supervised",
      autonomy: "manual",
    });
    expect(parseAssentorConfig({ run: { autonomy: " Supervised " } }).run.autonomy).toBe("supervised");
  });

  it("rejects an unknown run.autonomy instead of silently defaulting", () => {
    expect(() => parseAssentorConfig({ run: { autonomy: "yolo" } })).toThrow();
  });

  it("the TUI mode toggle keeps run.autonomy in step so a save does not undo it", () => {
    const config = parseAssentorConfig({ run: { autonomy: "autopilot" } });
    expect(cycleRunMode(config).run).toEqual({ mode: "supervised", autonomy: "supervised" });
    expect(cycleRunMode(parseAssentorConfig({})).run).toStrictEqual({ mode: "autopilot" });
  });
});

// Full end-to-end runs; a timeout abandons a run whose MockExecutor spy then leaks into the next test.
describe("autonomy precedence and mode availability in runs", { timeout: 30_000 }, () => {
  let projectDir: string;
  let userDir: string;
  const savedUserDir = process.env.ASSENTOR_USER_DIR;

  async function writeConfig(run: string): Promise<void> {
    await fs.writeFile(
      path.join(projectDir, ".assentor", "config.yaml"),
      ["git:", "  checkpoints: false", "executor:", "  provider: mock", "run:", run, ""].join("\n"),
      "utf8",
    );
  }

  /** The prompt the executor got: autopilot sends the autonomous prompt, otherwise the bare goal. */
  async function executorPrompt(input: Partial<RunAssentorInput>): Promise<string | undefined> {
    const run = vi.spyOn(MockExecutor.prototype, "run");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { result } = await runAssentorTask({
        projectPath: projectDir,
        prompt: "goal",
        skipPreflight: true,
        skipGates: true,
        ...input,
      });
      expect(result.status).toBe("DONE");
      return run.mock.calls[0]?.[0].prompt;
    } finally {
      run.mockRestore();
      log.mockRestore();
      write.mockRestore();
    }
  }

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "modes-run-"));
    userDir = await fs.mkdtemp(path.join(os.tmpdir(), "modes-run-user-"));
    process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
    await fs.mkdir(path.join(projectDir, ".assentor"), { recursive: true });
    await writeConfig("  mode: supervised");
  });

  afterEach(async () => {
    if (savedUserDir === undefined) delete process.env.ASSENTOR_USER_DIR;
    else process.env.ASSENTOR_USER_DIR = savedUserDir;
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(userDir, { recursive: true, force: true });
  });

  it("CLI autonomy > run.autonomy > run.mode when loading config", async () => {
    await writeConfig("  mode: autopilot\n  autonomy: manual");
    expect((await loadAssentorConfig(projectDir)).run).toEqual({ mode: "supervised", autonomy: "manual" });
    expect((await loadAssentorConfig(projectDir, { autonomy: "autopilot" })).run).toEqual({
      mode: "autopilot",
      autonomy: "autopilot",
    });
    // The legacy --mode override is still a CLI value, so it also beats run.autonomy.
    expect((await loadAssentorConfig(projectDir, { mode: "autopilot" })).run.mode).toBe("autopilot");
    // When both CLI values are given, autonomy wins.
    expect(
      (await loadAssentorConfig(projectDir, { mode: "autopilot", autonomy: "supervised" })).run.mode,
    ).toBe("supervised");
  });

  it("--mode autopilot, --autopilot and run.mode: autopilot reach the engine as before", async () => {
    const supervised = await executorPrompt({});
    expect(supervised).toBe("goal");

    const legacyApi = await executorPrompt({ mode: "autopilot" });
    const legacyFlag = await executorPrompt({ autonomy: parseModeFlags({ mode: "autopilot" }).autonomy });
    const shortcut = await executorPrompt({ autonomy: parseModeFlags({ autopilot: true }).autonomy });
    const newFlag = await executorPrompt({ autonomy: "autopilot" });
    await writeConfig("  mode: autopilot");
    const legacyConfig = await executorPrompt({});
    await writeConfig("  autonomy: autopilot");
    const newConfig = await executorPrompt({});

    for (const prompt of [legacyApi, legacyFlag, shortcut, newFlag, legacyConfig, newConfig]) {
      expect(prompt).not.toBe("goal");
      expect(prompt).toBe(legacyApi);
    }
  });

  it("manual runs like supervised today", async () => {
    await writeConfig("  mode: autopilot");
    expect(await executorPrompt({ autonomy: "manual" })).toBe("goal");
  });

  it("an available registry mode runs as today", async () => {
    expect(await executorPrompt({ modeId: "solo" })).toBe("goal");
  });

  it("a mode that is not available fails before any work", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runAssentorTask({ projectPath: projectDir, prompt: "goal", modeId: "review" }),
      ).rejects.toThrow("Mode review is not available yet. For a review panel use run --team.");
      for (const id of ["negotiate", "lead"] as const) {
        await expect(
          runAssentorTask({ projectPath: projectDir, prompt: "goal", modeId: id }),
        ).rejects.toThrow(new RegExp(`^Mode ${id} is not available yet\\.$`));
      }
      expect(log).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
    await expect(fs.stat(path.join(projectDir, ".assentor", "tasks"))).rejects.toThrow();
  });
});
