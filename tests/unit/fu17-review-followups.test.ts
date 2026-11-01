import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBudgets,
  createEmptyContract,
  createId,
  makeReviewResult,
  PanelReviewer,
  ReviewStatus,
  Severity,
  Supervisor,
  TaskState,
  type Executor,
  type Reviewer,
  type ReviewerTurnResult,
  type ReviewResult,
} from "../../packages/engine/src/index.js";
import { IssueCategory } from "../../packages/protocol/src/review-result.js";
import type { EngineEvent } from "../../packages/protocol/src/events.js";
import { parseAssentorConfig } from "../../packages/engine/src/config/schema.js";
import { reportedModel } from "../../packages/engine/src/usage/cli-usage.js";
import { unwrapClaudeJson } from "../../packages/engine/src/providers/reviewers/cli/index.js";
import { withTokens } from "../../packages/engine/src/providers/reviewers/shared/prompt.js";
import { SeatEventSink, trackReviewerSeat } from "../../packages/engine/src/orchestrator/seat-events.js";
import { DEFAULT_AGENT_PROFILES, type AgentRegistry } from "../../packages/engine/src/agents/index.js";
import type { RoutingEngine } from "../../packages/engine/src/routing/engine.js";
import { panelAdjudicator } from "../../packages/cli/src/cli/commands.js";
import { formatSeatModels } from "../../packages/cli/src/cli/usage.js";

type Issue = NonNullable<ReviewResult["issues"]>[number];

describe("FU-17 duplicate explicit reviewer ids", () => {
  it("fails validation with the path of every duplicate", () => {
    let issues: Array<{ path: Array<string | number>; message: string }> = [];
    try {
      parseAssentorConfig({
        reviewers: [
          { provider: "mock", name: "Sol" },
          { provider: "mock", name: "Luna" },
          { provider: "mock", name: " sol " },
        ],
      });
    } catch (error) {
      issues = (error as { issues: typeof issues }).issues;
    }
    expect(issues.map((i) => i.path)).toEqual([
      ["reviewers", 0, "name"],
      ["reviewers", 2, "name"],
    ]);
    expect(issues[0]!.message).toBe('duplicate reviewer name "Sol" (reviewers.0.name, reviewers.2.name)');
  });

  it("accepts distinct and unnamed reviewers", () => {
    expect(() =>
      parseAssentorConfig({ reviewers: [{ provider: "mock" }, { provider: "mock" }, { provider: "mock", name: "a" }] }),
    ).not.toThrow();
  });
});

