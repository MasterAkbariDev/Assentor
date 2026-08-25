import path from "node:path";
import { KeyVault } from "./vault.js";
import {
  userAssentorProjectRoot,
  userSecretsPath,
} from "../config/paths.js";

export { userAssentorProjectRoot, userSecretsPath };

const ENV_KEYS: Record<string, string[]> = {
  gemini: ["ASSENTOR_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["ASSENTOR_OPENAI_API_KEY", "OPENAI_API_KEY"],
  openrouter: ["ASSENTOR_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
  qwen: ["ASSENTOR_QWEN_API_KEY", "DASHSCOPE_API_KEY"],
};

export interface ResolvedApiKey {
  secret: string;
  /** env | user-vault | project-vault */
  source: "env" | "user-vault" | "project-vault";
  name: string;
  masked?: string;
}

/**
 * Resolve a provider API key: process env → user vault (~/.assentor) → project vault.
 * User vault wins over per-project leftovers so one key works everywhere.
 */
export async function resolveProviderApiKey(
  provider: string,
  projectPath: string,
): Promise<ResolvedApiKey | undefined> {
  const envNames = ENV_KEYS[provider];
  if (envNames) {
    for (const name of envNames) {
      const value = process.env[name];
      if (value && value.trim()) {
        return { secret: value.trim(), source: "env", name: "environment" };
      }
    }
  }

  const projectRoot = path.resolve(projectPath);
  const homeRoot = path.resolve(userAssentorProjectRoot());

  const fromUser = await revealFromVault(provider, homeRoot);
  if (fromUser) {
    return {
      ...fromUser,
      source: "user-vault",
    };
  }

  if (homeRoot !== projectRoot) {
    const fromProject = await revealFromVault(provider, projectRoot);
    if (fromProject) {
      return {
        ...fromProject,
        source: "project-vault",
      };
    }
  }

  return undefined;
}

export async function hasProviderApiKey(
  provider: string,
  projectPath: string,
): Promise<boolean> {
  return Boolean(await resolveProviderApiKey(provider, projectPath));
}

async function revealFromVault(
  provider: string,
  root: string,
): Promise<{ secret: string; name: string; masked: string } | undefined> {
  const vault = new KeyVault(root);
  await vault.load();
  const selected = vault.selectKey(provider);
  if (!selected) {
    return undefined;
  }
  try {
    const ref = await vault.reveal(selected.id);
    return {
      secret: ref.secret,
      name: selected.name,
      masked: selected.masked,
    };
  } catch {
    return undefined;
  }
}
