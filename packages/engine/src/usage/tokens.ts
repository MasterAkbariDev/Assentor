/**
 * Fast token estimate (TE-10, reused by the context packer TE-03): about 4
 * characters per token, times a per-model factor. No tokenizer dependency.
 *
 * shortcut: the factors are rough guesses; calibrate them from live `seat.tokens`
 * counts (bench:tokens --live) when exact budgets matter.
 */
const MODEL_FACTORS: Array<[RegExp, number]> = [
  [/claude|anthropic|sonnet|opus|haiku/i, 1.1],
  [/gemini/i, 0.95],
];

export function estimateTokens(text: string, model = ""): number {
  const factor = MODEL_FACTORS.find(([pattern]) => pattern.test(model))?.[1] ?? 1;
  return Math.ceil((text.length / 4) * factor);
}
