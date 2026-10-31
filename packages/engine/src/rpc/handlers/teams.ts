import path from "node:path";
import { RpcErrorCode } from "#assentor/protocol/rpc.js";
import { MODEL_ID_PATTERN, TeamSchema } from "#assentor/protocol/seats.js";
import { loadAssentorConfig, saveAssentorConfig, userAssentorDir, userAssentorProjectRoot } from "../../config/load.js";
import { PromptLibrary } from "../../prompts/index.js";
import { scrubMessage } from "../library.js";
import { RpcError, type RpcServer } from "../server.js";

/**
 * `team.save`, `team.delete`, `team.validate` (T04-04). Teams are saved in the
 * user config (`~/.assentor/config.yaml`) through `saveAssentorConfig`, from the
 * user file alone, so project-only values are never copied into it.
 * Project-scope team editing is not offered (no section-level config writer exists).
 */

export interface TeamMethodsOptions {
  projectPath: string;
}

/** `modes.*` paths whose `team`-like key (`team`, `reviewTeam`, `workerTeam`, …) names `team`. */
export function findTeamReferences(value: unknown, team: string, at = "modes"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findTeamReferences(item, team, `${at}[${index}]`));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    /team$/i.test(key) && child === team ? [`${at}.${key}`] : findTeamReferences(child, team, `${at}.${key}`),
  );
}

/** Config errors are a client-visible state, not an engine fault; paths are scrubbed. */
export async function configOrReject<T>(projectPath: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RpcError(
      RpcErrorCode.InvalidRequest,
      `Config problem: ${scrubMessage(message, [
        [projectPath, "<project>"],
        [userAssentorDir(), "<user>"],
      ])}`,
    );
  }
}

export function registerTeamMethods(server: RpcServer, options: TeamMethodsOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  const userConfig = () => configOrReject(projectPath, () => loadAssentorConfig(userAssentorProjectRoot()));

  // Sections other than `teams` stay exactly as they are in the file.
  const saveUser = (config: Awaited<ReturnType<typeof userConfig>>) =>
    saveAssentorConfig(projectPath, config, { scope: "user", preserveFromExisting: ["modes", "run"] });

  async function problemsOf(team: unknown): Promise<string[]> {
    const parsed = TeamSchema.safeParse(team);
    if (!parsed.success) {
      return parsed.error.issues.map((issue) => `${issue.path.join(".") || "team"}: ${issue.message}`);
    }
    const prompts = await PromptLibrary.load({ projectPath });
    const problems: string[] = [];
    parsed.data.seats.forEach((seat, index) => {
      // A model id is passed to a CLI as an argument; it must never look like a flag.
      if (!MODEL_ID_PATTERN.test(seat.model)) {
        problems.push(`seats.${index}.model: not a valid model id`);
      }
      if (seat.promptRef !== undefined && !prompts.has(seat.promptRef)) {
        problems.push(`seats.${index}.promptRef: unknown prompt "${seat.promptRef}"`);
      }
    });
    return problems;
  }

  return server.registerAll({
    "team.validate": async ({ team }) => {
      const problems = await problemsOf(team);
      return { ok: problems.length === 0, problems };
    },
    "team.save": async ({ name, team }) => {
      const problems = await problemsOf(team);
      if (problems.length > 0) {
        throw new RpcError(RpcErrorCode.InvalidParams, `Invalid team: ${problems.join("; ")}`);
      }
      const config = await userConfig();
      config.teams[name] = TeamSchema.parse(team);
      await saveUser(config);
      return { name };
    },
    "team.delete": async ({ name }) => {
      const config = await userConfig();
      if (!Object.hasOwn(config.teams, name)) {
        const effective = await configOrReject(projectPath, () => loadAssentorConfig(projectPath));
        throw new RpcError(
          RpcErrorCode.InvalidParams,
          Object.hasOwn(effective.teams, name)
            ? `Team ${name} is defined in the project config; only user-config teams can be deleted here`
            : `Unknown team ${name}`,
        );
      }
      // References are checked against the merged config: a project's modes may use a user team.
      const effective = await configOrReject(projectPath, () => loadAssentorConfig(projectPath));
      const references = findTeamReferences(effective.modes, name);
      if (references.length > 0) {
        throw new RpcError(
          RpcErrorCode.InvalidParams,
          `Team ${name} is still used by ${references.join(", ")}`,
          { references },
        );
      }
      delete config.teams[name];
      await saveUser(config);
      return { name };
    },
  });
}
