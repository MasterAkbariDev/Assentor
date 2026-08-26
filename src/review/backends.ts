import type { AssentorConfig } from "../config/schema.js";

export type ReviewerBackend = AssentorConfig["reviewers"][number];

const PROVIDER_LABEL: Record<string, string> = {
  mock: "Mock",
  gemini: "Gemini",
  openai: "OpenAI",
  claude: "Claude",
  "gemini-cli": "Gemini CLI",
};

/** Providers the TUI can add. */
export const REVIEWER_ADD_PROVIDERS = [
  "mock",
  "gemini",
  "openai",
  "claude",
] as const;

export type ReviewerAddProvider = (typeof REVIEWER_ADD_PROVIDERS)[number];

/**
 * Which transports a provider actually supports.
 * Claude / gemini-cli are CLI-only; OpenAI is API-only.
 */
export function transportsForProvider(
  provider: string,
): Array<"api" | "cli"> {
  if (provider === "claude" || provider === "gemini-cli") {
    return ["cli"];
  }
  if (provider === "openai") {
    return ["api"];
  }
  if (provider === "mock") {
    return ["api"];
  }
  if (provider === "gemini") {
    return ["api", "cli"];
  }
  return ["api"];
}

export function defaultTransportForProvider(
  provider: string,
): "api" | "cli" {
  return transportsForProvider(provider)[0] ?? "api";
}

/** Backends that will actually run: first only when strategy is SINGLE. */
export function selectReviewerBackends(
  config: AssentorConfig,
): ReviewerBackend[] {
  const all = config.reviewers ?? [];
  if (all.length === 0) {
    return [];
  }
  if (config.routing.reviewStrategy === "SINGLE") {
    return [all[0]!];
  }
  return all;
}

export function formatReviewerBackend(entry: ReviewerBackend): string {
  const provider =
    PROVIDER_LABEL[entry.provider] ?? entry.provider;
  const via = entry.transport === "cli" ? "cli" : "api";
  const name = entry.name?.trim();
  return name ? `${provider}  ${via}  ${name}` : `${provider}  ${via}`;
}

export function formatReviewerBackendShort(entry: ReviewerBackend): string {
  const provider =
    PROVIDER_LABEL[entry.provider] ?? entry.provider;
  const via = entry.transport === "cli" ? "CLI" : "API";
  return `${provider} via ${via}`;
}
