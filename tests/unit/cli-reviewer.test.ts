import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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

// Records the args of every CLI process that createReviewer would spawn. The
// primary (model opus) fails so the fallback runs; the fallback succeeds.
const cliSpawns = vi.hoisted(() => [] as string[][]);

vi.mock("../../src/executors/cli-locator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/executors/cli-locator.js")>();
  return {
    ...actual,
    spawnCliProcess: (_command: string, args: string[]) => {
      cliSpawns.push(args);
      const fail = args.includes("opus");
      const child = new EventEmitter() as unknown as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        if (fail) {
          child.stderr.emit("data", "primary unavailable");
          child.emit("close", 1, null);
        } else {
          child.stdout.emit(
            "data",
            JSON.stringify({
              status: "PASS",
              confidence: 0.9,
              summary: "fallback PASS",
              issues: [],
              requiredChanges: [],
              optionalChanges: [],
              evidenceRequests: [],
            }),
          );
          child.emit("close", 0, null);
        }
      });
      return child;
    },
  };
});

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

describe("CLI reviewer model flag", () => {
  function captureSpawn() {
    const calls: string[][] = [];
    const spawnFn = async (request: { args: string[] }) => {
      calls.push(request.args);
      return { code: 0, stdout: passJson, stderr: "" };
    };
    return { calls, spawnFn };
  }

  it("claude gets --model after --output-format text and before the prompt", async () => {
    const { calls, spawnFn } = captureSpawn();
    await new CliReviewer({ adapter: "claude", binary: "/fake/claude", model: "opus", spawnFn }).review(
      reviewInput(),
    );
    const args = calls[0]!;
    expect(args.slice(0, 5)).toEqual(["-p", "--output-format", "text", "--model", "opus"]);
    expect(args).toHaveLength(6);
  });

  it("cursor gets --model after --output-format text and before the prompt", async () => {
    const { calls, spawnFn } = captureSpawn();
    await new CliReviewer({ adapter: "cursor", binary: "/fake/agent", model: "opus", spawnFn }).review(
      reviewInput(),
    );
    const args = calls[0]!;
    const i = args.indexOf("--model");
    expect(args.slice(i - 2, i + 2)).toEqual(["--output-format", "text", "--model", "opus"]);
    expect(i + 2).toBe(args.length - 1);
  });

  it("antigravity gets --model before the final -p= prompt", async () => {
    const { calls, spawnFn } = captureSpawn();
    await new CliReviewer({ adapter: "antigravity", binary: "/fake/agy", model: "opus", spawnFn }).review(
      reviewInput(),
    );
    const args = calls[0]!;
    expect(args.slice(0, 2)).toEqual(["--model", "opus"]);
    expect(args.at(-1)).toMatch(/^-p=/);
  });

  it("AUTO, blank, and undefined produce the same args as no model", async () => {
    for (const adapter of ["claude", "cursor", "antigravity"] as const) {
      const { calls, spawnFn } = captureSpawn();
      for (const model of [undefined, "AUTO", "   "]) {
        await new CliReviewer({ adapter, binary: "/fake/bin", model, spawnFn }).review(reviewInput());
      }
      expect(calls[0]).not.toContain("--model");
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[2]).toEqual(calls[0]);
    }
  });

  it("sends the fallback model to the fallback CLI reviewer", async () => {
    cliSpawns.length = 0;
    const reviewer = await createReviewer("claude", {
      transport: "cli",
      name: "logical",
      model: "opus",
      fallback: { transport: "cli", provider: "cursor", model: "cursor-fallback" },
    });
    const result = await reviewer.review(reviewInput());
    expect(cliSpawns).toHaveLength(2);
    expect(cliSpawns[0]).toEqual(expect.arrayContaining(["--model", "opus"]));
    expect(cliSpawns[1]).toEqual(expect.arrayContaining(["--model", "cursor-fallback"]));
    expect(result).not.toHaveProperty("error");
  });
});
