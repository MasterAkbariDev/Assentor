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
  securityVeto,
  Severity,
  Supervisor,
  TaskState,
  type Executor,
  type Reviewer,
  type ReviewerTurnResult,
  type ReviewResult,
} from "../../packages/engine/src/index.js";
import { IssueCategory } from "../../packages/protocol/src/review-result.js";
import { MessageType } from "../../packages/protocol/src/messages.js";
import { createProtocolMessage } from "../../packages/protocol/src/parse.js";
import type { LogicalAgentProfile } from "../../packages/engine/src/agents/index.js";
import type { RoutingEngine } from "../../packages/engine/src/routing/engine.js";

/** An adjudicator that always rules PASS — the path that used to clear a lone security dissent. */
function passingAdjudicator(): { routing: RoutingEngine; adjudicatorProfile: LogicalAgentProfile } {
  const routing = {
    generate: async () => ({
      response: {
        text: JSON.stringify({
          status: "PASS",
          confidence: 0.8,
          summary: "adjudicator: looks fine",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      },
    }),
  } as unknown as RoutingEngine;
  const adjudicatorProfile = { id: "adjudicator", routing: "BALANCED" } as unknown as LogicalAgentProfile;
  return { routing, adjudicatorProfile };
}

type Issue = NonNullable<ReviewResult["issues"]>[number];

function result(status: ReviewResult["status"], issues: Issue[] = [], extra: Partial<ReviewResult> = {}): ReviewResult {
  return makeReviewResult({
    status,
    confidence: 0.9,
    summary: `${status} summary`,
    issues,
    requiredChanges: status === ReviewStatus.NeedsWork && issues.length > 0 ? ["fix it"] : [],
    optionalChanges: [],
    evidenceRequests: [],
    ...extra,
  });
}

function member(name: string, turn: () => Promise<ReviewerTurnResult> | ReviewerTurnResult): Reviewer {
  return { name, review: async () => turn(), continue: async () => turn() };
}

const passes = (name: string) => member(name, () => ({ result: result(ReviewStatus.Pass) }));
const fails = (name: string, error = "claude CLI timed out after 300000ms") =>
  member(name, () => ({ error }));

function input() {
  return {
    taskId: "t-panel",
    projectPath: "/tmp/assentor-panel",
    contract: createEmptyContract("Implement average()"),
    round: 1,
    artifacts: [],
  };
}

const securityIssue = (evidenced: boolean): Issue => ({
  id: "SEC-1",
  severity: Severity.Blocker,
  category: IssueCategory.Security,
  description: "Hardcoded API token in UserService",
  evidence: evidenced ? ["src/services/UserService.ts:12 const token = 'abc'"] : [],
  affectedFiles: evidenced ? ["src/services/UserService.ts"] : [],
});

describe("PanelReviewer member failures", () => {
  it("two failures and one PASS do not PASS: the turn is inconclusive and retryable", async () => {
    const panel = new PanelReviewer({
      name: "panel",
      reviewers: [fails("Opus#1"), passes("Opus#2"), fails("Opus#3", "rate limit 429")],
    });
    const turn = await panel.review(input());

    expect(turn.result).toBeUndefined();
    expect(turn.retryable).toBe(true);
    expect(turn.error).toMatch(/^Panel inconclusive: 1 of 3 reviewers returned a result/);
    expect(turn.error).toContain("Opus#1 failed: claude CLI timed out");
    expect(turn.error).toContain("Opus#2 PASS");
    const raw = JSON.parse(turn.rawOutput!);
    expect(raw.members.map((m: { status: string }) => m.status)).toEqual(["error", "PASS", "error"]);
  });

  it("treats a FAILED verdict as a failed member, even when an adjudicator would PASS", async () => {
    const failedVerdict = (name: string) =>
      member(name, () => ({
        result: makeReviewResult({
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: "could not read the evidence pack",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      }));
    for (const reviewers of [
      [passes("A"), passes("B"), failedVerdict("C")],
      [passes("A"), failedVerdict("B"), failedVerdict("C")],
    ]) {
      const panel = new PanelReviewer({ ...passingAdjudicator(), reviewers });
      const turn = await panel.review(input());
      expect(turn.result).toBeUndefined();
      expect(turn.error).toMatch(/^Panel inconclusive/);
      expect(turn.error).toContain("failed: could not read the evidence pack");
    }
  });

  it("records a throwing or malformed member instead of rejecting the panel", async () => {
    const throwing = member("Thrower", () => {
      throw new Error("socket hang up");
    });
    const malformed = member("Empty", () => ({}));
    const panel = new PanelReviewer({ reviewers: [passes("A"), throwing, malformed] });

    const turn = await panel.review(input());
    expect(turn.result).toBeUndefined();
    expect(turn.error).toContain("Thrower failed: socket hang up");
    expect(turn.error).toContain("Empty failed: returned no structured result");
    expect(turn.retryable).toBe(true);
  });

  it("is not retryable when a member failed on authentication", async () => {
    const panel = new PanelReviewer({
      reviewers: [passes("A"), fails("B", "Invalid API key (401)")],
    });
    const turn = await panel.review(input());
    expect(turn.result).toBeUndefined();
    expect(turn.retryable).toBe(false);
  });

  it("keeps a NEEDS_WORK that rests on real findings, counting agreement over all members", async () => {
    const issue: Issue = {
      id: "C-1",
      severity: Severity.Major,
      category: IssueCategory.Correctness,
      description: "average() divides by zero on an empty array",
      evidence: ["src/average.ts:3"],
      affectedFiles: ["src/average.ts"],
    };
    const panel = new PanelReviewer({
      reviewers: [
        member("A", () => ({ result: result(ReviewStatus.NeedsWork, [issue]) })),
        fails("B"),
        fails("C"),
      ],
    });
    const turn = await panel.review(input());
    expect(turn.result?.status).toBe(ReviewStatus.NeedsWork);
    const raw = JSON.parse(turn.rawOutput!);
    expect(raw.correlated[0].agreement).toEqual({ count: 1, total: 3, ratio: 1 / 3 });
  });

  it("waits for a member that is still asking for evidence before it can PASS", async () => {
    const question = createProtocolMessage({
      conversationId: "c",
      round: 1,
      from: "reviewer",
      to: "executor",
      type: MessageType.EvidenceRequest,
      content: { requests: [{ kind: "git_diff" }], reason: "need the diff" },
    });
    const panel = new PanelReviewer({
      reviewers: [passes("A"), member("B", () => ({ messages: [question] }))],
    });
    const turn = await panel.review(input());
    expect(turn.result).toBeUndefined();
    expect(turn.error).toBeUndefined();
    expect(turn.messages).toHaveLength(1);
  });

  it("still passes when every member passes, and with a single member", async () => {
    const full = new PanelReviewer({ reviewers: [passes("A"), passes("B"), passes("C")] });
    expect((await full.review(input())).result?.status).toBe(ReviewStatus.Pass);
    const solo = new PanelReviewer({ reviewers: [passes("A")] });
    expect((await solo.review(input())).result?.status).toBe(ReviewStatus.Pass);
  });

  it("gives members with the same name distinct ids", async () => {
    const panel = new PanelReviewer({ reviewers: [passes("mock"), fails("mock")] });
    const turn = await panel.review(input());
    expect(turn.error).toContain("mock PASS");
    expect(turn.error).toContain("mock#2 failed");
  });
});

describe("security authority", () => {
  it("an evidenced minority security blocker survives an adjudicated PASS, whatever the reviewer is called", async () => {
    const panel = new PanelReviewer({
      ...passingAdjudicator(),
      reviewers: [
        passes("alpha"),
        member("gamma", () => ({ result: result(ReviewStatus.NeedsWork, [securityIssue(true)]) })),
      ],
    });
    const turn = await panel.review(input());
    expect(turn.result?.status).toBe(ReviewStatus.NeedsWork);
    expect(turn.result?.summary).toMatch(/^Security veto: .*gamma/);
    expect(turn.result?.issues?.map((i) => i.id)).toEqual(["SEC-1"]);
  });

  it("vetoes without a majority-PASS precondition", () => {
    const veto = securityVeto([
      { agentId: "alpha", result: result(ReviewStatus.Pass) },
      { agentId: "beta", result: result(ReviewStatus.NeedsWork, [securityIssue(true)]) },
    ]);
    expect(veto?.status).toBe(ReviewStatus.NeedsWork);
  });

  it("an unevidenced severe security claim asks for verification once, then blocks for a human", async () => {
    const claim = { ...securityIssue(false), affectedFiles: ["src/services/UserService.ts"] };
    const panel = new PanelReviewer({
      ...passingAdjudicator(),
      reviewers: [
        passes("alpha"),
        member("beta", () => ({ result: result(ReviewStatus.NeedsWork, [claim]) })),
      ],
    });
    const first = await panel.review(input());
    expect(first.result?.status).toBe(ReviewStatus.NeedsWork);
    expect(first.result?.summary).toMatch(/^Unverified security claim blocks PASS; .*beta/);
    // Evidence only: nothing for the executor to change yet. A file list alone is not evidence.
    expect(first.result?.requiredChanges).toEqual([]);
    expect(first.result?.issues).toEqual([]);
    expect(first.result?.evidenceRequests).toEqual([
      expect.objectContaining({ kind: "git_diff" }),
      expect.objectContaining({ kind: "files", paths: ["src/services/UserService.ts"] }),
    ]);

    const second = await panel.review(input());
    expect(second.result?.status).toBe(ReviewStatus.Blocked);
    expect(second.result?.summary).toMatch(/^Unverified security claim still unsupported after verification/);
  });
});

describe("Supervisor with an inconclusive panel", () => {
  function executor(): Executor {
    return {
      name: "mock-executor",
      capabilities: () => ({
        canEditFiles: true,
        canRunCommands: true,
        canContinueSession: true,
        supportsScreenshots: false,
      }),
      run: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
      continue: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
      cancel: async () => undefined,
    };
  }

  it("never finishes as passed when most reviewers failed", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "panel-failure-"));
    try {
      const supervisor = new Supervisor({
        projectPath,
        contract: createEmptyContract("Implement average()"),
        executor: executor(),
        reviewer: new PanelReviewer({
          reviewers: [fails("Opus#1", "Invalid API key"), passes("Opus#2"), fails("Opus#3", "Invalid API key")],
        }),
        budgets: createBudgets({ maxRounds: 3, maxMessages: 20 }),
        taskId: createId(),
        skipGates: true,
        maxFailureRetries: 1,
      });
      const run = await supervisor.run();
      expect(run.status).not.toBe(TaskState.Done);
      expect(run.events.some((e) => e.type === "review.completed")).toBe(false);
      // Inconclusive is not NEEDS_WORK: the executor ran once and was never sent back.
      expect(run.events.filter((e) => e.type === "executor.started")).toHaveLength(1);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it("stops for a human, with the reason, when a security claim stays unsupported", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "panel-claim-"));
    try {
      const supervisor = new Supervisor({
        projectPath,
        contract: createEmptyContract("Implement average()"),
        executor: executor(),
        reviewer: new PanelReviewer({
          ...passingAdjudicator(),
          reviewers: [
            passes("alpha"),
            member("beta", () => ({ result: result(ReviewStatus.NeedsWork, [securityIssue(false)]) })),
          ],
        }),
        budgets: createBudgets({ maxRounds: 3, maxMessages: 20 }),
        taskId: createId(),
        skipGates: true,
      });
      const run = await supervisor.run();
      expect(run.status).toBe(TaskState.HumanRequired);
      expect(run.reason).toMatch(/Unverified security claim still unsupported/);
      expect(run.events.filter((e) => e.type === "executor.started")).toHaveLength(1);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
