import {
  createDefaultProviderRegistry,
  ensureProvidersRegistered,
  getProvider,
  listProviders,
  type AIProvider,
  type ModelInfo,
} from "../providers/ai/index.js";

export type RoutingPreference = "FREE_FIRST" | "CHEAPEST" | "BALANCED" | "BEST" | "CUSTOM";

export interface ModelRegistryOptions {
  providers?: Map<string, AIProvider>;
}

/**
 * Capability-aware model catalog with AUTO selection.
 */
export class ModelRegistry {
  private models = new Map<string, ModelInfo>();
  private readonly providers: Map<string, AIProvider>;

  constructor(options: ModelRegistryOptions = {}) {
    this.providers =
      options.providers ?? createDefaultProviderRegistry();
    this.seedFromProviders();
  }

  private seedFromProviders(): void {
    for (const provider of this.providers.values()) {
      // Seeds are loaded lazily via refresh or getModels
      void provider;
    }
  }

  upsert(model: ModelInfo): void {
    this.models.set(modelKey(model.provider, model.id), model);
  }

  get(provider: string, modelId: string): ModelInfo | undefined {
    return this.models.get(modelKey(provider, modelId));
  }

  list(provider?: string): ModelInfo[] {
    const all = [...this.models.values()];
    return provider ? all.filter((m) => m.provider === provider) : all;
  }

  async refresh(
    providerId: string,
    key: { id: string; provider: string; name: string; secret: string },
  ): Promise<ModelInfo[]> {
    const provider = this.providers.get(providerId) ?? getProvider(providerId);
    if (!provider) {
      return [];
    }
    const models = await provider.listModels(key);
    for (const model of models) {
      this.upsert({
        ...model,
        lastChecked: new Date().toISOString(),
      });
    }
    return models;
  }

  /**
   * AUTO: strongest appropriate available model for the preference.
   */
  resolveAuto(
    preference: RoutingPreference = "BALANCED",
    options: {
      providerIds?: string[];
      requireStructuredOutput?: boolean;
      requireTools?: boolean;
    } = {},
  ): ModelInfo | undefined {
    let candidates = this.list().filter((m) => m.available);
    if (options.providerIds?.length) {
      candidates = candidates.filter((m) =>
        options.providerIds!.includes(m.provider),
      );
    }
    if (options.requireStructuredOutput) {
      candidates = candidates.filter((m) => m.structuredOutput);
    }
    if (options.requireTools) {
      candidates = candidates.filter((m) => m.tools);
    }
    if (candidates.length === 0) {
      // Fall back to seeded catalogs without refresh
      ensureProvidersRegistered();
      for (const provider of listProviders()) {
        // Use static seeds by attempting empty listModels isn't right —
        // pull from provider constructors via a sync seed helper
        void provider;
      }
      candidates = defaultSeeds().filter((m) => {
        if (options.providerIds?.length) {
          return options.providerIds.includes(m.provider);
        }
        return true;
      });
    }

    const scored = candidates
      .map((model) => ({
        model,
        score: scoreModel(model, preference),
      }))
      .sort((a, b) => b.score - a.score);

    return scored[0]?.model;
  }
}

function scoreModel(model: ModelInfo, preference: RoutingPreference): number {
  const quality = model.reasoningScore * 0.45 + model.codingScore * 0.55;
  switch (preference) {
    case "FREE_FIRST":
      return (
        (model.freeTier === "YES" ? 2 : model.freeTier === "UNKNOWN" ? 0.5 : 0) +
        quality +
        (1 - model.cost)
      );
    case "CHEAPEST":
      return (1 - model.cost) * 2 + quality * 0.3;
    case "BEST":
      return quality * 2 + model.contextSize / 2_000_000;
    case "BALANCED":
      return quality + model.speed * 0.4 + (1 - model.cost) * 0.4;
    case "CUSTOM":
    default:
      return quality;
  }
}

function modelKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

function defaultSeeds(): ModelInfo[] {
  return [
    {
      id: "gemini-3.6-flash",
      provider: "gemini",
      reasoningScore: 0.85,
      codingScore: 0.9,
      contextSize: 1_000_000,
      vision: true,
      tools: true,
      structuredOutput: true,
      speed: 0.8,
      cost: 0.2,
      freeTier: "UNKNOWN",
      available: true,
      source: "seed",
    },
    {
      id: "gpt-4o-mini",
      provider: "openai",
      reasoningScore: 0.65,
      codingScore: 0.75,
      contextSize: 128_000,
      vision: true,
      tools: true,
      structuredOutput: true,
      speed: 0.9,
      cost: 0.2,
      freeTier: "NO",
      available: true,
      source: "seed",
    },
    {
      id: "qwen-plus",
      provider: "qwen",
      reasoningScore: 0.75,
      codingScore: 0.8,
      contextSize: 128_000,
      vision: false,
      tools: true,
      structuredOutput: true,
      speed: 0.7,
      cost: 0.3,
      freeTier: "UNKNOWN",
      available: true,
      source: "seed",
    },
    {
      id: "google/gemini-2.0-flash-001",
      provider: "openrouter",
      reasoningScore: 0.7,
      codingScore: 0.8,
      contextSize: 1_000_000,
      vision: true,
      tools: true,
      structuredOutput: true,
      speed: 0.85,
      cost: 0.25,
      freeTier: "UNKNOWN",
      available: true,
      source: "seed",
    },
  ];
}

/** Create registry preloaded with seed models. */
export function createSeededModelRegistry(
  options: ModelRegistryOptions = {},
): ModelRegistry {
  const registry = new ModelRegistry(options);
  for (const model of defaultSeeds()) {
    registry.upsert(model);
  }
  return registry;
}
