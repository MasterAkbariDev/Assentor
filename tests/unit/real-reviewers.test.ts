import { describe, expect, it, vi } from "vitest";
import {
  GeminiReviewer,
  OpenAICompatibleReviewer,
  ReviewStatus,
} from "../../src/index.js";
import { createEmptyContract } from "../../src/index.js";

const passJson = JSON.stringify({
  status: "PASS",
  confidence: 0.93,
  summary: "Acceptance criteria satisfied",
  issues: [],
  requiredChanges: [],
  optionalChanges: [],
  evidenceRequests: [],
});

describe("OpenAICompatibleReviewer", () => {
  it("parses structured chat completion JSON", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: passJson } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const reviewer = new OpenAICompatibleReviewer({
      apiKey: "test-key",
      fetchFn,
      model: "gpt-test",
    });

    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("Implement average()"),
      round: 1,
      artifacts: [
        {
          id: "a1",
          type: "file",
          path: "src/average.js",
          content: "export function average(){return 0}",
        },
      ],
    });

    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect(reviewer.callCount).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].headers).toMatchObject({
      authorization: "Bearer test-key",
    });
  });

  it("returns error when API key missing", async () => {
    const reviewer = new OpenAICompatibleReviewer({
      apiKey: "",
      fetchFn: vi.fn(),
    });
    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 1,
      artifacts: [],
    });
    expect(result.error).toMatch(/API key/i);
  });
});

describe("GeminiReviewer", () => {
  it("parses generateContent JSON", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: passJson }] } }],
        }),
        { status: 200 },
      );
    });

    const reviewer = new GeminiReviewer({
      apiKey: "gem-key",
      fetchFn,
      model: "gemini-test",
      modelFallbacks: [],
    });

    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("Implement average()"),
      round: 1,
      artifacts: [],
    });

    expect(result.result?.status).toBe(ReviewStatus.Pass);
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("gem-key");
    expect(String(call[0])).toContain("gemini-test");
  });

  it("falls back when preferred model is unavailable", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("gemini-old")) {
        return new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: "This model models/gemini-old is no longer available.",
              status: "NOT_FOUND",
            },
          }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: passJson }] } }],
        }),
        { status: 200 },
      );
    });

    const statuses: string[] = [];
    const reviewer = new GeminiReviewer({
      apiKey: "gem-key",
      fetchFn,
      model: "gemini-old",
      modelFallbacks: ["gemini-new"],
      onStatus: (message) => statuses.push(message),
    });

    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 1,
      artifacts: [],
    });

    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect(reviewer.lastModelUsed).toBe("gemini-new");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(statuses.some((s) => s.includes("fallback"))).toBe(true);
  });

  it("surfaces non-retryable API failures", async () => {
    const reviewer = new GeminiReviewer({
      apiKey: "gem-key",
      model: "gemini-test",
      modelFallbacks: [],
      fetchFn: async () => new Response("nope", { status: 500 }),
    });

    const result = await reviewer.review({
      taskId: "t1",
      projectPath: "/tmp",
      contract: createEmptyContract("goal"),
      round: 1,
      artifacts: [],
    });

    expect(result.error).toMatch(/500/);
  });
});
