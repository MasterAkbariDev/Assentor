import { AgentRegistry } from "../agents/index.js";
import { buildExecutorRegistry } from "../executors/index.js";
import { KeyVault } from "../keys/index.js";
import { createSeededModelRegistry } from "../models/index.js";
import {
  createDefaultProviderRegistry,
  type AIProvider,
} from "../providers/ai/index.js";
import { RoutingEngine } from "../routing/index.js";
import { AuditLog } from "./audit.js";

export interface AssentorServices {
  projectPath: string;
  providers: Map<string, AIProvider>;
  models: ReturnType<typeof createSeededModelRegistry>;
  vault: KeyVault;
  agents: AgentRegistry;
  executors: ReturnType<typeof buildExecutorRegistry>;
  routing: RoutingEngine;
  audit: AuditLog;
}

export async function createAssentorServices(
  projectPath: string,
): Promise<AssentorServices> {
  const providers = createDefaultProviderRegistry();
  const models = createSeededModelRegistry({ providers });
  const vault = new KeyVault(projectPath);
  await vault.load();
  // Import env keys once if vault empty
  await seedEnvKeys(vault);

  const agents = new AgentRegistry(projectPath);
  await agents.load();

  const executors = buildExecutorRegistry();
  const audit = new AuditLog(projectPath);
  const routing = new RoutingEngine({
    providers,
    models,
    vault,
    onDecision: (decision) => {
      void audit.append("routing.decision", `Routed ${decision.agentId}`, {
        ...decision,
      });
    },
  });

  return {
    projectPath,
    providers,
    models,
    vault,
    agents,
    executors,
    routing,
    audit,
  };
}

async function seedEnvKeys(vault: KeyVault): Promise<void> {
  if (vault.list().length > 0) {
    return;
  }
  const seeds: Array<{ provider: string; name: string; secret?: string }> = [
    {
      provider: "gemini",
      name: "Env Gemini",
      secret:
        process.env.ASSENTOR_GEMINI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY,
    },
    {
      provider: "openai",
      name: "Env OpenAI",
      secret: process.env.ASSENTOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    },
    {
      provider: "openrouter",
      name: "Env OpenRouter",
      secret: process.env.OPENROUTER_API_KEY || process.env.ASSENTOR_OPENROUTER_API_KEY,
    },
    {
      provider: "qwen",
      name: "Env Qwen",
      secret: process.env.DASHSCOPE_API_KEY || process.env.ASSENTOR_QWEN_API_KEY,
    },
  ];
  for (const seed of seeds) {
    if (seed.secret) {
      await vault.add({
        provider: seed.provider,
        name: seed.name,
        secret: seed.secret,
      });
    }
  }
}

export interface DiagnosticItem {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runFullDiagnostics(
  services: AssentorServices,
): Promise<DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];

  for (const provider of services.providers.values()) {
    const keys = services.vault.list(provider.id).filter((k) => k.enabled);
    if (keys.length === 0) {
      items.push({
        name: `provider:${provider.id}`,
        ok: false,
        detail: "No API keys configured",
      });
      continue;
    }
    items.push({
      name: `provider:${provider.id}`,
      ok: true,
      detail: `${keys.length} key(s), ${keys.filter((k) => k.health === "healthy").length} healthy`,
    });
  }

  for (const key of services.vault.list()) {
    const provider = services.providers.get(key.provider);
    if (!provider) {
      items.push({
        name: `key:${key.name}`,
        ok: false,
        detail: "Unknown provider",
      });
      continue;
    }
    const { status } = await services.vault.checkKey(key.id, provider);
    items.push({
      name: `key:${key.name}`,
      ok: status.valid,
      detail: status.message,
    });
    await services.audit.append(
      "key.checked",
      `${key.name}: ${status.message}`,
      { keyId: key.id, valid: status.valid },
    );
  }

  const detections = await services.executors.detectAll();
  for (const det of detections) {
    items.push({
      name: `executor:${det.id}`,
      ok: det.detection.installed,
      detail: det.detection.installed
        ? `Installed at ${det.detection.path ?? "?"}`
        : det.detection.error ?? "Not installed",
    });
  }

  return items;
}
