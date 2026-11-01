import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  normalizeExecutorProvider,
  parseAssentorConfig,
  type AssentorConfig,
} from "./schema.js";
import { defaultTransportForProvider } from "../review/backends.js";
import { DEFAULT_OUTPUT_STYLE, type OutputStyle } from "../output/style.js";
import { explicitProfileKeys, type RunProfile } from "./profile.js";
import {
  AutonomySchema,
  blankToUndefined,
  runModeForAutonomy,
  type Autonomy,
} from "../core/run-mode.js";
import {
  assentorConfigPath,
  projectConfigPath,
  userConfigPath,
  userAssentorProjectRoot,
} from "./paths.js";

export {
  assentorConfigPath,
  projectConfigPath,
  userConfigPath,
  userAssentorDir,
  userAssentorProjectRoot,
  userSecretsPath,
  isUserDataRoot,
} from "./paths.js";

async function readYamlFile(filePath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseYaml(raw) ?? {};
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (
      err.code === "ENOENT" ||
      err.code === "EACCES" ||
      err.code === "EPERM" ||
      err.code === "ENOTDIR"
    ) {
      return {};
    }
    throw error;
  }
}

function withoutBlankAutonomy(run: unknown): unknown {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run;
  const record = run as Record<string, unknown>;
  if (!("autonomy" in record) || blankToUndefined(record.autonomy) !== undefined) return run;
  const { autonomy: _blank, ...rest } = record;
  return rest;
}

/**
 * Shallow-merge nested config objects. Arrays (reviewers) replace wholesale.
 */
