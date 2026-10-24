import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  normalizeExecutorProvider,
  parseAssentorConfig,
  type AssentorConfig,
} from "./schema.js";
import { defaultTransportForProvider } from "../review/backends.js";
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

/**
 * Shallow-merge nested config objects. Arrays (reviewers) replace wholesale.
 */
export function mergeConfigLayers(
  ...layers: Array<Record<string, unknown>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
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
    mode: AssentorConfig["run"]["mode"];
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

  const merged = mergeConfigLayers(userRaw, projectRaw);
  const parsed = parseAssentorConfig(merged);

  if (overrides.executor) {
    parsed.executor.provider = normalizeExecutorProvider(
      overrides.executor,
    ) as AssentorConfig["executor"]["provider"];
  }
  if (overrides.mode) {
    parsed.run.mode = overrides.mode;
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
  if (overrides.maxRounds) {
    parsed.limits.maxRounds = overrides.maxRounds;
  }
  if (overrides.maxMessages) {
    parsed.limits.maxMessages = overrides.maxMessages;
  }

  parsed.project.path = projectRoot;
  return parsed;
}

export type ConfigSaveScope = "user" | "project";

/** Top-level sections a caller can ask `saveAssentorConfig` to keep from the existing file. */
export type PreservableConfigSection = "teams" | "modes";

/**
 * Every schema section is written, in schema order, so a field added to the
 * schema is saved without touching this function. `undefined` optionals are
 * dropped by the YAML writer. `project.path` is always written as "." because
 * the loader sets it from the directory being loaded.
 */
function toSerializable(config: AssentorConfig): Record<string, unknown> {
  const { project: _project, ...sections } = config;
  return { project: { path: "." }, ...sections };
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
      if (existing && Object.prototype.hasOwnProperty.call(existing, section)) {
        output[section] = existing[section];
      } else {
        delete output[section];
      }
    }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    stringifyYaml(output, { lineWidth: 100 }),
    "utf8",
  );
  return configPath;
}

export { AssentorConfigSchema, parseAssentorConfig, type AssentorConfig } from "./schema.js";
