import { describe, expect, it } from "vitest";
import {
  createBudgets,
  createEmptyContract,
  createId,
  PanelReviewer,
  parseEngineEvent,
  ReviewStatus,
  SeatEventSink,
  Severity,
  Supervisor,
  trackReviewerSeat,
  type EngineEvent,
  type Executor,
  type Reviewer,
  type ReviewerTurnResult,
} from "../../packages/engine/src/index.js";
import { IssueCategory } from "../../packages/protocol/src/review-result.js";

const parse = (type: string, data: Record<string, unknown>, seatId?: string): EngineEvent =>
  parseEngineEvent({ seq: 1, sessionId: "s", at: "2026-10-31T10:00:00.000Z", type, data, ...(seatId ? { seatId } : {}) });

describe("FU-08 event schemas: old shapes still parse, new fields are optional", () => {
  it("negotiation.consensus: threshold is optional", () => {
    const old = parse("negotiation.consensus", { round: 1, score: 0.4, reached: false });
    expect(old.data).not.toHaveProperty("threshold");
    expect(parse("negotiation.consensus", { round: 1, score: 0.8, reached: true, threshold: 0.7 }).data).toMatchObject({ threshold: 0.7 });
    expect(() => parse("negotiation.consensus", { round: 1, score: 0.8, reached: true, threshold: 2 })).toThrow();
  });

  it("negotiation.decided needs a rationale and may name a winner", () => {
    expect(parse("negotiation.decided", { rationale: "judge chose B", winner: "Proposal B" }).data).toMatchObject({ winner: "Proposal B" });
    expect(parse("negotiation.decided", { rationale: "synthesized" }).data).toEqual({ rationale: "synthesized" });
    expect(() => parse("negotiation.decided", {})).toThrow();
  });

  it("negotiation.proposal keeps its author on the envelope, and parses without one", () => {
    const withSeat = parse("negotiation.proposal", { round: 1, label: "Proposal A", text: "x" }, "opus-1");
    expect(withSeat.seatId).toBe("opus-1");
    expect(parse("negotiation.proposal", { round: 1, label: "Proposal A", text: "x" }).seatId).toBeUndefined();
  });

  it("review.verdict: policy and panelMember are optional", () => {
    expect(parse("review.verdict", { status: "PASS" }, "panel").data).toEqual({ status: "PASS" });
    expect(
      parse("review.verdict", { status: "PASS", confidence: 0.9, policy: "majority", panelMember: true }, "reviewer-1").data,
    ).toMatchObject({ policy: "majority", panelMember: true });
  });

  it("review.finding: reviewerIds, category and evidence are optional, and the new strings are capped", () => {
    const base = { key: "k", description: "d", severity: "major" };
    expect(parse("review.finding", base).data).not.toHaveProperty("reviewerIds");
    expect(parse("review.finding", { ...base, category: "security", evidence: ["a.ts:1"] }).data).toMatchObject({ category: "security" });
    expect(() => parse("review.finding", { ...base, evidence: Array(21).fill("x") })).toThrow();
    expect(() => parse("negotiation.decided", { rationale: "x".repeat(4001) })).toThrow();
    expect(() => parse("review.verdict", { status: "PASS", policy: "x".repeat(65) })).toThrow();
    expect(parse("review.finding", { ...base, reviewerIds: ["a", "b"], agreement: { count: 2, total: 3 } }).data).toMatchObject({
      reviewerIds: ["a", "b"],
    });
  });
});

function executor(): Executor {
  return {
    name: "mock-executor",
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
    run: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
    continue: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
    cancel: async () => undefined,
  };
}

function reviewer(name: string, status: ReviewStatus, confidence: number, withIssue: boolean): Reviewer {
  const turn = (): ReviewerTurnResult => ({
    result: {
      status,
      confidence,
      summary: `${name} says ${status}`,
      issues: withIssue
        ? [
            {
              id: `${name}-1`,
              severity: Severity.Major,
              category: IssueCategory.Correctness,
              description: "Token compared with ==",
              affectedFiles: ["src/auth.ts"],
              evidence: ["src/auth.ts:12"],
            },
          ]
        : [],
      requiredChanges: [],
      optionalChanges: [],
      evidenceRequests: [],
    },
  });
  return { name, review: async () => turn(), continue: async () => turn() };
}

