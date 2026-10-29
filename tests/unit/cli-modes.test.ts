import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatModesJson, formatModesTable, registerModesCommand } from "../../src/cli/modes.js";
import { listModes } from "../../src/modes/registry.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Runs `assentor modes ...` through a fresh commander program and returns what it printed. */
async function runModes(args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerModesCommand(program);
  await program.parseAsync(["node", "assentor", "modes", ...args]);
  return log.mock.calls.map((call) => String(call[0]));
}

describe("assentor modes text table", () => {
  it("prints a header and one row per registered mode, in catalog order", () => {
    const lines = formatModesTable().split("\n");
    expect(lines[0]).toMatch(/^ID\s+TITLE\s+KIND\s+AVAILABLE\s+EDITS CODE\s+AUTONOMY\s+DESCRIPTION$/);
    const rows = lines.slice(1, 1 + listModes().length);
    expect(rows.map((row) => row.split(/\s{2,}/)[0])).toEqual(listModes().map((m) => m.id));
  });

  it("shows each mode's title, kind, edits-code mark and default autonomy from the registry", () => {
    const solo = formatModesTable().split("\n").find((line) => line.startsWith("solo "));
    expect(solo).toMatch(/^solo\s+Solo\s+static\s+✓\s+✓\s+supervised\s+One executor/);
    const review = formatModesTable().split("\n").find((line) => line.startsWith("review "));
    expect(review).toMatch(/^review\s+Review\s+static\s+✗ not yet\s+✗\s+supervised\s+/);
  });

  it("marks unavailable modes and says how many cannot run yet", () => {
    const text = formatModesTable();
    const unavailable = listModes().filter((m) => !m.available);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const mode of unavailable) {
      expect(text.split("\n").find((line) => line.startsWith(`${mode.id} `))).toContain("✗ not yet");
    }
    expect(text).toContain(
      `${unavailable.length} of ${listModes().length} modes are not available yet`,
    );
  });

  it("prints the table to stdout with no config loaded, and sets no exit code", async () => {
    const [output] = await runModes([]);
    expect(output).toBe(formatModesTable());
    expect(process.exitCode).toBeUndefined();
  });
});

describe("assentor modes --json", () => {
  it("prints exactly the registry list as parseable JSON", async () => {
    const [output] = await runModes(["--json"]);
    const parsed = JSON.parse(output ?? "");
    expect(parsed).toEqual(JSON.parse(JSON.stringify(listModes())));
    expect(parsed).toHaveLength(listModes().length);
    expect(parsed[0]).toEqual({
      id: "solo",
      title: "Solo",
      description: "One executor with a review loop; today's assentor run.",
      kind: "static",
      defaultAutonomy: "supervised",
      editsCode: true,
      available: true,
    });
    expect(output).toBe(formatModesJson());
  });

  it("keeps unavailable modes in the JSON with available false", async () => {
    const [output] = await runModes(["--json"]);
    const byId = new Map((JSON.parse(output ?? "[]") as { id: string; available: boolean }[]).map((m) => [m.id, m]));
    expect(byId.get("review")?.available).toBe(false);
    expect(byId.get("solo")?.available).toBe(true);
  });
});

describe("assentor modes help and arguments", () => {
  it("is listed in the program help with its --json option", () => {
    const program = new Command().name("assentor");
    registerModesCommand(program);
    const help = program.helpInformation();
    expect(help).toMatch(/^\s+modes \[options\]\s+List modes: availability/m);
    const modesHelp = program.commands.find((c) => c.name() === "modes")?.helpInformation() ?? "";
    expect(modesHelp).toContain("--json");
    expect(modesHelp).toContain("Emit the registry as JSON");
  });

  it("rejects stray arguments instead of ignoring them", async () => {
    await expect(runModes(["solo"])).rejects.toMatchObject({ exitCode: 1 });
  });
});
