import { promises as fs } from "node:fs";
import path from "node:path";
import { SEAT_ROLE_PATTERN } from "#assentor/protocol/seats.js";
import { SkillLibrary, skillLayerDirs, type SkillLibraryLoadOptions } from "#assentor/engine/skills/index.js";

/**
 * `assentor skills` commands (task TE-07): list, show, new. Same shape as
 * `assentor prompts` (src/cli/prompts.ts): exported functions that return the
 * exit code; `src/cli/index.ts` wires them to commander.
 */

export interface SkillCommandOptions extends Omit<SkillLibraryLoadOptions, "projectPath"> {
  projectPath: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

function load(options: SkillCommandOptions): Promise<SkillLibrary> {
  return SkillLibrary.load({ projectPath: options.projectPath, userDir: options.userDir, builtinDir: options.builtinDir });
}

function reportErrors(library: SkillLibrary, options: SkillCommandOptions): number {
  for (const error of library.errors) {
    options.err(`${error.layer} ${error.file}: ${error.message}`);
  }
  return library.errors.length > 0 ? 1 : 0;
}

/** Lists skills; exits 1 when any skill file failed to load (each error is printed). */
export async function listSkills(options: SkillCommandOptions): Promise<number> {
  const library = await load(options);
  const skills = library.list();
  if (skills.length === 0) {
    options.out("No skills");
  }
  for (const skill of skills) {
    const where = skill.overrides ? `${skill.layer}, overrides ${skill.overrides}` : skill.layer;
    options.out(`${skill.name} (${where}, ~${skill.tokens} tokens): ${skill.description}`);
  }
  return reportErrors(library, options);
}

export async function showSkill(options: SkillCommandOptions & { name: string }): Promise<number> {
  const library = await load(options);
  const skill = library.get(options.name);
  if (!skill) {
    options.err(`Unknown skill "${options.name}"`);
    return 1;
  }
  const list = (values?: readonly string[]) => (values ? values.join(", ") : "any");
  const lines: Array<[string, string]> = [
    ["name", skill.name],
    ["description", skill.description],
    ["roles", list(skill.roles)],
    ["modes", list(skill.modes)],
    ["profiles", list(skill.profiles)],
    ["autoload", skill.autoload ? [...skill.autoload.keywords, ...skill.autoload.globs].join(", ") || "-" : "-"],
    ["version", String(skill.version)],
    ["tokens", `~${skill.tokens}`],
    ["layer", skill.layer],
    ["file", skill.file],
    ["overrides", skill.overrides ?? "-"],
  ];
  for (const [key, value] of lines) options.out(`${key}: ${value}`);
  options.out("");
  options.out(skill.body);
  return 0;
}

const scaffold = (name: string) => `---
name: ${name}
description: Use when … (one line, at most 200 characters; it is all a seat sees until it loads the skill)
# roles: [engineer]        # seat roles that may load it; omit for any role
# autoload:                # load without a request when the task or changed files match
#   keywords: [example]
#   globs: ["src/**"]
version: 1
---
Short, concrete do/don't list. This text costs tokens only after it is loaded.
`;

/** Writes `<layer>/<name>/SKILL.md` from a template; never overwrites. */
export async function newSkill(options: SkillCommandOptions & { name: string; to?: string }): Promise<number> {
  const to = options.to ?? "user";
  if (to !== "user" && to !== "project") {
    options.err(`--to must be "user" or "project", got "${to}"`);
    return 1;
  }
  if (!SEAT_ROLE_PATTERN.test(options.name) || options.name.length > 48) {
    options.err(`Skill name "${options.name}" must be kebab-case, at most 48 characters (e.g. targeted-reading)`);
    return 1;
  }
  const layerDir = skillLayerDirs({ projectPath: options.projectPath, userDir: options.userDir }).find((d) => d.layer === to)!.dir;
  const dir = path.join(layerDir, options.name);
  const file = path.join(dir, "SKILL.md");
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(file, scaffold(options.name), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      options.err(`Skill "${options.name}" already exists at ${file}`);
      return 1;
    }
    throw error;
  }
  options.out(`Created ${file}. Edit its description and body, then run "assentor skills show ${options.name}".`);
  return 0;
}