export function mergeConfigLayers(
  ...layers: Array<Record<string, unknown>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, raw] of Object.entries(layer)) {
      // A blank `run.autonomy:` (null in YAML) is unset, so it inherits the lower layer's value.
      const value = key === "run" ? withoutBlankAutonomy(raw) : raw;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        out[key] &&
        typeof out[key] === "object" &&
        !Array.isArray(out[key])
      ) {
        out[key] = {
          ...(out[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else if (value !== undefined) {
        out[key] = value;
      }
    }
  }
  return out;
}

function runSection(layer: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  const run = layer?.run;
  return run && typeof run === "object" && !Array.isArray(run)
    ? (run as Record<string, unknown>)
    : undefined;
}

/**
 * `lower` without its `run.autonomy` when `upper` sets `run.mode` but no autonomy.
 * The layers merge key by key and the schema then lets autonomy beat mode, so
 * without this a user-file `autonomy: autopilot` would beat a project's pinned
 * `mode: supervised`. A layer's `mode` alone is its autonomy; the higher layer wins whole.
 */
function dropShadowedAutonomy(
  lower: Record<string, unknown>,
  upper: Record<string, unknown>,
): Record<string, unknown> {
  const upperRun = runSection(upper);
  const lowerRun = runSection(lower);
  if (
    !lowerRun ||
    !upperRun ||
    blankToUndefined(upperRun.mode) === undefined ||
    blankToUndefined(upperRun.autonomy) !== undefined
  ) {
    return lower;
  }
  const { autonomy: _shadowed, ...run } = lowerRun;
  return { ...lower, run };
}

/**
 * Load run defaults: built-in → ~/.assentor/config.yaml → project .assentor/config.yaml → CLI overrides.
 * Project files are optional overrides; you do not need one in every folder.
 */
export async function loadAssentorConfig(
  projectPath: string,
  overrides: Partial<{
    executor: string;
    reviewer: string;
    maxRounds: number;
    maxMessages: number;
    /** Deprecated: legacy `--mode supervised|autopilot`. `autonomy` wins when both are set. */
    mode: AssentorConfig["run"]["mode"];
    autonomy: Autonomy;
    /** `--style` / `--brief`: beats `output.style` from the config files. */
    style: OutputStyle;
    /** `--profile`: beats `run.profile` from the config files. */
    profile: RunProfile;
  }> = {},
): Promise<AssentorConfig> {
  const userRaw = (await readYamlFile(userConfigPath())) as Record<
    string,
    unknown
  >;
  const projectRoot = path.resolve(projectPath);
  const homeRoot = path.resolve(userAssentorProjectRoot());
  const projectRaw =
    projectRoot === homeRoot
      ? {}
      : ((await readYamlFile(projectConfigPath(projectRoot))) as Record<
          string,
          unknown
        >);

  const merged = mergeConfigLayers(dropShadowedAutonomy(userRaw, projectRaw), projectRaw);
  const parsed = parseAssentorConfig(merged);
  // Keys the user set, for run profiles (TE-06): in the files, or given as a flag below.
  const explicit = explicitProfileKeys(merged);

  if (overrides.executor) {
    parsed.executor.provider = normalizeExecutorProvider(
      overrides.executor,
    ) as AssentorConfig["executor"]["provider"];
  }
  // CLI beats config; the config's own autonomy-vs-mode precedence is applied by the schema.
  const cliAutonomy = overrides.autonomy ?? overrides.mode;
  if (cliAutonomy) {
    parsed.run.autonomy = cliAutonomy;
    parsed.run.mode = runModeForAutonomy(cliAutonomy);
  }
  if (overrides.reviewer) {
    const provider =
      overrides.reviewer as AssentorConfig["reviewers"][number]["provider"];
    parsed.reviewers = [
      {
        provider,
        role: "general",
        transport: defaultTransportForProvider(provider),
      },
    ];
  }
  if (overrides.style) {
    parsed.output.style = overrides.style;
    explicit.push("output.style");
  }
  if (overrides.profile) {
    parsed.run.profile = overrides.profile;
  }
  if (overrides.maxRounds) {
    parsed.limits.maxRounds = overrides.maxRounds;
    explicit.push("limits.maxRounds");
  }
  if (overrides.maxMessages) {
    parsed.limits.maxMessages = overrides.maxMessages;
  }

  // Only a run with a profile carries them: the config of a balanced run is exactly what it was.
  if (parsed.run.profile && parsed.run.profile !== "balanced") parsed.run.explicit = explicit;
  parsed.project.path = projectRoot;
  return parsed;
}

export type ConfigSaveScope = "user" | "project";

/** Top-level sections a caller can ask `saveAssentorConfig` to keep from the existing file. */
/**
 * "run.autonomy" writes `run.mode` from `config` but keeps the file's own autonomy
 * (see `keepOwnAutonomy`); the others keep the whole section from the file.
 */
export type PreservableConfigSection = "teams" | "modes" | "run" | "run.autonomy" | "output";

/**
 * Every schema section is written, in schema order, so a field added to the
 * schema is saved without touching this function. `undefined` optionals are
 * dropped by the YAML writer. `project.path` is always written as "." because
 * the loader sets it from the directory being loaded.
 */
function toSerializable(config: AssentorConfig): Record<string, unknown> {
  const { project: _project, ...sections } = config;
  const out: Record<string, unknown> = { project: { path: "." } };
  for (const [key, value] of Object.entries(sections)) {
    // `output` is written only when it differs from the default, so saving never adds a
    // `style: normal` block to a config that did not have one (TE-02).
    if (key === "output" && config.output.style === DEFAULT_OUTPUT_STYLE) continue;
    // Runtime-only fields of `run` (run profiles) are never saved.
    if (key === "run") {
      const { explicit: _explicit, narrowReview: _narrow, ...run } = config.run;
      out[key] = run;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * `run` with the file's own `autonomy` instead of the merged one, so a project's
 * autonomy is never copied into the user file. The file's value is kept only while it
 * still gives the `mode` being saved: a TUI toggle that changed the mode drops it.
 */
function keepOwnAutonomy(run: AssentorConfig["run"], own: unknown): Record<string, unknown> {
  const { autonomy: _merged, ...rest } = run;
  const parsed = AutonomySchema.safeParse(blankToUndefined(own));
  return parsed.success && runModeForAutonomy(parsed.data) === run.mode
    ? { ...rest, autonomy: parsed.data }
    : rest;
}

/**
 * Persist defaults. TUI saves to the user scope (`~/.assentor/config.yaml`) by default
 * so settings follow you across projects. Use scope "project" for per-repo overrides.
 *
 * `preserveFromExisting` keeps those sections exactly as they are in the file
 * being overwritten (omitting them if the file has none) instead of writing them
 * from `config`. The TUI uses this because it saves the merged user + project
 * config to user scope and has no editor for these sections: without it, a
 * project's teams would be copied into `~/.assentor/config.yaml`.
 */
export async function saveAssentorConfig(
  projectPath: string,
  config: AssentorConfig,
  options: {
    scope?: ConfigSaveScope;
    preserveFromExisting?: readonly PreservableConfigSection[];
  } = {},
): Promise<string> {
  const scope = options.scope ?? "user";
  const configPath =
    scope === "user" ? userConfigPath() : projectConfigPath(projectPath);

  const output = toSerializable(config);
  if (options.preserveFromExisting?.length) {
    const existing = (await readYamlFile(configPath)) as Record<string, unknown>;
    for (const section of options.preserveFromExisting) {
      if (section === "run.autonomy") {
        output.run = keepOwnAutonomy(config.run, runSection(existing)?.autonomy);
        continue;
      }
      if (existing && Object.prototype.hasOwnProperty.call(existing, section)) {
        output[section] = existing[section];
      } else {
        delete output[section];
      }
    }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // Temp file next to the real file + rename: a crash or a concurrent reader never sees a half-written
  // config. A symlinked config (e.g. into a dotfiles repo) is written through, and stays a symlink.
  const target = await fs.realpath(configPath).catch(() => configPath);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    const mode = await fs.stat(target).then((stat) => stat.mode & 0o777, () => undefined);
    await fs.writeFile(tmp, stringifyYaml(output, { lineWidth: 100 }), "utf8");
    if (mode !== undefined) await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  return configPath;
}

export { AssentorConfigSchema, parseAssentorConfig, type AssentorConfig } from "./schema.js";