async function run(members: Reviewer[]): Promise<EngineEvent[]> {
  const engine: EngineEvent[] = [];
  const sink = new SeatEventSink({ sessionId: createId(), onEvent: (event) => engine.push(event) });
  const tracked = members.map((m, i) => trackReviewerSeat(m, `reviewer-${i + 1}`, () => sink, members.length > 1));
  const single = tracked.length === 1;
  await new Supervisor({
    projectPath: process.cwd(),
    contract: createEmptyContract("Implement average()"),
    executor: executor(),
    reviewer: single ? tracked[0]! : new PanelReviewer({ name: "panel", reviewers: tracked, policy: "majority", memberSeatIds: tracked.map((_, i) => `reviewer-${i + 1}`) }),
    budgets: createBudgets({ maxRounds: 1, maxMessages: 20 }),
    taskId: sink.sessionId,
    skipGates: true,
    seatEvents: sink,
    seatScope: { executorSeatId: "executor", reviewerSeatId: single ? "reviewer-1" : "panel" },
    maxFailureRetries: 0,
  }).run();
  await sink.close();
  return engine;
}

describe("FU-08 review events from a panel", () => {
  it("emits one verdict per member plus the merged one, with the policy, and a finding with agreement", async () => {
    const events = await run([
      reviewer("Claude", ReviewStatus.NeedsWork, 0.7, true),
      reviewer("Gemini", ReviewStatus.Pass, 0.9, false),
      reviewer("Codex", ReviewStatus.NeedsWork, 0.6, true),
    ]);
    const verdicts = events.filter((e) => e.type === "review.verdict");

    const members = verdicts.filter((e) => e.data.panelMember);
    expect(members.map((e) => [e.seatId, e.data.status, e.data.confidence]).sort()).toEqual([
      ["reviewer-1", "NEEDS_WORK", 0.7],
      ["reviewer-2", "PASS", 0.9],
      ["reviewer-3", "NEEDS_WORK", 0.6],
    ]);

    // Exactly one merged verdict, from the panel seat, and it is the one that carries the legacy marker the reporter prints on.
    const merged = verdicts.filter((e) => !e.data.panelMember);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.seatId).toBe("panel");
    expect(merged[0]!.data).toMatchObject({ status: "NEEDS_WORK", policy: "majority", legacyType: "review.completed" });
    expect(verdicts.filter((e) => (e.data as { legacyType?: string }).legacyType === "review.completed")).toHaveLength(1);

    const findings = events.filter((e) => e.type === "review.finding");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.seatId).toBe("panel");
    expect(findings[0]!.data).toMatchObject({
      severity: "major",
      affectedFiles: ["src/auth.ts"],
      agreement: { count: 2, total: 3 },
    });
    // Seat ids, not names, and the issue's category and evidence come along.
    expect([...findings[0]!.data.reviewerIds!].sort()).toEqual(["reviewer-1", "reviewer-3"]);
    expect(findings[0]!.data).toMatchObject({ category: "correctness", evidence: ["src/auth.ts:12"] });
  });

  it("names two members with the same name by their own seat ids", async () => {
    const events = await run([
      reviewer("claude", ReviewStatus.Pass, 0.9, false),
      reviewer("claude", ReviewStatus.NeedsWork, 0.7, true),
    ]);
    const finding = events.find((e) => e.type === "review.finding");
    expect(finding?.data).toMatchObject({ reviewerIds: ["reviewer-2"], agreement: { count: 1, total: 2 } });
  });

  it("a single reviewer keeps one verdict, no policy and no findings", async () => {
    const events = await run([reviewer("Claude", ReviewStatus.NeedsWork, 0.7, true)]);
    const verdicts = events.filter((e) => e.type === "review.verdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.data).not.toHaveProperty("policy");
    expect(verdicts[0]!.data).not.toHaveProperty("panelMember");
    expect(events.some((e) => e.type === "review.finding")).toBe(false);
  });

  it("a failed member reports no verdict of its own", async () => {
    const broken: Reviewer = {
      name: "Broken",
      review: async () => ({ error: "timed out", retryable: true }),
      continue: async () => ({ error: "timed out", retryable: true }),
    };
    const events = await run([reviewer("Claude", ReviewStatus.Pass, 0.9, false), broken]);
    const members = events.filter((e) => e.type === "review.verdict" && e.data.panelMember);
    expect(members.map((e) => e.seatId)).toEqual(["reviewer-1"]);
  });
});
