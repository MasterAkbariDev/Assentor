import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GeminiProvider } from "../../src/providers/ai/gemini.js";
import {
  createOpenAIProvider,
  createOpenRouterProvider,
  createQwenProvider,
} from "../../src/providers/ai/openai-compatible.js";
import { ProviderRequestError } from "../../src/providers/ai/types.js";
import { createSeededModelRegistry } from "../../src/models/index.js";
import { KeyVault, maskSecret } from "../../src/keys/index.js";
import { RoutingEngine } from "../../src/routing/index.js";
import { buildExecutorRegistry } from "../../src/executors/index.js";
import {
  AgentMemoryStore,
  AgentRegistry,
  selectReviewers,
  reviewersDisagree,
} from "../../src/agents/index.js";
import { ReviewStatus } from "../../src/core/types.js";
import type { ReviewResult } from "../../src/protocol/review-result.js";

const TEMP = path.join(process.cwd(), ".tmp", "multi-agent-tests");

async function tempProject(name: string): Promise<string> {
  await fs.mkdir(TEMP, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP, `${name}-`));
  return dir;
}

describe("AI providers", () => {
  it("validates gemini keys via network-shaped fetch", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-x" }] }), {
        status: 200,
      });
    });
    const provider = new GeminiProvider({ fetchFn });
    const status = await provider.validateKey({
      id: "k1",
      provider: "gemini",
      name: "t",
      secret: "secret",
    });
    expect(status.valid).toBe(true);
    expect(status.modelsAvailable).toBe(true);
  });

  it("classifies invalid openai keys", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 401 }));
    const provider = createOpenAIProvider({ fetchFn });
    const status = await provider.validateKey({
      id: "k1",
      provider: "openai",
      name: "t",
      secret: "bad",
    });
    expect(status.valid).toBe(false);
    expect(status.category).toBe("AUTHENTICATION");
  });

  it("registers openrouter and qwen providers", () => {
    expect(createOpenRouterProvider().id).toBe("openrouter");
    expect(createQwenProvider().id).toBe("qwen");
  });
});

describe("Model registry AUTO", () => {
  it("picks a strong available model", () => {
    const registry = createSeededModelRegistry();
    const best = registry.resolveAuto("BEST");
    expect(best?.id).toBeTruthy();
    const cheap = registry.resolveAuto("CHEAPEST");
    expect(cheap?.cost).toBeLessThanOrEqual(best!.cost + 0.01);
  });
});

describe("Key vault", () => {
  it("stores masked secrets and selects healthiest key", async () => {
    const dir = await tempProject("vault");
    const vault = new KeyVault(dir);
    await vault.load();
    const a = await vault.add({
      provider: "gemini",
      name: "A",
      secret: "AIzaSyTestKeyAAAA8888",
      priority: 2,
    });
    const b = await vault.add({
      provider: "gemini",
      name: "B",
      secret: "AIzaSyTestKeyBBBB9999",
      priority: 1,
    });
    expect(a.masked).toBe(maskSecret("AIzaSyTestKeyAAAA8888"));
    expect(a.masked.includes("AIza")).toBe(true);
    expect(a.ciphertext.includes("AIzaSyTestKeyAAAA8888")).toBe(false);

    b.health = "healthy";
    a.health = "cooldown";
    a.cooldownUntil = new Date(Date.now() + 60_000).toISOString();
    await vault.save();

    const selected = vault.selectKey("gemini");
    expect(selected?.id).toBe(b.id);
  });

  it("checks keys for real via provider", async () => {
    const dir = await tempProject("check");
    const vault = new KeyVault(dir);
    await vault.load();
    const key = await vault.add({
      provider: "gemini",
      name: "CheckMe",
      secret: "secret",
    });
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const provider = new GeminiProvider({ fetchFn });
    const { status } = await vault.checkKey(key.id, provider);
    expect(status.valid).toBe(false);
    expect(vault.get(key.id)?.health).toBe("failed");
  });
});

describe("Routing engine fallback", () => {
  it("falls back when primary model is unavailable", async () => {
    const dir = await tempProject("route");
    const vault = new KeyVault(dir);
    await vault.load();
    await vault.add({
      provider: "gemini",
      name: "G1",
      secret: "key-1",
    });

    let calls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      calls += 1;
      const href = String(url);
      if (href.includes("gemini-primary")) {
        return new Response("gone", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"status":"PASS","confidence":1,"summary":"ok","issues":[],"requiredChanges":[],"optionalChanges":[],"evidenceRequests":[]}' }] } }],
        }),
        { status: 200 },
      );
    });

    const gemini = new GeminiProvider({ fetchFn });
    const providers = new Map([["gemini", gemini]]);
    const models = createSeededModelRegistry({ providers });
    models.upsert({
      id: "gemini-primary",
      provider: "gemini",
      reasoningScore: 0.99,
      codingScore: 0.99,
      contextSize: 1_000_000,
      vision: true,
      tools: true,
      structuredOutput: true,
      speed: 0.5,
      cost: 0.5,
      freeTier: "UNKNOWN",
      available: true,
    });
    models.upsert({
      id: "gemini-fallback",
      provider: "gemini",
      reasoningScore: 0.7,
      codingScore: 0.7,
      contextSize: 1_000_000,
      vision: true,
      tools: true,
      structuredOutput: true,
      speed: 0.8,
      cost: 0.2,
      freeTier: "UNKNOWN",
      available: true,
    });

    const routing = new RoutingEngine({ providers, models, vault });
    const result = await routing.generate({
      agentId: "architecture-reviewer",
      provider: "gemini",
      model: "gemini-primary",
      prompt: "hi",
      jsonMode: true,
    });
    expect(result.response.model).not.toBe("gemini-primary");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("Executors detection", () => {
  it("lists adapters including cursor", async () => {
    const registry = buildExecutorRegistry();
    const ids = registry.list().map((a) => a.id);
    expect(ids).toContain("cursor");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    const detections = await registry.detectAll();
    expect(detections.length).toBeGreaterThanOrEqual(5);
  });
});

