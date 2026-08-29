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

export interface GeminiProviderOptions {
  baseUrl?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string } }>;
    };
  }>;
  error?: { message?: string; status?: string; code?: number };
}

const DEFAULT_MODELS: ModelInfo[] = [
  seed("gemini-3.6-flash", 0.85, 0.9, 1_000_000, 0.2),
  seed("gemini-3-flash-preview", 0.8, 0.85, 1_000_000, 0.25),
  seed("gemini-2.5-flash", 0.75, 0.85, 1_000_000, 0.2),
  seed("gemini-2.0-flash", 0.7, 0.8, 1_000_000, 0.15),
  seed("gemini-1.5-flash", 0.6, 0.7, 1_000_000, 0.1),
  seed("gemini-1.5-pro", 0.85, 0.8, 2_000_000, 0.5),
];

function seed(
  id: string,
  reasoning: number,
  coding: number,
  context: number,
  cost: number,
): ModelInfo {
  return {
    id,
    provider: "gemini",
    displayName: id,
    reasoningScore: reasoning,
    codingScore: coding,
    contextSize: context,
    vision: true,
    tools: true,
    structuredOutput: true,
    speed: 1 - cost,
    cost,
    freeTier: "UNKNOWN",
    available: true,
    source: "seed",
  };
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini";
  readonly name = "Google Gemini";
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: GeminiProviderOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.ASSENTOR_GEMINI_BASE_URL ??
      "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async listModels(key: ApiKeyRef): Promise<ModelInfo[]> {
    try {
      const url = `${this.baseUrl}/models?key=${encodeURIComponent(key.secret)}`;
      const response = await this.fetchFn(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const raw = await response.text();
      if (!response.ok) {
        return DEFAULT_MODELS.map((m) => ({ ...m, available: false }));
      }
      const payload = JSON.parse(raw) as {
        models?: Array<{ name?: string; displayName?: string }>;
      };
      const remote = (payload.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
      if (remote.length === 0) {
        return DEFAULT_MODELS;
      }
      return remote.map((id) => {
        const known = DEFAULT_MODELS.find((m) => m.id === id);
        return (
          known ?? {
            id,
            provider: "gemini",
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
      return DEFAULT_MODELS;
    }
  }

  async validateKey(key: ApiKeyRef): Promise<KeyStatus> {
    try {
      const url = `${this.baseUrl}/models?key=${encodeURIComponent(key.secret)}`;
      const response = await this.fetchFn(url, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
      });
      const raw = await response.text();
      if (!response.ok) {
        const classified = classifyHttpError(response.status, raw);
        return {
          valid: false,
          reachable: response.status !== 0,
          authenticated: false,
          modelsAvailable: false,
          message: `HTTP ${response.status}: ${raw.slice(0, 200)}`,
          category: classified.category,
        };
      }
      const payload = JSON.parse(raw) as {
        models?: Array<{ name?: string }>;
      };
      const models = (payload.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
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
    const url = `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.key.secret)}`;
    const parts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [];
    for (const image of request.images ?? []) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data,
        },
      });
    }
    parts.push({ text: request.prompt });
    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts,
            },
          ],
          generationConfig: {
            temperature: request.temperature ?? 0,
            ...(request.jsonMode
              ? { responseMimeType: "application/json" }
              : {}),
          },
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
          message: `Gemini API error ${response.status}: ${rawText}`,
          status: response.status,
          raw: rawText,
          ...classified,
        });
      }
      const payload = JSON.parse(rawText) as GeminiResponse;
      if (payload.error?.message) {
        const classified = classifyHttpError(
          payload.error.code ?? 400,
          payload.error.message,
        );
        throw new ProviderRequestError({
          provider: this.id,
          model: request.model,
          keyId: request.key.id,
          message: payload.error.message,
          raw: rawText,
          ...classified,
        });
      }
      const text = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("");
      if (!text) {
        throw new ProviderRequestError({
          provider: this.id,
          model: request.model,
          keyId: request.key.id,
          category: "UNKNOWN",
          message: "Gemini API returned empty content",
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

export { DEFAULT_MODELS as GEMINI_SEED_MODELS };
