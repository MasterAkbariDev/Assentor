import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../../packages/protocol/src/events.js";
import {
  CliReviewer,
  GeminiProvider,
  OpenAICompatibleProvider,
  OpenAICompatibleReviewer,
  PanelReviewer,
  SeatEventSink,
  assembleSeatPrompt,
  buildReviewPromptParts,
  createEmptyContract,
  specialtyAddendum,
  trackReviewerSeat,
  type Reviewer,
  type ReviewerTurnResult,
} from "../../packages/engine/src/index.js";
import { unwrapClaudeJson } from "../../packages/engine/src/providers/reviewers/cli/index.js";

const key = { id: "k", provider: "openai", name: "test", secret: "sk-test" };

const passJson = JSON.stringify({
  status: "PASS",
  confidence: 0.9,
  summary: "ok",
  issues: [],
  requiredChanges: [],
  optionalChanges: [],
  evidenceRequests: [],
});

function reviewInput(round = 1) {
  return {
    taskId: "t-1",
    projectPath: "/tmp/project",
    contract: createEmptyContract("Guard average() against an empty list"),
    round,
    artifacts: [{ id: "a1", type: "diff", path: "src/average.ts", content: "- return sum / n\n+ if (n === 0) throw new Error('empty')" }],
  };
}

/** A fetch that records each request body and answers with `reply`. */
function recordingFetch(reply: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { bodies, fetchFn };
}

describe("seat prompt order (TE-05)", () => {
  it("puts static, then shared, then the per-seat delta; the blocks join to the text", () => {
    const prompt = assembleSeatPrompt({ static: ["ROLE", "", "STYLE"], shared: ["TASK"], delta: ["SEAT"] });
    expect(prompt.text).toBe("ROLE\n\nSTYLE\n\nTASK\n\nSEAT");
    expect(prompt.blocks).toEqual(["ROLE\n\nSTYLE\n\n", "TASK\n\n", "SEAT"]);
    expect(assembleSeatPrompt({ static: ["ROLE"], shared: ["TASK"], delta: [] }).blocks).toEqual(["ROLE\n\n", "TASK", ""]);
  });

  it("gives every panel member a byte-identical static + shared prefix; only the delta differs", () => {
    const members = ["security", "testing", "architecture"].map((s) =>
      buildReviewPromptParts({ ...reviewInput(2), specialtyAddendum: specialtyAddendum(s) }),
    );
    const [first] = members;
    for (const parts of members) {
      expect(parts.blocks[0]).toBe(first!.blocks[0]);
      expect(parts.blocks[1]).toBe(first!.blocks[1]);
      expect(parts.text.startsWith(first!.blocks[0] + first!.blocks[1])).toBe(true);
    }
    expect(new Set(members.map((p) => p.blocks[2])).size).toBe(3);
    // Static holds no task text; the task and evidence are shared; specialty and round come last.
    const { text, blocks } = first!;
    expect(blocks[0]).not.toContain("average");
    expect(blocks[1]).toContain("Guard average()");
    expect(blocks[2]).toContain("Specialty:");
    expect(blocks[2]).toContain("Round: 2");
    expect(text.indexOf("You are a strict software review agent")).toBe(0);
    expect(text.indexOf("Task contract:")).toBeLessThan(text.indexOf("Specialty:"));
  });

  it("keeps the static block identical across rounds and tasks", () => {
    const a = buildReviewPromptParts(reviewInput(1));
    const b = buildReviewPromptParts({ ...reviewInput(3), contract: createEmptyContract("Another task") });
    expect(b.blocks[0]).toBe(a.blocks[0]);
  });
});

