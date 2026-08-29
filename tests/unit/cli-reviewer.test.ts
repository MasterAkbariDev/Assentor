import { describe, expect, it } from "vitest";
import {
  CliReviewer,
  FallbackReviewer,
  MockCliTransport,
  MockReviewer,
  ReviewStatus,
  createEmptyContract,
  parseAssentorConfig,
} from "../../src/index.js";
import { createReviewer } from "../../src/cli/commands.js";

const passJson = JSON.stringify({
  status: "PASS",
  confidence: 0.92,
  summary: "CLI reviewer acceptance criteria satisfied",
  issues: [],
  requiredChanges: [],
  optionalChanges: [],
  evidenceRequests: [],
});

function reviewInput() {
  return {
    taskId: "t-cli",
    projectPath: "/tmp/assentor-cli-review",
    contract: createEmptyContract("Implement average()"),
    round: 1,
    artifacts: [
      {
        id: "a1",
        type: "file",
        path: "src/average.ts",
        content: "export function average(xs: number[]) { return 0 }",
      },
    ],
  };
}

describe("CliReviewer (spec §43)", () => {
  it("parses scripted MockCliTransport JSON (happy path)", async () => {
    const transport = new MockCliTransport({
      adapter: "mock",
      steps: [{ stdout: passJson }],
    });
    const reviewer = new CliReviewer({
      name: "architecture-reviewer",
      adapter: "mock",
      transport,
    });

    const result = await reviewer.review(reviewInput());

    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect(result.result?.summary).toMatch(/acceptance criteria/i);
    expect(result.error).toBeUndefined();
    expect(reviewer.callCount).toBe(1);
    expect(transport.callCount).toBe(1);
    expect(transport.lastPrompt).toContain("Return ONLY valid JSON");
    expect(transport.lastPrompt).toContain("Implement average()");
  });

  it("surfaces CLI transport failures", async () => {
    const transport = new MockCliTransport({
      steps: [{ code: 1, stdout: "", stderr: "CLI binary crashed" }],
    });
    const reviewer = new CliReviewer({
      name: "code-reviewer",
      transport,
    });

    const result = await reviewer.review(reviewInput());
    expect(result.error).toMatch(/crashed|exited/i);
    expect(result.result).toBeUndefined();
  });
});

describe("FallbackReviewer (spec §43)", () => {
  it("keeps logical id and switches to API fallback when CLI fails", async () => {
    const failingCli = new CliReviewer({
      name: "architecture-reviewer",
      adapter: "mock",
      transport: new MockCliTransport({
        steps: [
          {
            code: 1,
            stdout: "",
            stderr: "claude: command not found",
          },
        ],
      }),
    });

    const apiFallback = new MockReviewer({
      name: "architecture-reviewer",
      steps: [
        {
          type: "pass",
          summary: "API fallback PASS",
        },
      ],
    });

    const statuses: string[] = [];
    const reviewer = new FallbackReviewer({
      name: "architecture-reviewer",
      primary: failingCli,
      fallback: apiFallback,
      onStatus: (message) => statuses.push(message),
    });

    const result = await reviewer.review(reviewInput());

    expect(reviewer.name).toBe("architecture-reviewer");
    expect(reviewer.lastUsed).toBe("fallback");
    expect(reviewer.lastPrimaryError).toMatch(/not found|exited/i);
    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect(result.result?.summary).toMatch(/API fallback PASS/);
    expect(failingCli.callCount).toBe(1);
    expect(apiFallback.callCount).toBe(1);
    expect(statuses.some((s) => /fallback/i.test(s))).toBe(true);
  });

  it("does not call fallback when primary succeeds", async () => {
    const primary = new CliReviewer({
      name: "code-reviewer",
      transport: new MockCliTransport({ steps: [{ stdout: passJson }] }),
    });
    const fallback = new MockReviewer({
      name: "code-reviewer",
      steps: [{ type: "pass", summary: "should not run" }],
    });
    const reviewer = new FallbackReviewer({
      name: "code-reviewer",
      primary,
      fallback,
    });

    const result = await reviewer.review(reviewInput());
    expect(reviewer.lastUsed).toBe("primary");
    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect(fallback.callCount).toBe(0);
  });
});

describe("createReviewer transport wiring", () => {
  it("builds FallbackReviewer from CLI primary + API fallback", async () => {
    const transport = new MockCliTransport({
      steps: [{ code: 1, stderr: "spawn failed", stdout: "" }],
    });
    const reviewer = await createReviewer("mock", {
      name: "general-reviewer",
      transport: "cli",
      cliTransport: transport,
      fallback: {
        transport: "api",
        provider: "mock",
      },
    });

    expect(reviewer).toBeInstanceOf(FallbackReviewer);
    expect(reviewer.name).toBe("general-reviewer");

    const result = await reviewer.review(reviewInput());
    expect(result.result?.status).toBe(ReviewStatus.Pass);
    expect((reviewer as FallbackReviewer).lastUsed).toBe("fallback");
  });
});

describe("config schema transport + fallback", () => {
  it("parses reviewer transport and fallback fields", () => {
    const config = parseAssentorConfig({
      reviewers: [
        {
          provider: "claude",
          role: "architecture",
          name: "architecture-reviewer",
          transport: "cli",
          fallback: {
            transport: "api",
            provider: "openai",
            model: "gpt-4o-mini",
          },
        },
      ],
    });

    expect(config.reviewers[0]?.transport).toBe("cli");
    expect(config.reviewers[0]?.provider).toBe("claude");
    expect(config.reviewers[0]?.fallback).toEqual({
      transport: "api",
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("defaults transport to api", () => {
    const config = parseAssentorConfig({
      reviewers: [{ provider: "gemini", role: "general" }],
    });
    expect(config.reviewers[0]?.transport).toBe("api");
  });
});

describe("Google CLI reviewer", () => {
  it("maps Gemini CLI aliases to Antigravity", async () => {
    const { resolveCliAdapter } = await import("../../src/index.js");
    expect(resolveCliAdapter("antigravity")).toBe("antigravity");
    expect(resolveCliAdapter("agy")).toBe("antigravity");
    expect(resolveCliAdapter("gemini-cli")).toBe("antigravity");
  });
});
