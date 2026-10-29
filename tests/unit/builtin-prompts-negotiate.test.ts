import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STALL_PATTERNS } from "../../src/orchestrator/phase-steering.js";
import { expandSeatSpecs } from "../../src/core/seats.js";
import {
  NEGOTIATION_STEPS,
  STEP_REPLY_SCHEMAS,
  type NegotiationStep,
  type NegotiationStrategy,
} from "../../src/negotiation/strategy.js";
import { createMockNegotiationContext, type MockAsk } from "../../src/negotiation/testing/mock-context.js";
import { debateStrategy } from "../../src/negotiation/strategies/debate.js";
import { synthesizeStrategy } from "../../src/negotiation/strategies/synthesize.js";
import { voteStrategy } from "../../src/negotiation/strategies/vote.js";
import {
  PromptLibrary,
  renderPrompt,
  templateVariables,
  type PromptDefinition,
  type PromptFrontMatter,
  type TemplateVariables,
} from "../../src/prompts/index.js";

/**
 * Negotiation step prompts and the moderator and judge (T03-03b). Each prompt
 * loads through the real loader, asks for exactly the JSON its step schema
 * accepts, and declares the variables the engine really passes.
 */

interface StepPrompt {
  role: PromptFrontMatter["role"];
  output: PromptFrontMatter["output"];
  variables: string[];
}

const PROMPTS: Record<string, StepPrompt> = {
  "negotiate-propose": { role: "meta", output: "negotiation-proposal", variables: ["goal"] },
  "negotiate-critique": { role: "meta", output: "negotiation-proposal", variables: ["goal", "round", "proposals"] },
  "negotiate-revise": {
    role: "meta",
    output: "negotiation-proposal",
    variables: ["goal", "round", "label", "proposal", "proposals", "critiques"],
  },
  "negotiate-rank": { role: "meta", output: "ranking", variables: ["goal", "proposals"] },
  "negotiate-agree": { role: "meta", output: "ranking", variables: ["goal", "round", "proposals", "critiques"] },
  "negotiate-synthesize": { role: "meta", output: "synthesis", variables: ["goal", "proposals"] },
  moderator: { role: "meta", output: "ranking", variables: ["goal", "proposals", "rounds", "critiques"] },
  judge: { role: "reviewer", output: "ranking", variables: ["goal", "proposals", "critiques"] },
};

/** Every prompt the strategies ask for (step names are prompt ids). */
const NEW_IDS = Object.keys(PROMPTS);

const SECTIONS = ["## Mission", "## Inputs", "## Process", "## Output format", "## Rules"];

const ANONYMITY =
  "Proposals are anonymous: they carry labels, not seat names. Do not try to identify who wrote any proposal.";
const REDACTION = "Redact secrets: never echo a secret value; replace it with `[REDACTED]`";
const VENDOR_NAMES = /claude|gpt|gemini|openai|anthropic|cursor|codex|copilot/i;

const library = PromptLibrary.loadBuiltinSync();

