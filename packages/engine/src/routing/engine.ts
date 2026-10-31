import type { KeyVault, StoredApiKey } from "../keys/vault.js";
import type { ModelRegistry, RoutingPreference } from "../models/registry.js";
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  ApiKeyRef,
  ProviderError,
} from "../providers/ai/types.js";
import { ProviderRequestError } from "../providers/ai/types.js";

export interface RoutingDecision {
  agentId: string;
  provider: string;
  model: string;
  keyId: string;
  keyName: string;
  reason: string[];
  fallbacks: Array<{ provider: string; model: string }>;
  at: string;
}

export interface RoutingRequest {
  agentId: string;
  preference?: RoutingPreference;
  provider?: string | "AUTO";
  model?: string | "AUTO";
  requireStructuredOutput?: boolean;
  system?: string;
  prompt: string;
  temperature?: number;
  jsonMode?: boolean;
}

export interface RoutingEngineOptions {
  providers: Map<string, AIProvider>;
  models: ModelRegistry;
  vault: KeyVault;
  onDecision?: (decision: RoutingDecision) => void;
}

export interface ProviderHealth {
  success: number;
  failure: number;
  rateLimits: number;
  lastErrorAt?: string;
}

/**
 * Selects provider/model/key and executes with automatic fallback.
 * Logical agent identity is owned by the caller — only transport changes.
 */
export class RoutingEngine {
  private readonly health = new Map<string, ProviderHealth>();
  readonly decisions: RoutingDecision[] = [];

  constructor(private readonly options: RoutingEngineOptions) {}

  async generate(request: RoutingRequest): Promise<{
    response: AIResponse;
    decision: RoutingDecision;
  }> {
    const preference = request.preference ?? "BALANCED";
    const chain = this.buildFallbackChain(request, preference);
    if (chain.length === 0) {
      throw new Error(
        `No available provider/model/key route for agent ${request.agentId}`,
      );
    }

    const primary = chain[0]!;
    const decision: RoutingDecision = {
      agentId: request.agentId,
      provider: primary.provider,
      model: primary.model,
      keyId: primary.key.id,
      keyName: primary.key.name,
      reason: primary.reasons,
      fallbacks: chain.slice(1).map((c) => ({
        provider: c.provider,
        model: c.model,
      })),
      at: new Date().toISOString(),
    };
    this.decisions.push(decision);
    this.options.onDecision?.(decision);

    let lastError: ProviderError | undefined;
    for (const candidate of chain) {
      const provider = this.options.providers.get(candidate.provider);
      if (!provider) {
        continue;
      }
      const keyRef: ApiKeyRef = await this.options.vault.reveal(candidate.key.id);
      try {
        const response = await provider.generate({
          model: candidate.model,
          prompt: request.prompt,
          system: request.system,
          temperature: request.temperature,
          jsonMode: request.jsonMode,
          key: keyRef,
        } satisfies AIRequest);
        await this.options.vault.markSuccess(candidate.key.id);
        this.recordSuccess(candidate.provider);
        return {
          response,
          decision: {
            ...decision,
            provider: candidate.provider,
            model: candidate.model,
            keyId: candidate.key.id,
            keyName: candidate.key.name,
          },
        };
      } catch (error) {
        if (error instanceof ProviderRequestError) {
          lastError = error.error;
          this.recordFailure(candidate.provider, error.error);
          if (error.error.category === "RATE_LIMIT" || error.error.category === "QUOTA") {
            await this.options.vault.markRateLimited(
              candidate.key.id,
              error.error.retryAfter ?? 30,
            );
          }
          if (!error.error.retryable) {
            throw error;
          }
          continue;
        }
        throw error;
      }
    }

    throw new ProviderRequestError(
      lastError ?? {
        provider: primary.provider,
        model: primary.model,
        keyId: primary.key.id,
        category: "UNKNOWN",
        message: "All routing fallbacks failed",
        retryable: false,
      },
    );
  }

  private buildFallbackChain(
    request: RoutingRequest,
    preference: RoutingPreference,
  ): Array<{
    provider: string;
    model: string;
    key: StoredApiKey;
    reasons: string[];
  }> {
    const out: Array<{
      provider: string;
      model: string;
      key: StoredApiKey;
      reasons: string[];
    }> = [];

    const providerFilter =
      request.provider && request.provider !== "AUTO"
        ? [request.provider]
        : [...this.options.providers.keys()];

    for (const providerId of providerFilter) {
      const key = this.options.vault.selectKey(providerId);
      if (!key) {
        continue;
      }
      const health = this.health.get(providerId);
      if (health && health.failure > health.success + 5) {
        continue;
      }

      const modelsForProvider: string[] = [];
      if (request.model && request.model !== "AUTO") {
        modelsForProvider.push(request.model);
        // Add other available models from same provider as fallbacks
        for (const m of this.options.models.list(providerId)) {
          if (m.available && m.id !== request.model) {
            modelsForProvider.push(m.id);
          }
        }
      } else {
        const auto = this.options.models.resolveAuto(preference, {
          providerIds: [providerId],
          requireStructuredOutput: request.requireStructuredOutput,
        });
        if (auto) {
          modelsForProvider.push(auto.id);
        }
        for (const m of this.options.models.list(providerId)) {
          if (m.available && !modelsForProvider.includes(m.id)) {
            modelsForProvider.push(m.id);
          }
        }
      }

      for (const modelId of modelsForProvider) {
        out.push({
          provider: providerId,
          model: modelId,
          key,
          reasons: [
            `preference=${preference}`,
            `key=${key.name} (${key.health})`,
            `model=${modelId}`,
          ],
        });
      }
    }

    return out;
  }

  private recordSuccess(provider: string): void {
    const h = this.health.get(provider) ?? {
      success: 0,
      failure: 0,
      rateLimits: 0,
    };
    h.success += 1;
    this.health.set(provider, h);
  }

  private recordFailure(provider: string, error: ProviderError): void {
    const h = this.health.get(provider) ?? {
      success: 0,
      failure: 0,
      rateLimits: 0,
    };
    h.failure += 1;
    if (error.category === "RATE_LIMIT") {
      h.rateLimits += 1;
    }
    h.lastErrorAt = new Date().toISOString();
    this.health.set(provider, h);
  }

  getHealth(): Map<string, ProviderHealth> {
    return new Map(this.health);
  }
}
