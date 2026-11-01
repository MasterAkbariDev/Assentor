import { promises as fsp } from "node:fs";
import path from "node:path";
import { userAssentorDir } from "../config/paths.js";
import { classifyRisk } from "../modes/danger.js";
import { splitPromptFile, type PromptLayer } from "../prompts/format.js";
import { checkFileStat, isInside } from "../prompts/library.js";
import { resolvePackageRoot } from "../self/package-root.js";
import {
  estimateTokens,
  PROJECT_SKILL_ROLES,
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
 * directory name, at most `MAX_SKILLS_PER_LAYER` per layer. A bad skill is
 * recorded in `errors` and skipped (a bad override leaves the lower-layer skill
 * in place). Other entries (plain files, dot-directories) are ignored.
 *
 * Project skills reach only built-in builder roles on edit seats
 * (`PROJECT_SKILL_ROLES`). Where a project skill is refused for a seat, the
 * user or built-in skill of the same name is offered instead.
 */

/** Largest SKILL.md read. A body this size is ~8k tokens: anything bigger is not a "pack". */
export const MAX_SKILL_FILE_BYTES = 32 * 1024;
/** Skill directories read per layer; the rest are reported and ignored. */
export const MAX_SKILLS_PER_LAYER = 200;
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

/** Who is asking: a seat's role and permissions, and the run's mode and profile. */
export interface SkillScope {
  role: string;
  permissions?: "read-only" | "edit";
  mode?: string;
  profile?: string;
  /** Opt-in skills the config turned on (presets already expanded). */
  enabled?: readonly string[];
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
    /** name → every loaded definition, lowest layer first. */
    private readonly versions: ReadonlyMap<string, readonly SkillDefinition[]>,
    readonly errors: readonly SkillLoadError[],
  ) {}

  /** Load every layer. Never throws for bad files; see `errors`. */
  static async load(options: SkillLibraryLoadOptions = {}): Promise<SkillLibrary> {
    const versions = new Map<string, SkillDefinition[]>();
    const errors: SkillLoadError[] = [];
    for (const { layer, dir } of skillLayerDirs(options)) {
      const within = layer === "project" ? path.resolve(options.projectPath!) : undefined;
      for (const loaded of await readLayer(layer, dir, within, errors)) {
        const lower = versions.get(loaded.name) ?? [];
        versions.set(loaded.name, [...lower, lower.length ? { ...loaded, overrides: lower.at(-1)!.layer } : loaded]);
      }
    }
    return new SkillLibrary(versions, errors);
  }

  /** An empty library (no skills: every prompt stays exactly as it was). */
  static empty(): SkillLibrary {
    return new SkillLibrary(new Map(), []);
  }

  /** The highest-layer definition of `name`. */
  get(name: string): SkillDefinition | undefined {
    return this.versions.get(name)?.at(-1);
  }

  /** Every skill (highest layer), sorted by name. */
  list(): SkillDefinition[] {
    return [...this.versions.keys()].sort().map((name) => this.get(name)!);
  }

  /** Why `scope` may not load this definition, or undefined when it may. */
  refusal(skill: SkillDefinition, scope: SkillScope): string | undefined {
    if (skill.layer === "project" && !(PROJECT_SKILL_ROLES.has(scope.role) && scope.permissions === "edit")) {
      return `project skills reach only built-in builder roles on edit seats (not "${scope.role}", ${scope.permissions ?? "no"} permission)`;
    }
    if (skill.optIn && !scope.enabled?.includes(skill.name)) return "off by default: add it to skills.enabled";
    if (skill.roles && !skill.roles.includes(scope.role)) return `not for role "${scope.role}"`;
    if (skill.modes && !(scope.mode && skill.modes.includes(scope.mode))) return `not for mode "${scope.mode ?? "(none)"}"`;
    if (skill.profiles && !(scope.profile && (skill.profiles as string[]).includes(scope.profile))) {
      return `not for profile "${scope.profile ?? "(none)"}"`;
    }
    return undefined;
  }

  /**
   * The definition of `name` that `scope` gets: the highest layer it may load
   * (a refused project skill falls back to the user or built-in one).
   */
  resolve(name: string, scope: SkillScope): { skill: SkillDefinition } | { refusal: string } {
    const versions = this.versions.get(name);
    if (!versions) return { refusal: "no such skill" };
    for (const skill of [...versions].reverse()) {
      if (this.refusal(skill, scope) === undefined) return { skill };
    }
    return { refusal: this.refusal(versions.at(-1)!, scope)! };
  }

  /** Definitions `scope` may load, sorted by name. */
  eligible(scope: SkillScope): SkillDefinition[] {
    return [...this.versions.keys()]
      .sort()
      .map((name) => this.resolve(name, scope))
      .flatMap((r) => ("skill" in r ? [r.skill] : []));
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

  const candidates = entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length > MAX_SKILLS_PER_LAYER) {
    errors.push({ file: dir, layer, message: `more than ${MAX_SKILLS_PER_LAYER} skills; only the first ${MAX_SKILLS_PER_LAYER} by name are read` });
  }
  for (const entry of candidates.slice(0, MAX_SKILLS_PER_LAYER)) {
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
      const forbidden = layer === "project" ? validated.value.roles?.filter((r) => !PROJECT_SKILL_ROLES.has(r)) : [];
      if (forbidden?.length) {
        throw new Error(`a project skill may target only built-in builder roles, not ${forbidden.join(", ")}: project files must not instruct reviewers, leads or custom roles`);
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
