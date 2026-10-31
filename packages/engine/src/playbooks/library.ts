import { promises as fsp, type Dirent } from "node:fs";
import path from "node:path";
import { resolvePackageRoot } from "../self/package-root.js";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { userAssentorDir } from "../config/paths.js";
import {
  ModelIdSchema,
  SEAT_MAX_COUNT,
  SEAT_PERMISSIONS,
  SEAT_PROVIDERS,
  SeatRoleSchema,
  StageSpecSchema,
  type SessionSpec,
} from "#assentor/protocol/seats.js";
import { getStrategy, registerBuiltinStrategies } from "../negotiation/strategies/index.js";
import { validateSessionGraph } from "../orchestrator/session-runner.js";
import { PromptLibrary, type PromptLayer } from "../prompts/index.js";

/**
 * Playbook library (task T03-04).
 *
 * A playbook is a session graph (`SessionSpec` stages) plus team templates.
 * Templates use `provider: AUTO` where the user binds a real provider, and seat
 * roles are prompt ids. Layers, lowest first: built-in
 * (`<package>/playbooks/builtin`) → user (`~/.assentor/playbooks`) → project
 * (`<project>/.assentor/playbooks`). Same rules as the prompt library: only
 * `.yaml` files directly inside a layer dir, the file name is the id, a symlink
 * must resolve inside the dir, a size cap, and a bad file is recorded in
 * `errors` and skipped (so a bad override leaves the lower-layer playbook).
 */

/** Largest playbook file read, in bytes. */
export const MAX_PLAYBOOK_FILE_BYTES = 64 * 1024;

const PlaybookSeatSchema = z
  .object({
    /** `AUTO` leaves the provider to the user's config; a provider id pins it. */
    provider: z.union([z.literal("AUTO"), z.enum(SEAT_PROVIDERS)]).default("AUTO"),
    model: ModelIdSchema.default("AUTO"),
    /** Prompt id of the seat's role. */
    role: SeatRoleSchema,
    count: z.number().int().min(1).max(SEAT_MAX_COUNT).default(1),
    permissions: z.enum(SEAT_PERMISSIONS).default("read-only"),
  })
  .strict();

const PlaybookTeamSchema = z
  .object({
    description: z.string().trim().default(""),
    seats: z.array(PlaybookSeatSchema).min(1),
  })
  .strict();

export const PlaybookSchema = z
  .object({
    id: SeatRoleSchema,
    title: z.string().trim().min(1),
    description: z.string().trim().default(""),
    /** No execute stage and no edit seats. */
    readOnly: z.boolean().default(false),
    /** Team templates by name; stages refer to them by `team`. */
    teams: z.record(SeatRoleSchema, PlaybookTeamSchema).default({}),
    stages: z.array(StageSpecSchema.strict()).min(1),
  })
  .strict();

export type Playbook = z.infer<typeof PlaybookSchema>;

export interface PlaybookDefinition extends Playbook {
  layer: PromptLayer;
  /** Absolute path of the file that defined it. */
  file: string;
  /** Layer of the playbook with the same id that this one replaced, if any. */
  overrides?: PromptLayer;
}

export interface PlaybookLoadError {
  file: string;
  layer: PromptLayer;
  message: string;
}

export interface PlaybookLayerDir {
  layer: PromptLayer;
  dir: string;
}

export interface PlaybookLibraryLoadOptions {
  /** Adds the project layer `<projectPath>/.assentor/playbooks`. */
  projectPath?: string;
  /** Override the built-in directory (tests). */
  builtinDir?: string;
  /** Override the user directory (tests). Default `~/.assentor/playbooks`. */
  userDir?: string;
  /** Prompt library that seat roles are checked against. Default: loaded from `projectPath`. */
  prompts?: PromptLibrary;
}

/** Built-in playbooks shipped with the package. */
export function builtinPlaybookDir(): string {
  return path.join(resolvePackageRoot(), "playbooks", "builtin");
}

export function playbookLayerDirs(options: PlaybookLibraryLoadOptions = {}): PlaybookLayerDir[] {
  const dirs: PlaybookLayerDir[] = [
    { layer: "builtin", dir: options.builtinDir ?? builtinPlaybookDir() },
    { layer: "user", dir: options.userDir ?? path.join(userAssentorDir(), "playbooks") },
  ];
  if (options.projectPath) {
    dirs.push({
      layer: "project",
      dir: path.join(path.resolve(options.projectPath), ".assentor", "playbooks"),
    });
  }
  return dirs;
}

/** The session graph a playbook runs as, once the user gives a goal. */
export function sessionSpecFor(playbook: Playbook, goal: string): SessionSpec {
  return { title: playbook.title, goal, playbook: playbook.id, stages: playbook.stages };
}

/**
 * Every problem with a parsed playbook beyond its schema, or `[]` when it is
 * usable. `hasPrompt` says whether a prompt id exists. Calls the graph check
 * `validateSessionGraph` with the title as a placeholder goal.
 */
