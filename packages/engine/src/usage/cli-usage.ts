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

/** Placeholders like `<synthetic>` are not models. */
const modelName = (x: unknown) => (typeof x === "string" && x.trim() && !x.trim().startsWith("<") ? x.trim() : undefined);

/**
 * The model Claude Code says it ran (FU-17), from its stream-json or JSON
 * output only, or undefined (unverified). Reads only envelope lines the CLI
 * writes: `system` (`model`), `assistant` (`message.model`) and `result`
 * (`modelUsage`, the model with the most output tokens). Model-written text
 * lives inside those envelopes as strings, so it cannot pose as one; never call
 * this on a plain-text CLI's output.
 */
export function claudeReportedModel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  for (const doc of [raw, ...raw.split("\n")]) {
    const value = parseObject(doc);
    if (!value) continue;
    const model =
      value.type === "system"
        ? modelName(value.model)
        : value.type === "assistant"
          ? modelName((value.message as { model?: unknown } | undefined)?.model)
          : value.type === "result"
            ? mainModel(value.modelUsage)
            : undefined;
    if (model) return model;
  }
  return undefined;
}

/**
 * The model an API reply body names (FU-17), or undefined: an OpenAI-style
 * `chat.completion` body's `model`, or a Gemini body's `modelVersion`. The body
 * is the provider's own JSON, so the model's text cannot set these fields.
 */
export function apiReportedModel(raw: string | undefined): string | undefined {
  const value = parseObject(raw ?? "");
  if (!value) return undefined;
  if (typeof value.object === "string" && value.object.startsWith("chat.completion")) return modelName(value.model);
  return Array.isArray(value.candidates) ? modelName(value.modelVersion) : undefined;
}

function parseObject(doc: string): Record<string, unknown> | undefined {
  const text = doc.trim();
  if (!text.startsWith("{") || !text.includes('"model')) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function mainModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const out = (entry: unknown) => {
    const tokens = (entry as { outputTokens?: unknown } | undefined)?.outputTokens;
    return typeof tokens === "number" ? tokens : 0;
  };
  const [top] = Object.entries(modelUsage).sort((a, b) => out(b[1]) - out(a[1]));
  return modelName(top?.[0]);
}