describe("Logical agents + memory", () => {
  it("persists memory across loads", async () => {
    const dir = await tempProject("mem");
    const store = new AgentMemoryStore(dir);
    await store.appendMessage("architecture-reviewer", "assistant", "Found issue A");
    const again = new AgentMemoryStore(dir);
    const mem = await again.load("architecture-reviewer");
    expect(mem.recentMessages.some((m) => m.content.includes("issue A"))).toBe(
      true,
    );
    const pack = again.buildContextPack({
      memory: mem,
      contractGoal: "Build auth",
      acceptanceCriteria: ["Login works"],
    });
    expect(pack).toContain("Build auth");
    expect(pack).toContain("issue A");
  });

  it("selects adaptive reviewers", async () => {
    const dir = await tempProject("agents");
    const registry = new AgentRegistry(dir);
    await registry.load();
    const selected = selectReviewers(
      registry.list(),
      "ADAPTIVE",
      "Implement OAuth authentication with secure session cookies",
      { min: 1, max: 4 },
    );
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected.some((s) => s.specialty === "security")).toBe(true);
  });
});

describe("Reviewer disagreement", () => {
  it("detects disagreeing statuses", () => {
    const pass: ReviewResult = {
      status: ReviewStatus.Pass,
      confidence: 1,
      summary: "ok",
      issues: [],
      requiredChanges: [],
      optionalChanges: [],
      evidenceRequests: [],
    };
    const needs: ReviewResult = {
      ...pass,
      status: ReviewStatus.NeedsWork,
      summary: "fix",
      requiredChanges: ["fix"],
    };
    expect(
      reviewersDisagree([
        { agentId: "a", result: pass },
        { agentId: "b", result: needs },
      ]),
    ).toBe(true);
  });
});

describe("Critical multi-agent simulation", () => {
  it("keeps logical identity while rotating keys and resolving debate", async () => {
    const dir = await tempProject("sim");
    const vault = new KeyVault(dir);
    await vault.load();
    const key1 = await vault.add({
      provider: "gemini",
      name: "Key 1",
      secret: "key-1-secret-aaaa",
    });
    const key2 = await vault.add({
      provider: "gemini",
      name: "Key 2",
      secret: "key-2-secret-bbbb",
    });

    // Key1 starts healthy then gets rate limited mid-run
    await vault.markSuccess(key1.id);

    const memory = new AgentMemoryStore(dir);
    await memory.appendMessage(
      "architecture-reviewer",
      "assistant",
      "Fix issue A in auth middleware",
    );

    // Simulate rate limit on key1 → select key2
    await vault.markRateLimited(key1.id, 60);
    const selected = vault.selectKey("gemini");
    expect(selected?.id).toBe(key2.id);

    // Same logical agent still has context
    const mem = await memory.load("architecture-reviewer");
    expect(mem.recentMessages[0]?.content).toContain("issue A");

    const findings = [
      {
        agentId: "architecture-reviewer",
        result: {
          status: ReviewStatus.Pass,
          confidence: 0.9,
          summary: "Architecture OK after fix A",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        } satisfies ReviewResult,
      },
      {
        agentId: "testing-reviewer",
        result: {
          status: ReviewStatus.Pass,
          confidence: 0.9,
          summary: "Tests cover B",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        } satisfies ReviewResult,
      },
      {
        agentId: "security-reviewer",
        result: {
          status: ReviewStatus.NeedsWork,
          confidence: 0.8,
          summary: "Issue C remains",
          issues: [
            {
              id: "c",
              severity: "major" as const,
              description: "Issue C",
              evidence: [],
            },
          ],
          requiredChanges: ["Fix C"],
          optionalChanges: [],
          evidenceRequests: [],
        } satisfies ReviewResult,
      },
    ];

    expect(reviewersDisagree(findings)).toBe(true);

    // After executor "fixes" C, all pass — no context loss
    await memory.appendMessage(
      "architecture-reviewer",
      "user",
      "Executor fixed B and C",
    );
    const pack = memory.buildContextPack({
      memory: await memory.load("architecture-reviewer"),
      contractGoal: "Implement authentication",
      acceptanceCriteria: ["secure login"],
    });
    expect(pack).toContain("issue A");
    expect(pack).toContain("fixed B and C");
  });
});

describe("Provider error typing", () => {
  it("throws typed provider errors", async () => {
    const fetchFn = vi.fn(async () => new Response("limited", { status: 429 }));
    const provider = new GeminiProvider({ fetchFn });
    await expect(
      provider.generate({
        model: "gemini-x",
        prompt: "hi",
        key: { id: "k", provider: "gemini", name: "k", secret: "s" },
      }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
  });
});
