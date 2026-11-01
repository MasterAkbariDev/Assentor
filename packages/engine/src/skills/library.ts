import { promises as fsp } from "node:fs";
import path from "node:path";
import { userAssentorDir } from "../config/paths.js";
import { classifyRisk } from "../modes/danger.js";
import { splitPromptFile, type PromptLayer } from "../prompts/format.js";
import { checkFileStat, isInside } from "../prompts/library.js";
import { resolvePackageRoot } from "../self/package-root.js";
import {
  estimateTokens,
  PROJECT_SKILL_FORBIDDEN_ROLES,
  validateSkillFrontMatter,
  type SkillFrontMatter,
} from "./format.js";

/**
 * Layered skill library (task TE-07). Layers, lowest first: built-in
 * (`<package>/skills`) → user (`~/.assentor/skills`) → project
 * (`<project>/.assentor/skills`); a skill in a higher layer replaces the one
 * with the same name. Each skill is a directory `<name>/SKILL.md`.
 *
 * Path safety as for prompts: a symlinked skill directory or `SKILL.md` must
 * resolve inside its layer directory, the project layer must resolve inside the
 * project, files are size-capped, the name is kebab-case and equals the
 * directory name. A bad skill is recorded in `errors` and skipped (a bad
 * override leaves the lower-layer skill in place). Other entries (plain files,
 * dot-directories) are ignored.
 */

/** Largest SKILL.md read. A body this size is ~8k tokens: anything bigger is not a "pack". */
export const MAX_SKILL_FILE_BYTES = 32 * 1024;
const SKILL_FILE = "SKILL.md";

export interface SkillDefinition extends SkillFrontMatter {
  body: string;
  layer: PromptLayer;
  /** Absolute path of its SKILL.md. */
  file: string;
  overrides?: PromptLayer;
  /** Estimated tokens of the body. */
  tokens: number;
}

export interface SkillLoadError {
  file: string;
  layer: PromptLayer;
  message: string;
}

export interface SkillLibraryLoadOptions {
  /** Adds the project layer `<projectPath>/.assentor/skills`. */
  projectPath?: string;
  /** Override the built-in directory (tests). */
  builtinDir?: string;
  /** Override the user directory (tests). Default `~/.assentor/skills`. */
  userDir?: string;
}

/** Who is asking: a seat's role, and the run's mode and profile. */
export interface SkillScope {
  role: string;
  mode?: string;
  profile?: string;
}

export function builtinSkillDir(): string {
  return path.join(resolvePackageRoot(), "skills");
}

export function skillLayerDirs(options: SkillLibraryLoadOptions = {}): Array<{ layer: PromptLayer; dir: string }> {
  const dirs: Array<{ layer: PromptLayer; dir: string }> = [
    { layer: "builtin", dir: options.builtinDir ?? builtinSkillDir() },
    { layer: "user", dir: options.userDir ?? path.join(userAssentorDir(), "skills") },
  ];
  if (options.projectPath) {
    dirs.push({ layer: "project", dir: path.join(path.resolve(options.projectPath), ".assentor", "skills") });
  }
  return dirs;
}

export class SkillLibrary {
  private constructor(
    private readonly skills: ReadonlyMap<string, SkillDefinition>,
    readonly errors: readonly SkillLoadError[],
  ) {}

  /** Load every layer. Never throws for bad files; see `errors`. */
  static async load(options: SkillLibraryLoadOptions = {}): Promise<SkillLibrary> {
    const skills = new Map<string, SkillDefinition>();
    const errors: SkillLoadError[] = [];
    for (const { layer, dir } of skillLayerDirs(options)) {
      const within = layer === "project" ? path.resolve(options.projectPath!) : undefined;
      for (const loaded of await readLayer(layer, dir, within, errors)) {
        const lower = skills.get(loaded.name);
        skills.set(loaded.name, lower ? { ...loaded, overrides: lower.layer } : loaded);
      }
    }
    return new SkillLibrary(skills, errors);
  }