function prompt(id: string): PromptDefinition {
  const found = library.get(id);
  if (!found) {
    throw new Error(`missing built-in prompt ${id}`);
  }
  return found;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The one fenced JSON example in a prompt body. */
function jsonExample(body: string): unknown {
  const matches = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
  expect(matches, "exactly one json example").toHaveLength(1);
  return JSON.parse(matches[0]![1]!);
}

describe("negotiation prompts load", () => {
  it("the built-in library has zero load errors and every new id", () => {
    expect(library.errors).toEqual([]);
    for (const id of NEW_IDS) {
      expect(library.has(id), id).toBe(true);
    }
  });

  it("the real async loader reads the same prompts", async () => {
    const loaded = await PromptLibrary.load({ userDir: path.join(os.tmpdir(), "assentor-no-user-prompts") });
    expect(loaded.errors).toEqual([]);
    for (const id of NEW_IDS) {
      expect(loaded.get(id)?.layer, id).toBe("builtin");
    }
  });

  it.each(NEW_IDS)("%s has its id, one-word icon, and version 1", (id) => {
    const def = prompt(id);
    expect(def.id).toBe(id);
    expect(def.title.trim().length).toBeGreaterThan(0);
    expect(def.icon.trim().split(/\s+/)).toHaveLength(1);
    expect(def.recommendedModels).toEqual([]);
    expect(def.version).toBe(1);
  });

  it.each(Object.entries(PROMPTS))("%s has the role, output, permissions and variables it should", (id, expected) => {
    const def = prompt(id);
    expect(def.role).toBe(expected.role);
    expect(def.output).toBe(expected.output);
    expect(def.permissions).toBe("read-only");
    expect([...def.variables].sort()).toEqual([...expected.variables].sort());
    expect(new Set(templateVariables(def.body))).toEqual(new Set(def.variables));
  });

  it("the step names the strategies use all have a prompt", () => {
    for (const step of NEGOTIATION_STEPS) {
      expect(library.has(step), step).toBe(true);
    }
  });
});

describe("negotiation prompt structure", () => {
  it.each(NEW_IDS)("%s has the five body sections in order", (id) => {
    const headings = prompt(id)
      .body.split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual(SECTIONS);
  });

  it.each(NEW_IDS)("%s is between 300 and 900 words", (id) => {
    const count = words(prompt(id).body);
    expect(count, `${id} has ${count} words`).toBeGreaterThanOrEqual(300);
    expect(count, `${id} has ${count} words`).toBeLessThanOrEqual(900);
  });

  it.each(NEW_IDS)("%s has no vendor or model names and no stall phrases", (id) => {
    const body = prompt(id).body;
    expect(body).not.toMatch(VENDOR_NAMES);
    for (const pattern of STALL_PATTERNS) {
      expect(body).not.toMatch(pattern);
    }
  });

  it.each(NEW_IDS)("%s carries the shared rules", (id) => {
    const body = prompt(id).body;
    expect(body).toMatch(/never edit files, and never run commands that change the repository/i);
    expect(body).toMatch(/do not claim tests pass unless the evidence shows they ran/i);
    expect(body).toContain("Reply with the JSON only.");
    expect(body).toContain("Reply with exactly one fenced JSON block, and nothing before or after it.");
  });

  it.each(NEW_IDS)("%s says proposals are anonymous and redacts secrets", (id) => {
    const body = prompt(id).body;
    expect(body).toContain(ANONYMITY);
    expect(body).toContain(REDACTION);
  });
});

describe("JSON replies match the step schemas", () => {
  it.each(Object.keys(STEP_REPLY_SCHEMAS))("%s has one JSON example that the step schema accepts", (step) => {
    const example = jsonExample(prompt(step).body);
    const parsed = STEP_REPLY_SCHEMAS[step as NegotiationStep].safeParse(example);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it.each(Object.keys(STEP_REPLY_SCHEMAS))("%s example uses exactly the fields its schema declares", (step) => {
    const example = jsonExample(prompt(step).body) as Record<string, unknown>;
    const schema = STEP_REPLY_SCHEMAS[step as NegotiationStep] as unknown as { shape: Record<string, unknown> };
    expect(Object.keys(example).sort()).toEqual(Object.keys(schema.shape).sort());
  });

  it("moderator and judge name their decision fields", () => {
    expect(prompt("moderator").body).toContain("`preferred` names a proposal label");
    expect(prompt("judge").body).toContain("`winner` names a proposal label");
  });

  it("the judge may not pick its own proposal", () => {
    expect(prompt("judge").body).toContain("You may not pick your own proposal.");
  });
});

describe("variables the engine really passes", () => {
  /** A scripted reply for each step, shaped to pass its schema and steer the strategies to every step. */
  function scriptFor(ask: MockAsk): unknown {
    const proposals = (ask.vars.proposals as Array<{ label: string }> | undefined) ?? [];
    const first = proposals[0]?.label ?? "Proposal A";
    const last = proposals.at(-1)?.label ?? "Proposal A";
    switch (ask.step) {
      case "negotiate-propose":
        return { proposal: `plan from ${ask.seatId}` };
      case "negotiate-rank":
        return { ranking: proposals.map((p) => p.label) };
      case "negotiate-critique":
        return {
          critiques: [{ target: first, text: "the retry cap is unchecked", citations: ["src/net/upload.ts:12"] }],
        };
      case "negotiate-revise":
        return { proposal: `revised by ${ask.seatId}`, changes: "accepted the critique" };
      case "negotiate-agree":
        return { agree: false, preferred: first, confidence: 0.5 };
      case "negotiate-synthesize":
        return { answer: "merged plan", sources: [{ label: first, used: "the retry cap" }] };
      case "moderator":
        return { consensus: false, preferred: first, reasons: ["safer"] };
      case "judge":
        return { winner: last, reasons: ["clearer"] };
      default:
        return { fail: `no script for ${ask.step}` };
    }
  }

  it("every step renders from exactly the variables a strategy passes", async () => {
    const seats = expandSeatSpecs([
      { provider: "claude-code", model: "opus", count: 2 },
      { provider: "codex", model: "sol" },
    ]);
    const runs: Array<{ strategy: NegotiationStrategy; options: Record<string, unknown> }> = [
      { strategy: voteStrategy, options: {} },
      { strategy: debateStrategy, options: { maxRounds: 2 } },
      { strategy: debateStrategy, options: { maxRounds: 1, moderator: "sol-1" } },
      { strategy: synthesizeStrategy, options: { aggregator: "sol-1" } },
    ];

    const seen = new Map<string, Array<Readonly<Record<string, unknown>>>>();
    for (const { strategy, options } of runs) {
      const { ctx, asks } = createMockNegotiationContext({ seats, script: scriptFor, options });
      await strategy.run(ctx);
      for (const ask of asks) {
        seen.set(ask.step, [...(seen.get(ask.step) ?? []), ask.vars]);
      }
    }

    expect([...seen.keys()].sort()).toEqual([...NEGOTIATION_STEPS].sort());
    for (const [step, varsList] of seen) {
      const def = prompt(step);
      for (const vars of varsList) {
        expect(Object.keys(vars).sort(), step).toEqual([...def.variables].sort());
        const rendered = renderPrompt(def.body, vars as TemplateVariables);
        expect(rendered).not.toMatch(/\{\{/);
      }
    }
  });
});
