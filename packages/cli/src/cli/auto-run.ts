import path from "node:path";
import { loadAssentorConfig } from "#assentor/engine/config/load.js";
import { classifyRisk } from "#assentor/engine/modes/danger.js";
import { suggestMode } from "#assentor/engine/modes/auto.js";
import { ModeIdSchema, listModes, type ModeId } from "#assentor/engine/modes/registry.js";
import { TaskComplexityAnalyzer } from "#assentor/engine/review/complexity.js";
import type { RunAssentorInput } from "./commands.js";
import { terminalQuestionIO } from "./mode-questions.js";
import { ask } from "./run-estimate.js";

/**
 * `assentor run --mode auto`: suggests a mode for the task (`suggestMode`, T02B-08), asks the
 * user, and returns the mode to run. The caller runs it through the normal `--mode` path.
 * Throws when nothing should run: cancelled, or it must ask and there is no terminal.
 */
export async function chooseAutoMode(input: RunAssentorInput): Promise<ModeId> {
  const config = await loadAssentorConfig(path.resolve(input.projectPath), {
    mode: input.autopilot ? "autopilot" : input.mode,
    autonomy: input.autonomy,
    profile: input.profile,
  });
  const autonomy = config.run.autonomy ?? config.run.mode;
  const io = input.modeHooks?.questions ?? input.confirmIO ?? terminalQuestionIO();
  const say = (line: string) => void io.output.write(`${line}\n`);

  const available = listModes().filter((m) => m.available && m.id !== "auto").map((m) => m.id);
  const suggestion = suggestMode({
    task: input.prompt,
    complexity: new TaskComplexityAnalyzer().analyze({ taskText: input.prompt }),
    availableModes: available,
  });
  const mode = suggestion.mode as ModeId;
  const risk = classifyRisk({ taskText: input.prompt }, { projectRoot: path.resolve(input.projectPath), extraRules: config.modes.cascade?.dangerAreas });
  say(`Suggested mode: ${mode} (confidence ${suggestion.confidence})`);
  for (const reason of suggestion.reasons) say(`  ${reason}`);
  if (risk.level === "danger") say(`  Danger area (${risk.categories.join(", ")}): ${risk.reasons[0] ?? ""}`);

  // Danger always asks, even under autopilot or --yes.
  if ((autonomy === "autopilot" || input.yes) && risk.level !== "danger") {
    say(`Running ${mode} (${input.yes ? "--yes" : "autopilot"}).`);
    return mode;
  }
  if (!io.interactive) {
    throw new Error(
      `Mode auto needs to ask before running "${mode}"${risk.level === "danger" ? " (danger area)" : ""} and there is no terminal. ` +
        `Run the mode directly (--mode ${mode}), or use --autonomy autopilot or --yes for a task that is not a danger area.`,
    );
  }
  const others = available.filter((id) => id !== mode);
  for (;;) {
    const answer = (await ask(io, `Run ${mode}? [y] yes / [n] cancel / or type another mode (${others.join(", ")}): `)).trim().toLowerCase();
    if (/^y(es)?$/.test(answer)) return mode;
    if (answer === "" || /^(n|no|c|cancel)$/.test(answer)) throw new Error("Run cancelled before it started.");
    const picked = ModeIdSchema.safeParse(answer);
    if (picked.success && available.includes(picked.data)) return picked.data;
    say(`Not an available mode: ${answer}`);
  }
}
