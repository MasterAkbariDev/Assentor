import { GeminiProvider } from "./gemini.js";
import {
  createOpenAIProvider,
  createOpenRouterProvider,
  createQwenProvider,
  OpenAICompatibleProvider,
} from "./openai-compatible.js";
import type { AIProvider, FetchFn } from "./types.js";

export * from "./types.js";
export * from "./gemini.js";
export * from "./openai-compatible.js";

const providers = new Map<string, AIProvider>();

export function registerProvider(provider: AIProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): AIProvider | undefined {
  return providers.get(id);
}

export function listProviders(): AIProvider[] {
  return [...providers.values()];
}

export function createDefaultProviderRegistry(options: {
  fetchFn?: FetchFn;
} = {}): Map<string, AIProvider> {
  const registry = new Map<string, AIProvider>();
  const gemini = new GeminiProvider({ fetchFn: options.fetchFn });
  const openai = createOpenAIProvider({ fetchFn: options.fetchFn });
  const openrouter = createOpenRouterProvider({ fetchFn: options.fetchFn });
  const qwen = createQwenProvider({ fetchFn: options.fetchFn });
  for (const provider of [gemini, openai, openrouter, qwen]) {
    registry.set(provider.id, provider);
    registerProvider(provider);
  }
  return registry;
}

export function ensureProvidersRegistered(fetchFn?: FetchFn): void {
  if (providers.size === 0) {
    createDefaultProviderRegistry({ fetchFn });
  }
}

export type { OpenAICompatibleProvider };
