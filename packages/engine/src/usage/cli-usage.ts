/**
 * Token usage a CLI printed in its output (TE-01). Reads the last top-level
 * `usage` object: Claude Code's stream-json `result` line (input, cache read and
 * cache creation tokens, output, `num_turns`, `total_cost_usd`), or an
 * OpenAI-style `usage` (prompt / completion tokens, cached prompt tokens).
 * Cursor, Antigravity and Qwen are covered when their result line carries such
 * a `usage`. Codex and OpenCode print plain text: no usage (undefined).
 */
export interface CliUsage {
  /** All input tokens, cached ones included. */
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  /** Model turns inside the CLI run. */
  turns: number;
  costUsd?: number;
}

export function cliUsage(raw: string): CliUsage | undefined {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{") || !line.includes('"usage"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = usageOf(value);
    if (usage) return usage;
  }
  return undefined;
}

/** The usage of one parsed result object (a stream-json `result` line, Claude Code's `--output-format json` reply, an OpenAI-style body). */
export function usageOf(value: unknown): CliUsage | undefined {
  const { usage, num_turns, total_cost_usd } = (value ?? {}) as { usage?: Record<string, unknown>; num_turns?: unknown; total_cost_usd?: unknown };
  if (!usage || typeof usage !== "object") return undefined;
  const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const turns = typeof num_turns === "number" && num_turns >= 1 ? Math.round(num_turns) : 1;
  const cost = typeof total_cost_usd === "number" ? { costUsd: total_cost_usd } : {};
  if (typeof usage.input_tokens === "number") {
    const cached = num("cache_read_input_tokens");
    return {
      tokensIn: num("input_tokens") + cached + num("cache_creation_input_tokens"),
      tokensOut: num("output_tokens"),
      cachedTokens: cached,
      turns,
      ...cost,
    };
  }
  if (typeof usage.prompt_tokens === "number") {
    const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
    return { tokensIn: num("prompt_tokens"), tokensOut: num("completion_tokens"), cachedTokens: details?.cached_tokens ?? 0, turns, ...cost };
  }
  return undefined;
}

/**
 * The model a CLI or API reply says it ran (FU-17), or undefined when it names
 * none: then the model is unverified. Reads a top-level `model` (Claude Code's
 * stream-json `system` line, Cursor's, an OpenAI-style body), an assistant
 * line's `message.model`, Gemini's `modelVersion`, or Claude Code's JSON
 * result `modelUsage` (the model with the most output tokens). Never falls back
 * to the requested model.
 */
export function reportedModel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  for (const doc of [raw, ...raw.split("\n")]) {
    const text = doc.trim();
    if (!text.startsWith("{") || !/"model/.test(text)) continue;
    try {
      const model = modelOf(JSON.parse(text));
      if (model) return model;
    } catch {
      // Not one JSON document; try the next line.
    }
  }
  return undefined;
}

function modelOf(value: unknown): string | undefined {
  const v = (value ?? {}) as { model?: unknown; message?: { model?: unknown }; modelVersion?: unknown; modelUsage?: unknown };
  // `<synthetic>` and the like are placeholders, not models.
  const name = (x: unknown) => (typeof x === "string" && x.trim() && !x.trim().startsWith("<") ? x.trim() : undefined);
  const usage = v.modelUsage && typeof v.modelUsage === "object" ? Object.entries(v.modelUsage as Record<string, { outputTokens?: unknown }>) : [];
  const out = (entry: (typeof usage)[number]) => (typeof entry[1]?.outputTokens === "number" ? entry[1].outputTokens : 0);
  const main = usage.sort((a, b) => out(b) - out(a))[0]?.[0];
  return name(v.model) ?? name(v.message?.model) ?? name(v.modelVersion) ?? name(main);
}
