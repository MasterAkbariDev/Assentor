import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AssentorConfig } from "../config/schema.js";
import { builtinPlaybookDir, PlaybookSchema, sessionSpecFor, type Playbook } from "../playbooks/library.js";
import type { SessionSpecInput } from "./registry.js";

/**
 * Built-in playbooks as mode sessions (T02B-09). A mode's `buildSession` and
 * `validate` are synchronous, so the YAML is read here instead of through the
 * async `PlaybookLibrary`. The built-ins are checked by tests, so a parse
 * failure is a bug and throws.
 *
 * A stage's `team` is a config team name: the host binds it with `seatsFor`.
 * So a mode's config must define every team its playbook uses.
 */
export function builtinPlaybook(id: string): Playbook {
  const text = readFileSync(path.join(builtinPlaybookDir(), `${id}.yaml`), "utf8");
  return PlaybookSchema.parse(parseYaml(text));
}

/** The session graph of a built-in playbook, with the mode input's title and goal. */
export function builtinPlaybookSession(id: string, input: { goal: string; title: string }): SessionSpecInput {
  return { ...sessionSpecFor(builtinPlaybook(id), input.goal), title: input.title };
}

/**
 * Problems with the config teams a built-in playbook needs, or `[]`. Each team a
 * stage names must exist in `teams`; a read-only playbook's teams have no edit
 * seat; an execute stage's team has at least one edit seat.
 */
export function builtinPlaybookTeamProblems(id: string, config: AssentorConfig): string[] {
  const playbook = builtinPlaybook(id);
  const problems: string[] = [];
  for (const stage of playbook.stages) {
    if (stage.team === undefined) continue;
    const team = config.teams[stage.team];
    if (!team) {
      problems.push(`mode "${id}" needs team "${stage.team}" in teams`);
      continue;
    }
    const hasEditSeat = team.seats.some((seat) => seat.permissions === "edit");
    if (playbook.readOnly && hasEditSeat) {
      problems.push(`team "${stage.team}" has an edit seat, but mode "${id}" is read-only`);
    }
    if (stage.kind === "execute" && !hasEditSeat) {
      problems.push(`team "${stage.team}" needs an edit seat for the "${stage.id}" stage`);
    }
  }
  return [...new Set(problems)];
}
