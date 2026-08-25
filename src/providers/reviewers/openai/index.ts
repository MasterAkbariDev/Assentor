import {
  asReviewInput,
  buildReviewPrompt,
  reviewResultFromModelText,
} from "../shared/prompt.js";
import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "../types.js";
import {
  createOpenAIProvider,
  ProviderRequestError,
  type ApiKeyRef,
  type FetchFn,
  type AIProvider,
} from "../../ai/index.js";

export type { FetchFn };

export interface OpenAICompatibleReviewerOptions {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  provider?: AIProvider;
  keyId?: string;
}

/**
 * OpenAI Chat Completions-compatible reviewer via AIProvider.
 */
export class OpenAICompatibleReviewer implements Reviewer {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly provider: AIProvider;
  private readonly keyId: string;
  callCount = 0;

  constructor(options: OpenAICompatibleReviewerOptions = {}) {
    this.name = options.name ?? "openai";
    this.apiKey =
      options.apiKey ??
      process.env.ASSENTOR_OPENAI_API_KEY ??
      process.env.OPENAI_API_KEY ??
      "";
    this.model =
      options.model ?? process.env.ASSENTOR_OPENAI_MODEL ?? "gpt-4o-mini";
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.provider =
      options.provider ??
      createOpenAIProvider({
        baseUrl: options.baseUrl,
        fetchFn: options.fetchFn,
      });
    this.keyId = options.keyId ?? "env-openai";
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
          "Missing OpenAI API key (set ASSENTOR_OPENAI_API_KEY or OPENAI_API_KEY)",
      };
    }

    const prompt = buildReviewPrompt(asReviewInput(input));
    const key: ApiKeyRef = {
      id: this.keyId,
      provider: this.provider.id,
      name: "env",
      secret: this.apiKey,
    };

    try {
      const response = await this.provider.generate({
        model: this.model,
        prompt,
        system:
          "You are Assentor's reviewer. Reply with JSON only. Do not guess missing evidence.",
        key,
        temperature: this.temperature,
        jsonMode: true,
        timeoutMs: this.timeoutMs,
      });
      return reviewResultFromModelText(response.text);
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        return {
          error: error.error.message,
          rawOutput: error.error.raw,
        };
      }
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
