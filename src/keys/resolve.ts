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

/** Names used by the old env→vault seeder — pruned on load so they are not listed as user keys. */
export const AUTO_SEEDED_KEY_NAMES = [
  "Env Gemini",
  "Env OpenAI",
  "Env OpenRouter",
  "Env Qwen",
] as const;

/** Env vars currently set that can unlock a provider (not stored in the vault). */
export function listEnvKeyPresence(): Array<{
  provider: string;
  envName: string;
}> {
  const out: Array<{ provider: string; envName: string }> = [];
  for (const [provider, names] of Object.entries(ENV_KEYS)) {
    for (const envName of names) {
      if (process.env[envName]?.trim()) {
        out.push({ provider, envName });
        break;
      }
    }
  }
  return out;
}

export async function resolveProviderApiKey(
  provider: string,
  projectPath: string,
  options: { keyId?: string } = {},
): Promise<ResolvedApiKey | undefined> {
  if (options.keyId) {
    const byId = await revealVaultKeyById(options.keyId, projectPath);
    if (byId) {
      return byId;
    }
  }

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

/**
 * Resolve a provider API key: optional bound vault key, else env → user vault → project vault.
 */
export async function hasProviderApiKey(
  provider: string,
  projectPath: string,
): Promise<boolean> {
  return Boolean(await resolveProviderApiKey(provider, projectPath));
}

async function revealVaultKeyById(
  keyId: string,
  projectPath: string,
): Promise<ResolvedApiKey | undefined> {
  const projectRoot = path.resolve(projectPath);
  const homeRoot = path.resolve(userAssentorProjectRoot());
  for (const [root, source] of [
    [homeRoot, "user-vault"],
    [projectRoot, "project-vault"],
  ] as const) {
    try {
      const vault = new KeyVault(root);
      await vault.load();
      const stored = vault.get(keyId);
      if (!stored) {
        continue;
      }
      const ref = await vault.reveal(keyId);
      return {
        secret: ref.secret,
        source,
        name: stored.name,
        masked: stored.masked,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function revealFromVault(
  provider: string,
  root: string,
): Promise<{ secret: string; name: string; masked: string } | undefined> {
  try {
    const vault = new KeyVault(root);
    await vault.load();
    const selected = vault.selectKey(provider);
    if (!selected) {
      return undefined;
    }
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