describe("API seats: cache breakpoints and usage (TE-05)", () => {
  const chatReply = {
    choices: [{ message: { content: passJson } }],
    usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1000 } },
  };

  it("sends Claude models cache_control breakpoints after the static and shared blocks", async () => {
    const { bodies, fetchFn } = recordingFetch(chatReply);
    const provider = new OpenAICompatibleProvider({ id: "openrouter", name: "OpenRouter", baseUrl: "https://example.test/v1", fetchFn });
    const reviewer = new OpenAICompatibleReviewer({ apiKey: "sk-test", model: "anthropic/claude-sonnet-4", provider, specialtyAddendum: specialtyAddendum("security") });
    const turn = await reviewer.review(reviewInput());

    const parts = buildReviewPromptParts({ ...reviewInput(), specialtyAddendum: specialtyAddendum("security") });
    const messages = bodies[0]!.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1]!.content).toEqual([
      { type: "text", text: parts.blocks[0], cache_control: { type: "ephemeral" } },
      { type: "text", text: parts.blocks[1], cache_control: { type: "ephemeral" } },
      { type: "text", text: parts.blocks[2] },
    ]);
    expect(turn.result?.status).toBe("PASS");
    expect(turn.usage).toEqual({ tokensIn: 1200, tokensOut: 80, cachedTokens: 1000, turns: 1 });
  });

  it("sends other models the plain prompt string (byte-stable prefix, no unknown fields)", async () => {
    const { bodies, fetchFn } = recordingFetch(chatReply);
    const provider = new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", fetchFn });
    await new OpenAICompatibleReviewer({ apiKey: "sk-test", model: "gpt-4o-mini", provider }).review(reviewInput());
    const messages = bodies[0]!.messages as Array<{ content: unknown }>;
    expect(messages[1]!.content).toBe(buildReviewPromptParts(reviewInput()).text);
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
  });

  it("falls back to the plain prompt when the blocks do not match it", async () => {
    const { bodies, fetchFn } = recordingFetch(chatReply);
    const provider = new OpenAICompatibleProvider({ id: "openrouter", name: "OpenRouter", baseUrl: "https://example.test/v1", fetchFn });
    await provider.generate({ model: "anthropic/claude-sonnet-4", prompt: "abc", promptBlocks: ["a", "x"], key });
    expect((bodies[0]!.messages as Array<{ content: unknown }>)[0]!.content).toBe("abc");
  });

  it("reads Gemini usage, cached and thinking tokens included", async () => {
    const { fetchFn } = recordingFetch({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 10, cachedContentTokenCount: 600 },
    });
    const response = await new GeminiProvider({ fetchFn }).generate({ model: "gemini-2.5-flash", prompt: "p", key });
    expect(response.tokens).toEqual({ tokensIn: 900, tokensOut: 50, cachedTokens: 600 });
  });
});

describe("Claude Code reviewer JSON output (TE-05)", () => {
  const claudeJson = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: passJson,
    num_turns: 2,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500, output_tokens: 70 },
  });

  it("unwraps the reply text and reports its usage", async () => {
    const spawnFn = async () => ({ code: 0, stdout: claudeJson, stderr: "" });
    const turn = await new CliReviewer({ adapter: "claude", binary: "/fake/claude", spawnFn }).review(reviewInput());
    expect(turn.result?.status).toBe("PASS");
    expect(turn.usage).toEqual({ tokensIn: 3510, tokensOut: 70, cachedTokens: 3000, turns: 2, costUsd: 0.01 });
  });

  it("leaves output that is not Claude Code's result object alone", () => {
    for (const stdout of [passJson, "plain text", "{not json"]) {
      expect(unwrapClaudeJson({ code: 0, stdout, stderr: "" })).toEqual({ code: 0, stdout, stderr: "" });
    }
  });
});

describe("reviewer token reports reach seat.tokens (TE-05)", () => {
  const usage = { tokensIn: 100, tokensOut: 20, cachedTokens: 60, turns: 1 };
  const scripted = (name: string, turn: ReviewerTurnResult): Reviewer => ({
    name,
    review: async () => turn,
    continue: async () => turn,
  });

  it("a tracked seat emits its turn's usage", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s-1", onEvent: (event) => events.push(event) });
    const reviewer = trackReviewerSeat(scripted("r", { result: undefined, error: "x", usage }), "reviewer-1", () => sink);
    await reviewer.review(reviewInput());
    await sink.flush();
    const tokens = events.filter((e) => e.type === "seat.tokens");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.seatId).toBe("reviewer-1");
    expect(tokens[0]!.data).toEqual(usage);
  });

  it("a panel reports each member's usage under its seat id", async () => {
    const pass = JSON.parse(passJson);
    const panel = new PanelReviewer({
      reviewers: [scripted("a", { result: pass, usage }), scripted("b", { result: pass })],
      memberSeatIds: ["review.a", "review.b"],
    });
    const turn = await panel.review(reviewInput());
    expect(turn.memberUsage).toEqual([{ seatId: "review.a", usage }]);
  });
});
