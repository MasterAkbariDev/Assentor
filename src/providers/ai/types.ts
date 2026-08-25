/**
 * Provider-agnostic AI transport layer.
 * Logical agents must not depend on a specific HTTP API shape.
 */

export type FetchFn = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderErrorCategory =
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "QUOTA"
  | "TIMEOUT"
  | "NETWORK"
  | "MODEL_UNAVAILABLE"
  | "CONTEXT_OVERFLOW"
  | "INVALID_REQUEST"
  | "SERVER_ERROR"
  | "UNKNOWN";

export interface ProviderError {
  provider: string;
  model?: string;
  keyId?: string;
  category: ProviderErrorCategory;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  status?: number;
  raw?: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
  displayName?: string;
  reasoningScore: number;
  codingScore: number;
  contextSize: number;
  vision: boolean;
  tools: boolean;
  structuredOutput: boolean;
  speed: number;
  /** Relative cost 0 (free/cheap) → 1 (expensive). UNKNOWN → 0.5 */
  cost: number;
  freeTier: "YES" | "NO" | "UNKNOWN";
  available: boolean;
  lastChecked?: string;
  source?: string;
}

export interface ApiKeyRef {
  id: string;
  provider: string;
  name: string;
  /** Plain secret — only in memory after vault decrypt */
  secret: string;
}

export interface KeyStatus {
  valid: boolean;
  reachable: boolean;
  authenticated: boolean;
  modelsAvailable: boolean;
  message: string;
  models?: string[];
  usage?: UsageInfo;
  category?: ProviderErrorCategory;
}

export interface UsageInfo {
  used?: number;
  limit?: number;
  remaining?: number;
  period?: string;
  raw?: Record<string, unknown>;
  known: boolean;
}

export interface AIRequest {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  key: ApiKeyRef;
}

export interface AIResponse {
  text: string;
  model: string;
  provider: string;
  raw?: string;
  usage?: UsageInfo;
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  listModels(key: ApiKeyRef): Promise<ModelInfo[]>;
  validateKey(key: ApiKeyRef): Promise<KeyStatus>;
  getUsage(key: ApiKeyRef): Promise<UsageInfo>;
  generate(request: AIRequest): Promise<AIResponse>;
}

export function classifyHttpError(
  status: number,
  body: string,
): Pick<ProviderError, "category" | "retryable" | "retryAfter"> {
  if (status === 401 || status === 403) {
    return { category: "AUTHENTICATION", retryable: false };
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(body);
    return { category: "RATE_LIMIT", retryable: true, retryAfter };
  }
  if (/quota|billing|insufficient/i.test(body)) {
    return { category: "QUOTA", retryable: true };
  }
  if (status === 404 || /NOT_FOUND|no longer available|not found/i.test(body)) {
    return { category: "MODEL_UNAVAILABLE", retryable: true };
  }
  if (/context|token|too long|maximum/i.test(body)) {
    return { category: "CONTEXT_OVERFLOW", retryable: false };
  }
  if (status >= 500) {
    return { category: "SERVER_ERROR", retryable: true };
  }
  if (status >= 400) {
    return { category: "INVALID_REQUEST", retryable: false };
  }
  return { category: "UNKNOWN", retryable: false };
}

function parseRetryAfter(body: string): number | undefined {
  const match = body.match(/retry.+?(\d+)/i);
  if (match?.[1]) {
    return Number(match[1]);
  }
  return 30;
}

export class ProviderRequestError extends Error {
  readonly error: ProviderError;

  constructor(error: ProviderError) {
    super(error.message);
    this.name = "ProviderRequestError";
    this.error = error;
  }
}
