import type { Command } from "commander";
import { listModes, type ModeDefinition } from "../modes/registry.js";

const HEADER = ["ID", "TITLE", "KIND", "AVAILABLE", "EDITS CODE", "AUTONOMY", "DESCRIPTION"];

/** Aligned text table of the registry; unavailable modes say so in the AVAILABLE column. */
export function formatModesTable(modes: readonly ModeDefinition[] = listModes()): string {
  const rows = modes.map((m) => [
    m.id,
    m.title,
    m.kind,
    m.available ? "✓" : "✗ not yet",
    m.editsCode ? "✓" : "✗",
    m.defaultAutonomy,
    m.description,
  ]);
  const widths = HEADER.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const notAvailable = modes.filter((m) => !m.available).length;
  return [
    line(HEADER),
    ...rows.map(line),
    "",
    `${notAvailable} of ${modes.length} modes are not available yet; "assentor run --mode <id>" refuses them before any work.`,
  ].join("\n");
}

/** The registry list as JSON, exactly the ModeDefinition fields. */
export function formatModesJson(modes: readonly ModeDefinition[] = listModes()): string {
  return JSON.stringify(modes, null, 2);
}

/** Adds `assentor modes [--json]`. Reads the registry only; never loads or writes config. */
export function registerModesCommand(program: Command): void {
  program
    .command("modes")
    .description("List modes: availability, edits code, default autonomy")
    .option("--json", "Emit the registry as JSON", false)
    .action((options: { json?: boolean }) => {
      console.log(options.json ? formatModesJson() : formatModesTable());
    });
}
