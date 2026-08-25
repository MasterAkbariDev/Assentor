import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseAssentorConfig, type AssentorConfig } from "./schema.js";

export function assentorConfigPath(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".assentor", "config.yaml");
}

export async function loadAssentorConfig(
  projectPath: string,
  overrides: Partial<{
    executor: string;
    reviewer: string;
    maxRounds: number;
    maxMessages: number;
  }> = {},
): Promise<AssentorConfig> {
  const configPath = assentorConfigPath(projectPath);
  let fileConfig: unknown = {};

  try {
    const raw = await fs.readFile(configPath, "utf8");
    fileConfig = parseYaml(raw);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }

  const parsed = parseAssentorConfig(fileConfig);

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

  parsed.project.path = path.resolve(projectPath);
  return parsed;
}

/**
 * Persist run defaults used by `assentor run` (and the TUI Settings screen).
 */
export async function saveAssentorConfig(
  projectPath: string,
  config: AssentorConfig,
): Promise<string> {
  const configPath = assentorConfigPath(projectPath);
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  const serializable = {
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

  await fs.writeFile(
    configPath,
    stringifyYaml(serializable, { lineWidth: 100 }),
    "utf8",
  );
  return configPath;
}

export { AssentorConfigSchema, parseAssentorConfig, type AssentorConfig } from "./schema.js";
