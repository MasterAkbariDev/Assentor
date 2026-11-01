import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { resolvePackageRoot } from "../self/package-root.js";
import { userAssentorDir } from "../config/paths.js";
import {
  splitPromptFile,
  validateFrontMatter,
  type PromptDefinition,
  type PromptFrontMatter,
  type PromptLayer,
  type RawPromptFile,
} from "./format.js";
import { renderPrompt, templateVariables, type TemplateVariables } from "./template.js";

/**
 * Layered prompt library (task T03-01).
 *
 * Layers, lowest first: built-in (`<package>/prompts/builtin`) → user
 * (`~/.assentor/prompts`) → project (`<project>/.assentor/prompts`). A prompt
 * in a higher layer replaces the one with the same id. `extends: <id>`
 * inherits the parent's front-matter (the child's keys win; a child's
 * `variables` list replaces the parent's) and appends the child's body to the
 * parent's. A prompt may extend its own id to build on the version from the
 * layers below.
 *
 * Only `.md` files directly inside a layer directory are read; a symlink must
 * resolve to a file inside that directory. Each bad file is recorded in
 * `errors` (against that file) and skipped; a bad override leaves the
 * lower-layer prompt in place. Layer directories hold prompt files only — a
 * README or other `.md` there is loaded as a prompt.
 */

/** Largest prompt file read, in bytes. */
export const MAX_PROMPT_FILE_BYTES = 256 * 1024;

export interface PromptLoadError {
  file: string;
  layer: PromptLayer;
  message: string;
}

export interface PromptLayerDir {
  layer: PromptLayer;
  dir: string;
}

export interface PromptLibraryLoadOptions {
  /** Adds the project layer `<projectPath>/.assentor/prompts`. */
  projectPath?: string;
  /** Override the built-in directory (tests). */
  builtinDir?: string;
  /** Override the user prompt directory (tests). Default `~/.assentor/prompts`. */
  userDir?: string;
}

/** Built-in prompts shipped with the package. */
export function builtinPromptDir(): string {
  return path.join(resolvePackageRoot(), "prompts", "builtin");
}

export function promptLayerDirs(options: PromptLibraryLoadOptions = {}): PromptLayerDir[] {
  const dirs: PromptLayerDir[] = [
    { layer: "builtin", dir: options.builtinDir ?? builtinPromptDir() },
    { layer: "user", dir: options.userDir ?? path.join(userAssentorDir(), "prompts") },
  ];
  if (options.projectPath) {
    dirs.push({
      layer: "project",
      dir: path.join(path.resolve(options.projectPath), ".assentor", "prompts"),
    });
  }
  return dirs;
}

export class PromptLibrary {
  private constructor(
    private readonly prompts: ReadonlyMap<string, PromptDefinition>,
    private readonly history: ReadonlyMap<string, readonly PromptDefinition[]>,
    /** One entry per file that could not be loaded. */
    readonly errors: readonly PromptLoadError[],
  ) {}

  /** Load every layer. Never throws for bad files; see `errors`. */
  static async load(options: PromptLibraryLoadOptions = {}): Promise<PromptLibrary> {
    const layers: LayerFiles[] = [];
    for (const { layer, dir } of promptLayerDirs(options)) {
      layers.push(await readLayer(layer, dir));
    }
    return PromptLibrary.fromLayers(layers);
  }

  /** Load only the built-in layer, synchronously (for module-level defaults). */
  static loadBuiltinSync(builtinDir: string = builtinPromptDir()): PromptLibrary {
    return PromptLibrary.fromLayers([readLayerSync("builtin", builtinDir)]);
  }

  private static fromLayers(layers: LayerFiles[]): PromptLibrary {
    const errors: PromptLoadError[] = [];
    const effective = new Map<string, PromptDefinition>();
    const history = new Map<string, PromptDefinition[]>();
    for (const files of layers) {
      errors.push(...files.errors);
      resolveLayer(files, effective, history, errors);
    }
    return new PromptLibrary(effective, history, errors);
  }

  get(id: string): PromptDefinition | undefined {
    return this.prompts.get(id);
  }

  has(id: string): boolean {
    return this.prompts.has(id);
  }

  /**
   * Every loaded definition of `id`, lowest layer first; the last one is what
   * `get` returns. For "overridden?" columns and diffs against the built-in.
   */
  versions(id: string): readonly PromptDefinition[] {
    return this.history.get(id) ?? [];
  }

  /** Prompts sorted by id, optionally only one role. */
  list(role?: PromptFrontMatter["role"]): PromptDefinition[] {
    return [...this.prompts.values()]
      .filter((prompt) => !role || prompt.role === role)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Render a prompt's body. Throws for an unknown id or missing variables. */
  render(id: string, variables: TemplateVariables = {}): string {
    const prompt = this.prompts.get(id);
    if (!prompt) {
      throw new Error(`Unknown prompt "${id}"`);
    }
    return renderPrompt(prompt.body, variables);
  }
}

// ---------------------------------------------------------------------------
// Reading one layer directory
// ---------------------------------------------------------------------------

interface LayerFile {
  file: string;
  /** File name without `.md`; must equal the front-matter id. */
  stem: string;
  raw: RawPromptFile;
}

interface LayerFiles {
  layer: PromptLayer;
  files: LayerFile[];
  errors: PromptLoadError[];
}

/** True when `target` lies strictly inside `base` (both resolved). Shared with the skill loader. */
export function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readLayer(layer: PromptLayer, dir: string): Promise<LayerFiles> {
  const out: LayerFiles = { layer, files: [], errors: [] };
  let base: string;
  let entries: fs.Dirent[];
  try {
    base = await fsp.realpath(dir);
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      out.errors.push({ file: dir, layer, message: errorMessage(error) });
    }
    return out;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const file = path.join(dir, entry.name);
    if (!entry.name.endsWith(".md")) {
      out.errors.push({ file, layer, message: "prompt files must end in lowercase .md" });
      continue;
    }
    try {
      let target = file;
      if (entry.isSymbolicLink()) {
        target = await fsp.realpath(file);
        if (!isInside(base, target)) {
          throw new Error("symlink points outside the prompt directory");
        }
      } else if (!entry.isFile()) {
        continue;
      }
      const stat = await fsp.stat(target);
      checkFileStat(stat);
      const raw = splitPromptFile(await fsp.readFile(target, "utf8"));
      out.files.push({ file, stem: entry.name.slice(0, -3), raw });
    } catch (error) {
      out.errors.push({ file, layer, message: errorMessage(error) });
    }
  }
  return out;
}