describe("FU-17 requested vs verified model", () => {
  it("reads the model a CLI or API reply names, and nothing else", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-1-20250805" }),
      JSON.stringify({ type: "result", usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join("\n");
    expect(reportedModel(stream)).toBe("claude-opus-4-1-20250805");
    expect(reportedModel(JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-5" } }))).toBe("claude-sonnet-4-5");
    expect(
      reportedModel(
        JSON.stringify({
          type: "result",
          modelUsage: { "claude-haiku-4-5": { outputTokens: 10 }, "claude-opus-4-1": { outputTokens: 900 } },
        }),
      ),
    ).toBe("claude-opus-4-1");
    expect(reportedModel(JSON.stringify({ id: "x", model: "gpt-5-2025-08-07", choices: [] }))).toBe("gpt-5-2025-08-07");
    expect(reportedModel(JSON.stringify({ candidates: [], modelVersion: "gemini-2.5-pro" }, null, 2))).toBe("gemini-2.5-pro");
    expect(reportedModel(JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }))).toBeUndefined();
    expect(reportedModel("plain codex text\nno model here")).toBeUndefined();
    expect(reportedModel(undefined)).toBeUndefined();
  });

  it("carries the reported model out of Claude's JSON reply and an API reply", () => {
    const unwrapped = unwrapClaudeJson({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ type: "result", result: "{}", modelUsage: { "claude-opus-4-1": { outputTokens: 5 } } }),
    });
    expect(unwrapped.model).toBe("claude-opus-4-1");
    expect(withTokens({}, undefined, JSON.stringify({ model: "gpt-5-mini" })).model).toBe("gpt-5-mini");
    expect(withTokens({}, undefined, "{}").model).toBeUndefined();
  });

  function sink(): { sink: SeatEventSink; events: EngineEvent[] } {
    const events: EngineEvent[] = [];
    const s = new SeatEventSink({ sessionId: "s-fu17", onEvent: (e) => events.push(e), coalesceMs: 0 });
    return { sink: s, events };
  }
  const seat = (seatId: string, model: string, provider = "claude-code") => ({
    seatId,
    displayName: seatId,
    provider,
    transport: "cli" as const,
    model,
    role: "general",
    permissions: "read-only" as const,
  });

  it("shows both models when they differ, and says unverified when none was reported", async () => {
    const { sink: s } = sink();
    s.spawned(seat("reviewer-1", "opus"));
    s.spawned(seat("panel", "AUTO", "panel"));
    expect(s.modelFields("reviewer-1", "claude-opus-4-1")).toEqual({ reportedModel: "claude-opus-4-1", requestedModel: "opus" });
    expect(s.modelFields("reviewer-1", "OPUS")).toEqual({ reportedModel: "OPUS" });
    expect(s.modelFields("reviewer-1", undefined)).toEqual({ reportedModel: "unverified", requestedModel: "opus" });
    expect(s.modelFields("panel", "x")).toEqual({});
    await s.close();
  });

  it("puts the verified model on the executor's seat.done and a panel member's verdict", async () => {
    const { sink: s, events } = sink();
    s.spawned(seat("executor", "AUTO"));
    s.spawned(seat("reviewer-1", "sonnet"));
    s.supervisor(
      {
        type: "executor.completed",
        at: new Date().toISOString(),
        data: { status: "completed", summary: "done", rawOutput: JSON.stringify({ type: "system", model: "claude-sonnet-4-5" }) },
      },
      { executorSeatId: "executor" },
    );
    const member: Reviewer = {
      name: "m",
      review: async () => ({ result: makeReviewResult({ status: ReviewStatus.Pass, confidence: 1, summary: "ok", issues: [], requiredChanges: [], optionalChanges: [], evidenceRequests: [] }) }),
      continue: async () => ({}),
    };
    await trackReviewerSeat(member, "reviewer-1", () => s, true).review({} as never);
    await s.flush();
    const done = events.find((e) => e.type === "seat.done" && e.seatId === "executor");
    expect(done?.data).toMatchObject({ reportedModel: "claude-sonnet-4-5", requestedModel: "AUTO" });
    expect(JSON.stringify(done?.data)).not.toContain("rawOutput\"");
    const verdict = events.find((e) => e.type === "review.verdict" && e.seatId === "reviewer-1");
    expect(verdict?.data).toMatchObject({ reportedModel: "unverified", requestedModel: "sonnet" });
    await s.close();
  });

  it("formats the run summary without claiming an unverified model", () => {
    const models = new Map([
      ["executor", { name: "Claude", requested: "opus", reported: "claude-opus-4-1" }],
      ["reviewer-1", { name: "Gemini", requested: "AUTO" }],
      ["reviewer-2", { name: "OpenAI", requested: "gpt-5", reported: "GPT-5" }],
    ]);
    expect(formatSeatModels(models)).toBe(
      "Models: Claude opus → claude-opus-4-1 · Gemini AUTO (unverified) · OpenAI GPT-5",
    );
    expect(formatSeatModels(new Map())).toBeUndefined();
  });
});

describe("FU-17 adjudicator from the CLI", () => {
  const routing = {} as RoutingEngine;
  const agents = (profiles = DEFAULT_AGENT_PROFILES) => ({ list: () => profiles }) as unknown as AgentRegistry;

  it("wires the enabled adjudicator profile only for the adjudicator policy", async () => {
    const wired = await panelAdjudicator("adjudicator", "/tmp", { agents: agents(), routing });
    expect(wired.routing).toBe(routing);
    expect(wired.adjudicatorProfile?.kind).toBe("adjudicator");
    expect(await panelAdjudicator("majority", "/tmp", { agents: agents(), routing })).toEqual({});
    expect(await panelAdjudicator(undefined, "/tmp", { agents: agents(), routing })).toEqual({});
  });

  it("keeps the deterministic merge when the adjudicator profile is disabled", async () => {
    const disabled = DEFAULT_AGENT_PROFILES.map((p) => (p.kind === "adjudicator" ? { ...p, enabled: false } : p));
    expect(await panelAdjudicator("adjudicator", "/tmp", { agents: agents(disabled), routing })).toEqual({});
  });
});

const claim: Issue = {
  id: "SEC-1",
  severity: Severity.Blocker,
  category: IssueCategory.Security,
  description: "Hardcoded API token in UserService",
  requiredChange: "Remove the hardcoded token",
  evidence: [],
  affectedFiles: ["src/services/UserService.ts"],
};
const realIssue: Issue = {
  id: "BUG-1",
  severity: Severity.Major,
  category: IssueCategory.Correctness,
  description: "average() divides by zero on an empty list",
  evidence: ["src/average.ts:3 return sum / xs.length"],
  affectedFiles: ["src/average.ts"],
};

