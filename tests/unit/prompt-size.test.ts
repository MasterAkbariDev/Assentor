import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PromptLibrary } from "../../packages/engine/src/prompts/library.js";
import {
  ALWAYS_ON_CAP_TOKENS,
  checkPromptSizes,
  defaultAlwaysOn,
  promptSizes,
  REPO_ROOT,
  type PromptSizes,
} from "../../scripts/bench/tokens.js";

/**
 * Prompt-size guard (TE-10): the always-on part of every built-in role prompt
 * (role text + style fragment + skills index) is pinned. Growth over 5% fails
 * until the snapshot is updated in review:
 *   UPDATE_PROMPT_SIZES=1 npx vitest run tests/unit/prompt-size.test.ts
 */
const SNAPSHOT = path.join(REPO_ROOT, "scripts/bench/prompt-sizes.json");
const library = PromptLibrary.loadBuiltinSync();
/** Role text plus what the default config adds to every seat prompt: its style fragment and skills index, from the shipped files. */
const current = promptSizes(library, defaultAlwaysOn());

/** A "be brief" saver pasted into every prompt: about 600 tokens. */
const BLOATED_SAVER = `## Token saver\n${"- Be brief: answer first, no preamble, no restating the task, no closing summary.\n".repeat(30)}`;

describe("prompt-size snapshot", () => {
  it("the always-on part of every built-in prompt is within 5% of the snapshot", () => {
    if (process.env.UPDATE_PROMPT_SIZES) {
      writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as PromptSizes;
    expect(checkPromptSizes(current, snapshot)).toEqual([]);
    expect(Object.keys(current.prompts).length).toBeGreaterThan(30);
  });

  it("fails a change over 5% either way and passes one under it", () => {
    const snapshot: PromptSizes = { prompts: { a: 1000, b: 1000 }, extra: 0 };
    expect(checkPromptSizes({ prompts: { a: 1040, b: 960 }, extra: 0 }, snapshot)).toEqual([]);
    expect(checkPromptSizes({ prompts: { a: 1000, b: 900 }, extra: 0 }, snapshot)).toEqual([
      "b: 900 tokens, -10% under the snapshot (1000) — update it to tighten the pin",
    ]);
    expect(checkPromptSizes({ prompts: { a: 1060, b: 1000 }, extra: 0 }, snapshot)).toEqual([
      "a: 1060 tokens, +6% over the snapshot (1000); more than +5%",
    ]);
    expect(checkPromptSizes({ prompts: { a: 1000, c: 10 }, extra: 0 }, snapshot)).toEqual([
      "c: not in the snapshot (10 tokens) — update it",
      "b: in the snapshot but no longer a prompt — update it",
    ]);
  });

  it(`caps style + skills index at ${ALWAYS_ON_CAP_TOKENS} tokens`, () => {
    const atCap = "x".repeat(ALWAYS_ON_CAP_TOKENS * 4);
    expect(promptSizes(library, atCap).extra).toBe(ALWAYS_ON_CAP_TOKENS);
    expect(checkPromptSizes({ prompts: {}, extra: promptSizes(library, atCap).extra }, { prompts: {}, extra: 0 })).toEqual([]);
    expect(checkPromptSizes({ prompts: {}, extra: promptSizes(library, `${atCap}x`).extra }, { prompts: {}, extra: 0 })).toEqual([
      `style + skills index is ${ALWAYS_ON_CAP_TOKENS + 1} tokens per seat prompt, over the ${ALWAYS_ON_CAP_TOKENS}-token cap`,
    ]);
  });

  it("a bloated always-on saver fails the snapshot: over the cap and every prompt grows", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as PromptSizes;
    const problems = checkPromptSizes(promptSizes(library, BLOATED_SAVER), snapshot);
    expect(problems[0]).toMatch(/^style \+ skills index is \d+ tokens per seat prompt, over the 300-token cap$/);
    expect(problems.filter((p) => p.includes("over the snapshot"))).toHaveLength(Object.keys(snapshot.prompts).length);
  });
});
