import path from "node:path";
import { RpcErrorCode, type RpcResult } from "#assentor/protocol/rpc.js";
import {
  loadAssentorConfig,
  parseAssentorConfig,
  saveAssentorConfig,
  userAssentorProjectRoot,
  type AssentorConfig,
} from "../../config/load.js";
import { KeyVault } from "../../keys/index.js";
import { runModeForAutonomy } from "../../core/run-mode.js";
import { RpcError, type RpcServer } from "../server.js";
import { configOrReject, withConfigLock } from "./teams.js";

/**
 * `settings.get`, `settings.save` (T04-04). Only plain settings cross the wire.
 * Left out on purpose: reviewers (carry `keyId`), `binaries` and
 * `verification.commands` (a value there is later run as a program or shell
 * command), `security.*`, teams and modes. API keys appear only as
 * `{ id, provider, name, healthy }`: no value, mask or ciphertext.
 */

export interface SettingsMethodsOptions {
  projectPath: string;
  /** Overrides how stored keys are listed (tests). Default: a side-effect-free read of the user vault. */
  readKeys?: () => ReturnType<typeof KeyVault.readSummaries>;
}

const publicSettings = (config: AssentorConfig): RpcResult<"settings.get">["settings"] => ({
  executor: { provider: config.executor.provider, ...(config.executor.model ? { model: config.executor.model } : {}) },
  run: { autonomy: config.run.autonomy ?? (config.run.mode === "autopilot" ? "autopilot" : "supervised") },
  routing: config.routing,
  limits: {
    maxRounds: config.limits.maxRounds,
    maxMessages: config.limits.maxMessages,
    maxRuntimeMinutes: config.limits.maxRuntimeMinutes,
    maxToolCalls: config.limits.maxToolCalls,
  },
  git: config.git,
  artifacts: config.artifacts,
});

export function registerSettingsMethods(server: RpcServer, options: SettingsMethodsOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  const readKeys = options.readKeys ?? (() => KeyVault.readSummaries(userAssentorProjectRoot()));

  return server.registerAll({
    "settings.get": async () => {
      const config = await configOrReject(projectPath, () => loadAssentorConfig(projectPath));
      // Read-only: `KeyVault.load` could create the master key or rewrite the vault file.
      return { settings: publicSettings(config), keys: await readKeys() };
    },
    "settings.save": ({ settings: patch }) =>
      withConfigLock(async () => {
        // Patch the user file's own config (not the merged one) so project values are never copied into it.
        const config = await configOrReject(projectPath, () => loadAssentorConfig(userAssentorProjectRoot()));
        const next: Record<string, unknown> = { ...config };
        for (const [section, values] of Object.entries(patch)) {
          if (section !== "run") {
            next[section] = { ...(config[section as keyof AssentorConfig] as object), ...values };
          }
        }
        if (patch.run) {
          next.run = { mode: runModeForAutonomy(patch.run.autonomy), autonomy: patch.run.autonomy };
        }
        let valid: AssentorConfig;
        try {
          valid = parseAssentorConfig(next);
        } catch (error) {
          throw new RpcError(RpcErrorCode.InvalidParams, `Invalid settings: ${error instanceof Error ? error.message : String(error)}`);
        }
        await saveAssentorConfig(projectPath, valid, { scope: "user", preserveFromExisting: ["teams", "modes", "output"] });
        // Return what settings.get now returns (user + project), not just the user file.
        return { settings: publicSettings(await configOrReject(projectPath, () => loadAssentorConfig(projectPath))) };
      }),
  });
}