function needsWork(issues: Issue[], requiredChanges: string[]): ReviewerTurnResult {
  return {
    result: makeReviewResult({
      status: ReviewStatus.NeedsWork,
      confidence: 0.9,
      summary: "needs work",
      issues,
      requiredChanges,
      optionalChanges: [],
      evidenceRequests: [],
    }),
  };
}
const member = (name: string, turn: ReviewerTurnResult): Reviewer => ({
  name,
  review: async () => turn,
  continue: async () => turn,
});
const input = () => ({
  taskId: "t-fu17",
  projectPath: "/tmp/assentor-fu17",
  contract: createEmptyContract("Implement average()"),
  round: 1,
  artifacts: [],
});

describe("FU-17 unsupported claims inside a NEEDS_WORK merge", () => {
  it("sends only the supported findings to the executor and asks to verify the claim", async () => {
    const panel = new PanelReviewer({
      reviewers: [
        member("alpha", needsWork([realIssue], ["Guard the empty list"])),
        member("beta", needsWork([claim], ["Remove the hardcoded token", "Rotate every secret"])),
      ],
    });
    const turn = await panel.review(input());
    expect(turn.result?.status).toBe(ReviewStatus.NeedsWork);
    expect(turn.result?.issues?.map((i) => i.id)).toEqual(["BUG-1"]);
    expect(turn.result?.requiredChanges).toEqual(["Guard the empty list"]);
    expect(turn.result?.evidenceRequests).toEqual([
      expect.objectContaining({ kind: "git_diff", description: expect.stringContaining("beta: Hardcoded API token") }),
      expect.objectContaining({ kind: "files", paths: ["src/services/UserService.ts"] }),
    ]);

    // Asked once: later rounds keep the real findings without asking again.
    const again = await panel.review(input());
    expect(again.result?.status).toBe(ReviewStatus.NeedsWork);
    expect(again.result?.issues?.map((i) => i.id)).toEqual(["BUG-1"]);
    expect(again.result?.evidenceRequests).toEqual([]);
  });

  it("blocks for a human when an unsupported claim is all that is left after verification", async () => {
    const panel = new PanelReviewer({
      reviewers: [
        member("alpha", needsWork([claim], [])),
        member("beta", needsWork([{ ...claim, id: "SEC-2", description: "Token leaks into logs in UserService" }], [])),
      ],
    });
    const first = await panel.review(input());
    expect(first.result?.status).toBe(ReviewStatus.NeedsWork);
    expect(first.result?.issues).toEqual([]);
    expect(first.result?.requiredChanges).toEqual([]);
    const second = await panel.review(input());
    expect(second.result?.status).toBe(ReviewStatus.Blocked);
  });

  it("leaves an evidenced security finding in the feedback", async () => {
    const evidenced = { ...claim, evidence: ["src/services/UserService.ts:12 const token = 'abc'"] };
    const panel = new PanelReviewer({
      reviewers: [member("alpha", needsWork([realIssue], ["Guard the empty list"])), member("beta", needsWork([evidenced], ["Remove the hardcoded token"]))],
    });
    const turn = await panel.review(input());
    expect(turn.result?.issues?.map((i) => i.id).sort()).toEqual(["BUG-1", "SEC-1"]);
    expect(turn.result?.requiredChanges).toContain("Remove the hardcoded token");
  });
});

describe("FU-17 resume hint after an inconclusive panel", () => {
  const executor: Executor = {
    name: "mock-executor",
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
    run: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
    continue: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
    cancel: async () => undefined,
  };
  const pass = member("Opus#2", { result: makeReviewResult({ status: ReviewStatus.Pass, confidence: 1, summary: "ok", issues: [], requiredChanges: [], optionalChanges: [], evidenceRequests: [] }) });

  async function finish(error: string) {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "fu17-resume-"));
    try {
      const supervisor = new Supervisor({
        projectPath,
        contract: createEmptyContract("Implement average()"),
        executor,
        reviewer: new PanelReviewer({ reviewers: [member("Opus#1", { error }), pass] }),
        budgets: createBudgets({ maxRounds: 3, maxMessages: 20 }),
        taskId: createId(),
        skipGates: true,
        maxFailureRetries: 1,
      });
      return await supervisor.run();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  }

  it("tells the user to resume once retries run out", async () => {
    const run = await finish("claude CLI timed out after 300000ms");
    expect(run.status).toBe(TaskState.Failed);
    expect(run.reason).toMatch(/^Panel inconclusive: .* Resume with: assentor resume$/);
  });

  it("gives no resume hint when the failure will not clear on its own", async () => {
    const run = await finish("Invalid API key");
    expect(run.status).toBe(TaskState.Failed);
    expect(run.reason).not.toMatch(/Resume with/);
  });
});
