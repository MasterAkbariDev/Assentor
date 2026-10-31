import {
  asReviewInput,
  buildReviewPrompt,
  extractReviewImages,
  reviewResultFromModelText,
} from "../shared/prompt.js";
import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "../types.js";
import {
  GeminiProvider,
  ProviderRequestError,
  type ApiKeyRef,
  type FetchFn,
} from "../../ai/index.js";

export interface GeminiReviewerOptions {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  modelFallbacks?: string[];
  temperature?: number;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
  provider?: GeminiProvider;
  keyId?: string;
  specialtyAddendum?: string;
}

const DEFAULT_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

/**
 * Gemini reviewer — uses AIProvider transport with model fallbacks.
 */
export class GeminiReviewer implements Reviewer {
  readonly name: string;
  private readonly apiKey: string;
  private readonly models: string[];
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly onStatus?: (message: string) => void;
  private readonly provider: GeminiProvider;
  private readonly keyId: string;
  private readonly specialtyAddendum?: string;
  callCount = 0;
  lastModelUsed?: string;
  private resolvedModels?: string[];

  constructor(options: GeminiReviewerOptions = {}) {
    this.name = options.name ?? "gemini";
    this.apiKey =
      options.apiKey ??
      process.env.ASSENTOR_GEMINI_API_KEY ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      "";
    const preferred =
      options.model ??
      process.env.ASSENTOR_GEMINI_MODEL ??
      DEFAULT_MODELS[0]!;
    const fallbacks =
      options.modelFallbacks ??
      (process.env.ASSENTOR_GEMINI_MODEL_FALLBACKS
        ? process.env.ASSENTOR_GEMINI_MODEL_FALLBACKS.split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : DEFAULT_MODELS);
    this.models = uniqueModels([preferred, ...fallbacks]);
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.onStatus = options.onStatus;
    this.provider =
      options.provider ??
      new GeminiProvider({
        baseUrl: options.baseUrl,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
      });
    this.keyId = options.keyId ?? "env-gemini";
    this.specialtyAddendum = options.specialtyAddendum;
  }

  async review(input: ReviewInput): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  async continue(input: ReviewContinuation): Promise<ReviewerTurnResult> {
    return this.turn(input);
  }

  private async turn(
    input: ReviewInput | ReviewContinuation,
  ): Promise<ReviewerTurnResult> {
    this.callCount += 1;
    if (!this.apiKey) {
      return {
        error:
          "Missing Gemini API key (set ASSENTOR_GEMINI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY)",
      };
    }

    const prompt = buildReviewPrompt({
      ...asReviewInput(input),
      specialtyAddendum: this.specialtyAddendum,
    });
    const images = extractReviewImages(asReviewInput(input));
    const key: ApiKeyRef = {
      id: this.keyId,
      provider: "gemini",
      name: "env",
      secret: this.apiKey,
    };
    const errors: string[] = [];
    const models = await this.resolveModels(key);
    if (models.length === 0) {
      return {
        error:
          "No Gemini models available for this API key. Set ASSENTOR_GEMINI_MODEL to a model your key supports (e.g. gemini-2.5-flash).",
      };
    }

    for (const model of models) {
      this.onStatus?.(`Calling Gemini (${model})…`);
      try {
        const response = await this.provider.generate({
          model,
          prompt,
          images: images.length > 0 ? images : undefined,
          key,
          temperature: this.temperature,
          jsonMode: true,
          timeoutMs: this.timeoutMs,
        });
        this.lastModelUsed = model;
        this.onStatus?.(`Gemini responded with ${model}`);
        return reviewResultFromModelText(response.text);
      } catch (error) {
        if (error instanceof ProviderRequestError) {
          errors.push(`${model}: ${error.error.message}`);
          if (!error.error.retryable) {
            return {
              error: error.error.message,
              rawOutput: error.error.raw,
            };
          }
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        return { error: message };
      }
    }

    return {
      error: `All Gemini models failed:\n${errors.join("\n")}`,
    };
  }

  private async resolveModels(key: ApiKeyRef): Promise<string[]> {
    if (this.resolvedModels) {
      return this.resolvedModels;
    }

    try {
      const listed = await this.provider.listModels(key);
      const available = new Set(
        listed
          .filter((model) => model.available !== false)
          .map((model) => model.id.replace(/^models\//, "")),
      );
      if (available.size > 0) {
        const matched = this.models.filter((model) => available.has(model));
        this.resolvedModels =
          matched.length > 0 ? matched : [...available].slice(0, 4);
        return this.resolvedModels;
      }
    } catch {
      // Fall through to configured preference order.
    }

    this.resolvedModels = this.models;
    return this.resolvedModels;
  }
}

function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    out.push(model);
  }
  return out;
}
