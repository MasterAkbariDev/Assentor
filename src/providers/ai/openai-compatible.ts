import {
  classifyHttpError,
  ProviderRequestError,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type ApiKeyRef,
  type FetchFn,
  type KeyStatus,
  type ModelInfo,
  type UsageInfo,
} from "./types.js";

export interface OpenAICompatibleProviderOptions {
  id: string;
  name: string;
  baseUrl: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  seedModels?: ModelInfo[];
  defaultModel?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
  error?: { message?: string };
}

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly seedModels: ModelInfo[];

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.seedModels = options.seedModels ?? [];
  }

  async listModels(key: ApiKeyRef): Promise<ModelInfo[]> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${key.secret}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const raw = await response.text();
      if (!response.ok) {
        return this.seedModels;
      }
      const payload = JSON.parse(raw) as ModelsListResponse;
      const ids = (payload.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id));
      if (ids.length === 0) {
        return this.seedModels;
      }
      return ids.map((id) => {
        const known = this.seedModels.find((m) => m.id === id);
        return (
          known ?? {
            id,
            provider: this.id,
            displayName: id,
            reasoningScore: 0.5,
            codingScore: 0.5,
            contextSize: 128_000,
            vision: false,
            tools: true,
            structuredOutput: true,
            speed: 0.5,
            cost: 0.5,
            freeTier: "UNKNOWN" as const,
            available: true,
            lastChecked: new Date().toISOString(),
            source: "api",
          }
        );
      });
    } catch {
      return this.seedModels;
    }
  }

  async validateKey(key: ApiKeyRef): Promise<KeyStatus> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${key.secret}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
      });
      const raw = await response.text();
      if (!response.ok) {
        const classified = classifyHttpError(response.status, raw);
        return {
          valid: false,
          reachable: true,
          authenticated: false,
          modelsAvailable: false,
          message: `HTTP ${response.status}: ${raw.slice(0, 200)}`,
          category: classified.category,
        };
      }
      const payload = JSON.parse(raw) as ModelsListResponse;
      const models = (payload.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id));
      return {
        valid: true,
        reachable: true,
        authenticated: true,
        modelsAvailable: models.length > 0,
        message: "API key valid",
        models: models.slice(0, 50),
      };
    } catch (error) {
      return {
        valid: false,
        reachable: false,
        authenticated: false,
        modelsAvailable: false,
        message: error instanceof Error ? error.message : String(error),
        category: "NETWORK",
      };
    }
  }

  async getUsage(_key: ApiKeyRef): Promise<UsageInfo> {
    return { known: false };
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.key.secret}`,
        },
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature ?? 0,
          ...(request.jsonMode
            ? { response_format: { type: "json_object" } }
            : {}),
          messages: [
            ...(request.system
              ? [{ role: "system", content: request.system }]
              : []),
            { role: "user", content: request.prompt },
          ],
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
      });
      const rawText = await response.text();
      if (!response.ok) {
        const classified = classifyHttpError(response.status, rawText);
        throw new ProviderRequestError({
          provider: this.id,
          model: request.model,
          keyId: request.key.id,
          message: `${this.name} API error ${response.status}: ${rawText}`,
          status: response.status,
          raw: rawText,
          ...classified,
        });
      }
      const payload = JSON.parse(rawText) as ChatCompletionResponse;
      if (payload.error?.message) {
        throw new ProviderRequestError({
          provider: this.id,
          model: request.model,
          keyId: request.key.id,
          category: "INVALID_REQUEST",
          message: payload.error.message,
          retryable: false,
          raw: rawText,
        });
      }
      const text = extractContent(payload);
      if (!text) {
        throw new ProviderRequestError({
          provider: this.id,
          model: request.model,
          keyId: request.key.id,
          category: "UNKNOWN",
          message: `${this.name} returned empty content`,
          retryable: false,
          raw: rawText,
        });
      }
      return {
        text,
        model: request.model,
        provider: this.id,
        raw: rawText,
      };
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderRequestError({
        provider: this.id,
        model: request.model,
        keyId: request.key.id,
        category: /timeout|aborted/i.test(message) ? "TIMEOUT" : "NETWORK",
        message,
        retryable: true,
      });
    }
  }
}

function extractContent(payload: ChatCompletionResponse): string | undefined {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return undefined;
}

export function createOpenAIProvider(
  options: Partial<OpenAICompatibleProviderOptions> & { fetchFn?: FetchFn } = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl:
      options.baseUrl ??
      process.env.ASSENTOR_OPENAI_BASE_URL ??
      "https://api.openai.com/v1",
    fetchFn: options.fetchFn,
    seedModels: [
      {
        id: "gpt-4o",
        provider: "openai",
        reasoningScore: 0.85,
        codingScore: 0.9,
        contextSize: 128_000,
        vision: true,
        tools: true,
        structuredOutput: true,
        speed: 0.6,
        cost: 0.7,
        freeTier: "NO",
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
    ],
  });
}

export function createOpenRouterProvider(
  options: { fetchFn?: FetchFn; baseUrl?: string } = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
    fetchFn: options.fetchFn,
    seedModels: [
      {
        id: "anthropic/claude-sonnet-4",
        provider: "openrouter",
        reasoningScore: 0.9,
        codingScore: 0.95,
        contextSize: 200_000,
        vision: true,
        tools: true,
        structuredOutput: true,
        speed: 0.55,
        cost: 0.8,
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
    ],
  });
}

export function createQwenProvider(
  options: { fetchFn?: FetchFn; baseUrl?: string } = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "qwen",
    name: "Qwen / Alibaba Cloud",
    baseUrl:
      options.baseUrl ??
      process.env.ASSENTOR_QWEN_BASE_URL ??
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    fetchFn: options.fetchFn,
    seedModels: [
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
        id: "qwen-turbo",
        provider: "qwen",
        reasoningScore: 0.55,
        codingScore: 0.65,
        contextSize: 128_000,
        vision: false,
        tools: true,
        structuredOutput: true,
        speed: 0.95,
        cost: 0.1,
        freeTier: "UNKNOWN",
        available: true,
        source: "seed",
      },
    ],
  });
}
