import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AssentorConfig } from "../config/schema.js";
import {
  builtinPlaybookDir,
  MAX_PLAYBOOK_FILE_BYTES,
  PlaybookSchema,
  playbookProblems,
  sessionSpecFor,
  type Playbook,
} from "../playbooks/library.js";
import { PromptLibrary } from "../prompts/index.js";
import type { SessionSpecInput } from "./registry.js";
import { ModeValidationError } from "./session.js";

/**
 * Built-in playbooks as mode sessions (T02B-09). A mode's `buildSession` and
 * `validate` are synchronous, so the YAML is read here instead of through the
 * async `PlaybookLibrary`. A missing, oversized or invalid built-in file is a
 * `ModeValidationError`, not a raw ENOENT or ZodError.
 *
 * A stage's `team` is a config team name: the host binds it with `seatsFor`.
 * So a mode's config must define every team its playbook uses.
 */
const cache = new Map<string, Playbook>();

export function builtinPlaybook(id: string): Playbook {
  const hit = cache.get(id);
  if (hit) return hit;
  const fail = (why: string): never => {
    throw new ModeValidationError([`built-in playbook "${id}": ${why}`]);
  };
  const file = path.join(builtinPlaybookDir(), `${id}.yaml`);
  let text = "";
  try {
    if (statSync(file).size > MAX_PLAYBOOK_FILE_BYTES) fail(`file is larger than ${MAX_PLAYBOOK_FILE_BYTES} bytes`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof ModeValidationError) throw error;
    fail(`cannot read ${file}: ${(error as Error).message}`);
  }
  const parsed = PlaybookSchema.safeParse(safeYaml(text, fail));
  if (!parsed.success) return fail(parsed.error.message);
  const prompts = PromptLibrary.loadBuiltinSync();
  const issues = playbookProblems(parsed.data, (role) => prompts.has(role));
  if (parsed.data.id !== id) issues.push(`id must match the file name ("${id}")`);
  if (issues.length > 0) throw new ModeValidationError(issues.map((p) => `built-in playbook "${id}": ${p}`));
  cache.set(id, parsed.data);
  return parsed.data;
}

function safeYaml(text: string, fail: (why: string) => never): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    return fail(`invalid YAML: ${(error as Error).message}`);
  }
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
    const team = Object.hasOwn(config.teams, stage.team) ? config.teams[stage.team] : undefined;
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
