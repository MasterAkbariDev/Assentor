import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseAssentorConfig, type AssentorConfig } from "./schema.js";
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
    if (err.code === "ENOENT") {
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
    parsed.executor.provider =
      overrides.executor as AssentorConfig["executor"]["provider"];
  }
  if (overrides.reviewer) {
    parsed.reviewers = [
      {
        provider:
          overrides.reviewer as AssentorConfig["reviewers"][number]["provider"],
        role: "general",
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

function toSerializable(config: AssentorConfig) {
  return {
    project: { path: "." },
    executor: { provider: config.executor.provider },
    reviewers: config.reviewers.map((r) => ({
      provider: r.provider,
      role: r.role,
      ...(r.name ? { name: r.name } : {}),
    })),
    routing: {
      strategy: config.routing.strategy,
      reviewStrategy: config.routing.reviewStrategy,
    },
    models: {
      default: config.models.default,
      gemini: config.models.gemini,
      openai: config.models.openai,
    },
    limits: {
      maxRounds: config.limits.maxRounds,
      maxMessages: config.limits.maxMessages,
      maxRuntimeMinutes: config.limits.maxRuntimeMinutes,
      maxToolCalls: config.limits.maxToolCalls,
    },
    git: config.git,
    security: config.security,
    artifacts: config.artifacts,
  };
}

/**
 * Persist defaults. TUI saves to the user scope (`~/.assentor/config.yaml`) by default
 * so settings follow you across projects. Use scope "project" for per-repo overrides.
 */
export async function saveAssentorConfig(
  projectPath: string,
  config: AssentorConfig,
  options: { scope?: ConfigSaveScope } = {},
): Promise<string> {
  const scope = options.scope ?? "user";
  const configPath =
    scope === "user" ? userConfigPath() : projectConfigPath(projectPath);

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    stringifyYaml(toSerializable(config), { lineWidth: 100 }),
    "utf8",
  );
  return configPath;
}

export { AssentorConfigSchema, parseAssentorConfig, type AssentorConfig } from "./schema.js";