function readLayerSync(layer: PromptLayer, dir: string): LayerFiles {
  const out: LayerFiles = { layer, files: [], errors: [] };
  let base: string;
  let entries: fs.Dirent[];
  try {
    base = fs.realpathSync(dir);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      out.errors.push({ file: dir, layer, message: errorMessage(error) });
    }
    return out;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const file = path.join(dir, entry.name);
    if (!entry.name.endsWith(".md")) {
      out.errors.push({ file, layer, message: "prompt files must end in lowercase .md" });
      continue;
    }
    try {
      let target = file;
      if (entry.isSymbolicLink()) {
        target = fs.realpathSync(file);
        if (!isInside(base, target)) {
          throw new Error("symlink points outside the prompt directory");
        }
      } else if (!entry.isFile()) {
        continue;
      }
      checkFileStat(fs.statSync(target));
      const raw = splitPromptFile(fs.readFileSync(target, "utf8"));
      out.files.push({ file, stem: entry.name.slice(0, -3), raw });
    } catch (error) {
      out.errors.push({ file, layer, message: errorMessage(error) });
    }
  }
  return out;
}

/** A regular file no larger than `maxBytes`, else throws. Shared with the skill loader. */
export function checkFileStat(stat: fs.Stats, maxBytes: number = MAX_PROMPT_FILE_BYTES): void {
  if (!stat.isFile()) {
    throw new Error("not a regular file");
  }
  if (stat.size > maxBytes) {
    throw new Error(`file is larger than ${maxBytes} bytes`);
  }
}

// ---------------------------------------------------------------------------
// Resolving a layer on top of the lower layers
// ---------------------------------------------------------------------------

function resolveLayer(
  files: LayerFiles,
  effective: Map<string, PromptDefinition>,
  history: Map<string, PromptDefinition[]>,
  errors: PromptLoadError[],
): void {
  const byId = new Map<string, LayerFile>();
  for (const entry of files.files) {
    const id = entry.raw.frontMatter.id;
    if (typeof id !== "string" || id !== entry.stem) {
      errors.push({
        file: entry.file,
        layer: files.layer,
        message: `front-matter id must match the file name ("${entry.stem}")`,
      });
      continue;
    }
    byId.set(id, entry);
  }

  const lower = new Map(effective);
  const resolved = new Map<string, PromptDefinition>();
  const failed = new Set<string>();

  // Each failure is reported once, against the file that has the problem.
  const fail = (id: string, message: string) => {
    if (failed.has(id)) {
      return;
    }
    failed.add(id);
    errors.push({ file: byId.get(id)!.file, layer: files.layer, message });
  };

  const resolve = (id: string, chain: string[]): PromptDefinition | undefined => {
    const done = resolved.get(id);
    if (done || failed.has(id)) {
      return done;
    }
    const cycleStart = chain.indexOf(id);
    if (cycleStart >= 0) {
      const members = chain.slice(cycleStart);
      const message = `extends cycle: ${[...members, id].join(" → ")}`;
      for (const member of members) {
        fail(member, message);
      }
      return undefined;
    }

    const entry = byId.get(id)!;
    const { frontMatter, body } = entry.raw;
    const parentId = frontMatter.extends;
    try {
      let data = frontMatter;
      let fullBody = body;
      if (parentId !== undefined) {
        if (typeof parentId !== "string") {
          throw new Error("extends must be a prompt id");
        }
        const sameLayer = parentId !== id && byId.has(parentId);
        const parent = sameLayer ? resolve(parentId, [...chain, id]) : lower.get(parentId);
        if (!parent) {
          if (failed.has(id)) {
            return undefined; // part of a cycle, already reported
          }
          throw new Error(
            sameLayer
              ? `extends "${parentId}", which failed to load`
              : `extends unknown prompt "${parentId}"`,
          );
        }
        const {
          body: parentBody,
          layer: _layer,
          file: _file,
          overrides: _overrides,
          ...parentFrontMatter
        } = parent;
        data = { ...parentFrontMatter, ...frontMatter };
        fullBody = parentBody && body ? `${parentBody}\n\n${body}` : parentBody || body;
      }

      const validated = validateFrontMatter(data);
      if (!validated.ok) {
        throw new Error(validated.message);
      }
      // Reject template syntax errors at load time, not at first render.
      templateVariables(fullBody);

      const replaced = lower.get(id);
      const definition: PromptDefinition = {
        ...validated.value,
        body: fullBody,
        layer: files.layer,
        file: entry.file,
        ...(replaced ? { overrides: replaced.layer } : {}),
      };
      resolved.set(id, definition);
      return definition;
    } catch (error) {
      fail(id, errorMessage(error));
      return undefined;
    }
  };

  for (const id of byId.keys()) {
    resolve(id, []);
  }
  for (const [id, definition] of resolved) {
    effective.set(id, definition);
    history.set(id, [...(history.get(id) ?? []), definition]);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
