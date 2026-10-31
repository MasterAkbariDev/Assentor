import type { CliModelCatalog } from "../../models/cli-catalog.js";
import type { KeyVault } from "../../keys/index.js";
import type { RpcServer } from "../server.js";
import { registerEnvMethods, type EnvMethodsOptions } from "./env.js";
import { registerPlaybookMethods } from "./playbooks.js";
import { registerPromptMethods } from "./prompts.js";
import { registerSettingsMethods } from "./settings.js";
import { registerTeamMethods } from "./teams.js";

export interface HandlerMethodsOptions extends Omit<EnvMethodsOptions, "createCatalog"> {
  createCatalog?: () => CliModelCatalog;
  createVault?: () => KeyVault;
}

/** Registers the prompt, team, playbook, settings and env methods (T04-04). */
export function registerHandlerMethods(server: RpcServer, options: HandlerMethodsOptions): RpcServer {
  registerPromptMethods(server, options);
  registerTeamMethods(server, options);
  registerPlaybookMethods(server, options);
  registerSettingsMethods(server, options);
  registerEnvMethods(server, options);
  return server;
}
