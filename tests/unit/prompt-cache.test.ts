import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../../packages/protocol/src/events.js";
import {
  CliReviewer,
  GeminiProvider,
  OpenAICompatibleReviewer,
  PanelReviewer,
  PRINT_CLI_RECIPES,
  PrintCliExecutor,
  SeatEventSink,
  assembleSeatPrompt,
  buildReviewPromptParts,
  createEmptyContract,
  specialtyAddendum,
  trackReviewerSeat,
  type Reviewer,
  type ReviewerTurnResult,
} from "../../packages/engine/src/index.js";
import { OpenAICompatibleProvider } from "../../packages/engine/src/providers/ai/openai-compatible.js";
import { unwrapClaudeJson } from "../../packages/engine/src/providers/reviewers/cli/index.js";
import { runFollowUp } from "../../packages/engine/src/providers/executors/follow-up.js";
import type { Executor, ExecutorResult } from "../../packages/engine/src/providers/executors/types.js";

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
    expect(blocks[2].endsWith("Reply with the JSON object only.")).toBe(true);
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

  it("sends Claude on OpenRouter one cache_control breakpoint, after the static block", async () => {
    const { bodies, fetchFn } = recordingFetch(chatReply);
    const provider = new OpenAICompatibleProvider({ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", fetchFn });
    const reviewer = new OpenAICompatibleReviewer({ apiKey: "sk-test", model: "anthropic/claude-sonnet-4", provider, specialtyAddendum: specialtyAddendum("security") });
    const turn = await reviewer.review(reviewInput());

    const parts = buildReviewPromptParts({ ...reviewInput(), specialtyAddendum: specialtyAddendum("security") });
    const messages = bodies[0]!.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1]!.content).toEqual([
      { type: "text", text: parts.blocks[0], cache_control: { type: "ephemeral" } },
      { type: "text", text: parts.blocks[1] + parts.blocks[2] },
    ]);
    expect(turn.result?.status).toBe("PASS");
    expect(turn.usage).toEqual({ tokensIn: 1200, tokensOut: 80, cachedTokens: 1000, turns: 1 });
  });

  it("sends cache_control to an Anthropic base URL, never to a non-Anthropic one by model name alone", async () => {
    for (const [baseUrl, model, cached] of [
      ["https://api.anthropic.com/v1", "claude-sonnet-4", true],
      ["https://example.test/v1", "claude-sonnet-4", false],
      ["https://api.openai.com/v1", "anthropic/claude-sonnet-4", false],
      ["https://openrouter.ai/api/v1", "openai/gpt-4o", false],
    ] as const) {
      const { bodies, fetchFn } = recordingFetch(chatReply);
      const provider = new OpenAICompatibleProvider({ id: "x", name: "X", baseUrl, fetchFn });
      await provider.generate({ model, prompt: "ab", promptBlocks: ["a", "b"], key });
      expect(JSON.stringify(bodies[0]).includes("cache_control")).toBe(cached);
    }
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
    const provider = new OpenAICompatibleProvider({ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", fetchFn });
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

  it("reports an is_error result or an error_* subtype without a result as a failed call", async () => {
    const isError = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" });
    expect(unwrapClaudeJson({ code: 0, stdout: isError, stderr: "" })).toMatchObject({ code: 1, stdout: "", stderr: "Credit balance is too low" });
    const maxTurns = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false });
    expect(unwrapClaudeJson({ code: 1, stdout: maxTurns, stderr: "" })).toMatchObject({ code: 1, stdout: "", stderr: "claude CLI error: error_max_turns" });
    const spawnFn = async () => ({ code: 0, stdout: isError, stderr: "" });
    const turn = await new CliReviewer({ adapter: "claude", binary: "/fake/claude", spawnFn }).review(reviewInput());
    expect(turn.result).toBeUndefined();
    expect(turn.error).toContain("Credit balance is too low");
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

describe("follow-up turns continue the CLI session (TE-05)", () => {
  function fakeExecutor(canContinueSession: boolean, continueStatus: ExecutorResult["status"] = "completed") {
    const calls: Array<{ kind: "run" | "continue"; prompt?: string; sessionId?: string; message?: unknown; newSession?: boolean }> = [];
    const executor: Executor = {
      name: "fake",
      capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession, supportsScreenshots: false }),
      run: async (task) => (
        calls.push({ kind: "run", prompt: task.prompt, ...(task.newSession ? { newSession: true } : {}) }),
        { status: "completed", summary: "ok", sessionId: "s-2" }
      ),
      continue: async (input) => (
        calls.push({ kind: "continue", sessionId: input.sessionId, message: input.messages[0]?.content }),
        { status: continueStatus, summary: continueStatus, sessionId: "s-1" }
      ),
      cancel: async () => undefined,
    };
    return { calls, executor };
  }
  const task = { taskId: "t", projectPath: "/tmp/p", contract: createEmptyContract("fix it"), prompt: "FULL PROMPT\n\nretry: tests fail" };
  const done = { status: "completed" as const, summary: "", sessionId: "s-1" };

  it("sends only the follow-up into the previous session when the executor can continue", async () => {
    const { calls, executor } = fakeExecutor(true);
    await runFollowUp(executor, task, done, "retry: tests fail");
    expect(calls).toEqual([{ kind: "continue", sessionId: "s-1", message: { message: "retry: tests fail", code: "follow_up" } }]);
  });

  it("runs the full prompt fresh on a first turn, without a session, a failed turn or continue support", async () => {
    for (const [canContinue, previous] of [
      [true, undefined],
      [true, { ...done, sessionId: undefined }],
      [true, { ...done, status: "failed" as const }],
      [false, done],
    ] as const) {
      const { calls, executor } = fakeExecutor(canContinue);
      await runFollowUp(executor, task, previous, "retry: tests fail");
      expect(calls).toEqual([{ kind: "run", prompt: task.prompt }]);
    }
  });

  it("falls back to one fresh run in a new session when the continue fails", async () => {
    const { calls, executor } = fakeExecutor(true, "failed");
    const result = await runFollowUp(executor, task, done, "retry: tests fail");
    expect(calls.map((c) => c.kind)).toEqual(["continue", "run"]);
    expect(calls[1]).toEqual({ kind: "run", prompt: task.prompt, newSession: true });
    expect(result.status).toBe("completed");
  });

  it("does not fall back when the continue was cancelled", async () => {
    const { calls, executor } = fakeExecutor(true, "cancelled");
    const result = await runFollowUp(executor, task, done, "retry: tests fail");
    expect(calls.map((c) => c.kind)).toEqual(["continue"]);
    expect(result.status).toBe("cancelled");
  });

  it("a print CLI run with newSession does not resume the last session", async () => {
    const args: string[][] = [];
    const executor = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES["claude-code"]!,
      binary: "/tmp/claude",
      spawnFn: async (request) => (args.push(request.args), { code: 1, stdout: "", stderr: "No conversation found" }),
    });
    const base = { taskId: "t", projectPath: "/tmp/p", contract: createEmptyContract("x"), messages: [] };
    await executor.continue({ ...base, sessionId: "dead", mode: "supervised" });
    await executor.run({ ...task, newSession: true });
    expect(args[0]).toContain("dead");
    expect(args[1]).not.toContain("--resume");
    expect(args[1]).not.toContain("dead");
  });
});