export function playbookProblems(playbook: Playbook, hasPrompt: (id: string) => boolean): string[] {
  registerBuiltinStrategies();
  const problems: string[] = [];
  const used = new Set<string>();

  for (const stage of playbook.stages) {
    const where = `stage "${stage.id}"`;
    if (stage.kind === "execute" && playbook.readOnly) {
      problems.push(`${where}: a read-only playbook cannot have an execute stage`);
    }
    if (stage.team !== undefined) {
      if (Object.hasOwn(playbook.teams, stage.team)) used.add(stage.team);
      else problems.push(`${where}: unknown team "${stage.team}"`);
    } else if (stage.kind !== "execute") {
      problems.push(`${where}: a ${stage.kind} stage needs a team`);
    }
    if (stage.kind === "plan" || stage.kind === "negotiate") {
      if (!stage.strategy) problems.push(`${where}: a ${stage.kind} stage needs a strategy`);
      else if (!getStrategy(stage.strategy)) problems.push(`${where}: unknown negotiation strategy "${stage.strategy}"`);
    }
    // Mirrors REVIEW_STRATEGIES in orchestrator/session-stages.ts.
    if (stage.kind === "review" && stage.strategy !== undefined && stage.strategy !== "panel") {
      problems.push(`${where}: a review stage's strategy must be "panel"`);
    }
  }

  for (const [name, team] of Object.entries(playbook.teams)) {
    if (!used.has(name)) problems.push(`team "${name}" is not used by any stage`);
    for (const seat of team.seats) {
      if (!hasPrompt(seat.role)) problems.push(`team "${name}": unknown prompt id "${seat.role}"`);
      if (playbook.readOnly && seat.permissions !== "read-only") {
        problems.push(`team "${name}": a read-only playbook cannot have an edit seat`);
      }
    }
  }

  problems.push(...validateSessionGraph(sessionSpecFor(playbook, playbook.title)));
  return problems;
}

export class PlaybookLibrary {
  private constructor(
    private readonly playbooks: ReadonlyMap<string, PlaybookDefinition>,
    /** One entry per file that could not be loaded. */
    readonly errors: readonly PlaybookLoadError[],
  ) {}

  /** Load every layer. Never throws for bad files; see `errors`. */
  static async load(options: PlaybookLibraryLoadOptions = {}): Promise<PlaybookLibrary> {
    const prompts = options.prompts ?? (await PromptLibrary.load({ projectPath: options.projectPath }));
    const effective = new Map<string, PlaybookDefinition>();
    const errors: PlaybookLoadError[] = [];

    for (const { layer, dir } of playbookLayerDirs(options)) {
      const files = await readLayer(layer, dir);
      errors.push(...files.errors);
      for (const { file, stem, text } of files.files) {
        try {
          const playbook = parsePlaybook(text);
          if (playbook.id !== stem) {
            throw new Error(`id must match the file name ("${stem}")`);
          }
          const problems = playbookProblems(playbook, (id) => prompts.has(id));
          if (problems.length > 0) {
            throw new Error(problems.join("; "));
          }
          const replaced = effective.get(playbook.id);
          effective.set(playbook.id, {
            ...playbook,
            layer,
            file,
            ...(replaced ? { overrides: replaced.layer } : {}),
          });
        } catch (error) {
          errors.push({ file, layer, message: errorMessage(error) });
        }
      }
    }
    return new PlaybookLibrary(effective, errors);
  }

  get(id: string): PlaybookDefinition | undefined {
    return this.playbooks.get(id);
  }

  has(id: string): boolean {
    return this.playbooks.has(id);
  }

  /** Playbooks sorted by id. */
  list(): PlaybookDefinition[] {
    return [...this.playbooks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

// ---------------------------------------------------------------------------
// Reading one layer directory
// ---------------------------------------------------------------------------

interface LayerFile {
  file: string;
  /** File name without `.yaml`; must equal the playbook id. */
  stem: string;
  text: string;
}

function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readLayer(
  layer: PromptLayer,
  dir: string,
): Promise<{ files: LayerFile[]; errors: PlaybookLoadError[] }> {
  const out: { files: LayerFile[]; errors: PlaybookLoadError[] } = { files: [], errors: [] };
  let base: string;
  let entries: Dirent[];
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
    if (!/\.ya?ml$/i.test(entry.name)) {
      continue;
    }
    const file = path.join(dir, entry.name);
    if (!entry.name.endsWith(".yaml")) {
      out.errors.push({ file, layer, message: "playbook files must end in lowercase .yaml" });
      continue;
    }
    try {
      let target = file;
      if (entry.isSymbolicLink()) {
        target = await fsp.realpath(file);
        if (!isInside(base, target)) {
          throw new Error("symlink points outside the playbook directory");
        }
      } else if (!entry.isFile()) {
        continue;
      }
      const stat = await fsp.stat(target);
      if (!stat.isFile()) {
        throw new Error("not a regular file");
      }
      if (stat.size > MAX_PLAYBOOK_FILE_BYTES) {
        throw new Error(`file is larger than ${MAX_PLAYBOOK_FILE_BYTES} bytes`);
      }
      out.files.push({ file, stem: entry.name.slice(0, -".yaml".length), text: await fsp.readFile(target, "utf8") });
    } catch (error) {
      out.errors.push({ file, layer, message: errorMessage(error) });
    }
  }
  return out;
}

function parsePlaybook(text: string): Playbook {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    throw new Error(`invalid YAML: ${errorMessage(error)}`);
  }
  const parsed = PlaybookSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "playbook"}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