  /** An empty library (no skills: every prompt stays exactly as it was). */
  static empty(): SkillLibrary {
    return new SkillLibrary(new Map(), []);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** Every skill, sorted by name. */
  list(): SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Why `scope` may not load `skill`, or undefined when it may. */
  refusal(skill: SkillDefinition, scope: SkillScope): string | undefined {
    if (skill.layer === "project" && PROJECT_SKILL_FORBIDDEN_ROLES.has(scope.role)) {
      return `project skills are not offered to reviewer role "${scope.role}"`;
    }
    if (skill.roles && !skill.roles.includes(scope.role)) return `not for role "${scope.role}"`;
    if (skill.modes && !(scope.mode && skill.modes.includes(scope.mode))) return `not for mode "${scope.mode ?? "(none)"}"`;
    if (skill.profiles && !(scope.profile && (skill.profiles as string[]).includes(scope.profile))) {
      return `not for profile "${scope.profile ?? "(none)"}"`;
    }
    return undefined;
  }

  /** Skills `scope` may load, sorted by name. */
  eligible(scope: SkillScope): SkillDefinition[] {
    return this.list().filter((skill) => this.refusal(skill, scope) === undefined);
  }

  /**
   * Eligible skills whose autoload trigger matches: a keyword (whole word, any
   * case) in `taskText`, or a glob matching one of `changedFiles` (repo-relative;
   * danger-classifier glob rules: any depth, `*`, `?`, `**`).
   */
  triggered(scope: SkillScope, input: { taskText?: string; changedFiles?: readonly string[] }): string[] {
    const rules = this.eligible(scope)
      .filter((skill) => skill.autoload && skill.autoload.keywords.length + skill.autoload.globs.length > 0)
      .map((skill) => ({ name: `skill.${skill.name}`, keywords: skill.autoload!.keywords, paths: skill.autoload!.globs }));
    if (rules.length === 0) return [];
    // Reuses the danger classifier's budgeted, regex-free matcher; built-in categories are ignored.
    const { categories } = classifyRisk(
      { taskText: input.taskText ?? "", paths: input.changedFiles ?? [] },
      { extraRules: rules },
    );
    return categories.filter((c) => c.startsWith("skill.")).map((c) => c.slice("skill.".length));
  }
}

async function readLayer(
  layer: PromptLayer,
  dir: string,
  within: string | undefined,
  errors: SkillLoadError[],
): Promise<SkillDefinition[]> {
  const out: SkillDefinition[] = [];
  let base: string;
  let entries: import("node:fs").Dirent[];
  try {
    base = await fsp.realpath(dir);
    entries = await fsp.readdir(dir, { withFileTypes: true });
    if (within !== undefined && !isInside(await fsp.realpath(within), base)) {
      throw new Error("the project skills directory resolves outside the project");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push({ file: dir, layer, message: errorMessage(error) });
    }
    return out;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const skillDir = path.join(dir, entry.name);
    const file = path.join(skillDir, SKILL_FILE);
    try {
      const realDir = await fsp.realpath(skillDir);
      if (!isInside(base, realDir)) throw new Error("symlink points outside the skills directory");
      if (!(await fsp.stat(realDir)).isDirectory()) continue;
      const target = await fsp.realpath(file);
      if (!isInside(base, target)) throw new Error("symlink points outside the skills directory");
      checkFileStat(await fsp.stat(target), MAX_SKILL_FILE_BYTES);
      const raw = splitPromptFile(await fsp.readFile(target, "utf8"));
      if (raw.frontMatter.name !== entry.name) {
        throw new Error(`front-matter name must match the directory name ("${entry.name}")`);
      }
      const validated = validateSkillFrontMatter(raw.frontMatter);
      if (!validated.ok) throw new Error(validated.message);
      const forbidden = layer === "project" ? validated.value.roles?.filter((r) => PROJECT_SKILL_FORBIDDEN_ROLES.has(r)) : [];
      if (forbidden?.length) {
        throw new Error(`a project skill may not target reviewer roles (${forbidden.join(", ")}): the code under review must not instruct its reviewers`);
      }
      if (!raw.body.trim()) throw new Error("the skill body is empty");
      out.push({ ...validated.value, body: raw.body, layer, file, tokens: estimateTokens(raw.body) });
    } catch (error) {
      errors.push({ file, layer, message: errorMessage(error) });
    }
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
