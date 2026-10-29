import { describe, expect, it, vi } from "vitest";
import {
  makeReviewResult,
  PanelReviewer,
  ReviewStatus,
  Severity,
  type Reviewer,
  type ReviewerTurnResult,
  type ReviewResult,
} from "../../src/index.js";
import { ReviewCoordinator, type ReviewPolicy } from "../../src/review/coordinator.js";
import { IssueCategory } from "../../src/protocol/review-result.js";
import { createEmptyContract } from "../../src/index.js";
import { MessageType } from "../../src/protocol/messages.js";
import { createProtocolMessage } from "../../src/protocol/parse.js";
import type { ReviewerFinding } from "../../src/agents/routed-reviewer.js";
import type { LogicalAgentProfile } from "../../src/agents/index.js";
import type { RoutingEngine } from "../../src/routing/engine.js";

type Issue = NonNullable<ReviewResult["issues"]>[number];
type Verdict = "PASS" | "NEEDS_WORK" | "BLOCKED" | "FAIL" | "ASK";

const POLICIES: ReviewPolicy[] = ["security-veto", "unanimous", "majority", "weighted", "adjudicator"];

const securityMajor: Issue = {
  id: "SEC-1",
  severity: Severity.Major,
  category: IssueCategory.Security,
  description: "SQL built from request input",
  evidence: ["src/db.ts:10 query(`select ${id}`)"],
  affectedFiles: ["src/db.ts"],
};

function result(status: ReviewResult["status"], issues: Issue[] = []): ReviewResult {
  return makeReviewResult({
    status,
    confidence: 0.9,
    summary: `${status} summary`,
    issues,
    requiredChanges: status === ReviewStatus.NeedsWork ? ["fix it"] : [],
    optionalChanges: [],
    evidenceRequests: [],
  });
}

const askForDiff = createProtocolMessage({
  conversationId: "c",
  round: 1,
  from: "reviewer",
  to: "executor",
  type: MessageType.EvidenceRequest,
  content: { requests: [{ kind: "git_diff" }], reason: "need the diff" },
});

function member(name: string, verdict: Verdict, issues: Issue[] = []): Reviewer {
  const turn = (): ReviewerTurnResult =>
    verdict === "FAIL"
      ? { error: "claude CLI timed out" }
      : verdict === "ASK"
        ? { messages: [askForDiff] }
        : { result: result(verdict as ReviewResult["status"], issues) };
  return { name, review: async () => turn(), continue: async () => turn() };
}

function panelInput() {
  return {
    taskId: "t-policy",
    projectPath: "/tmp/assentor-policy",
    contract: createEmptyContract("Implement thing"),
    round: 1,
    artifacts: [],
  };
}

function build(
  policy: ReviewPolicy,
  seats: Array<[Verdict, Issue[]?]>,
  extra: Partial<ConstructorParameters<typeof PanelReviewer>[0]> = {},
) {
  return new PanelReviewer({
    policy,
    reviewers: seats.map(([verdict, issues], i) => member(`M${i + 1}`, verdict, issues)),
    ...extra,
  });
}

async function outcome(
  policy: ReviewPolicy,
  seats: Array<[Verdict, Issue[]?]>,
  extra: Partial<ConstructorParameters<typeof PanelReviewer>[0]> = {},
): Promise<string> {
  const turn = await build(policy, seats, extra).review(panelInput());
  return turn.result ? turn.result.status : "INCONCLUSIVE";
}

const P: [Verdict] = ["PASS"];
const N: [Verdict] = ["NEEDS_WORK"];
const B: [Verdict] = ["BLOCKED"];
const F: [Verdict] = ["FAIL"];
const ASK: [Verdict] = ["ASK"];
const blockerEvidenced: Issue = {
  id: "BLK-1",
  severity: Severity.Blocker,
  category: IssueCategory.Correctness,
  description: "Migration drops the users table",
  evidence: ["db/001.sql:3 DROP TABLE users"],
  affectedFiles: ["db/001.sql"],
};
const minorObjection: Issue = {
  id: "MIN-1",
  severity: Severity.Minor,
  category: IssueCategory.Maintainability,
  description: "Rename helper for clarity",
  evidence: [],
  affectedFiles: [],
};

describe("panel decision policies", () => {
  // expected status per policy, in POLICIES order
  const table: Array<{
    name: string;
    seats: Array<[Verdict, Issue[]?]>;
    expected: Record<ReviewPolicy, string>;
  }> = [
    {
      name: "all pass",
      seats: [P, P, P],
      expected: { "security-veto": "PASS", unanimous: "PASS", majority: "PASS", weighted: "PASS", adjudicator: "PASS" },
    },
    {
      name: "split 2 pass / 1 needs work",
      seats: [P, P, N],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "PASS", weighted: "PASS", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "tie 1 pass / 1 needs work",
      seats: [P, N],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "NEEDS_WORK", weighted: "NEEDS_WORK", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "evidenced security major raised by one of three",
      seats: [P, ["NEEDS_WORK", [securityMajor]], P],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "NEEDS_WORK", weighted: "NEEDS_WORK", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "one blocked, two pass (a vote never clears BLOCKED)",
      seats: [P, B, P],
      expected: { "security-veto": "BLOCKED", unanimous: "BLOCKED", majority: "BLOCKED", weighted: "BLOCKED", adjudicator: "BLOCKED" },
    },
    {
      name: "two blocked, one pass",
      seats: [B, P, B],
      expected: { "security-veto": "BLOCKED", unanimous: "BLOCKED", majority: "BLOCKED", weighted: "BLOCKED", adjudicator: "BLOCKED" },
    },
    {
      name: "three-way split",
      seats: [P, N, B],
      expected: { "security-veto": "BLOCKED", unanimous: "BLOCKED", majority: "BLOCKED", weighted: "BLOCKED", adjudicator: "BLOCKED" },
    },
    {
      name: "single seat passes",
      seats: [P],
      expected: { "security-veto": "PASS", unanimous: "PASS", majority: "PASS", weighted: "PASS", adjudicator: "PASS" },
    },
    {
      name: "single seat needs work",
      seats: [N],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "NEEDS_WORK", weighted: "NEEDS_WORK", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "member failure with the rest passing is inconclusive",
      seats: [P, P, F],
      expected: {
        "security-veto": "INCONCLUSIVE",
        unanimous: "INCONCLUSIVE",
        majority: "INCONCLUSIVE",
        weighted: "INCONCLUSIVE",
        adjudicator: "INCONCLUSIVE",
      },
    },
    {
      name: "evidenced blocker (not security) from a dissenter beside a PASS majority",
      seats: [P, ["NEEDS_WORK", [blockerEvidenced]], P],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "NEEDS_WORK", weighted: "NEEDS_WORK", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "pass, needs work and a failed member: the vote is undecided, so inconclusive for votes",
      seats: [P, N, F],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "INCONCLUSIVE", weighted: "INCONCLUSIVE", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "pass, needs work and a member still asking: the vote is undecided",
      seats: [P, N, ASK],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "INCONCLUSIVE", weighted: "INCONCLUSIVE", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "missing member cannot change the vote (two needs work, one failed)",
      seats: [N, N, F],
      expected: { "security-veto": "NEEDS_WORK", unanimous: "NEEDS_WORK", majority: "NEEDS_WORK", weighted: "NEEDS_WORK", adjudicator: "NEEDS_WORK" },
    },
    {
      name: "member failure never rescues a majority of passes",
      seats: [P, F, F],
      expected: {
        "security-veto": "INCONCLUSIVE",
        unanimous: "INCONCLUSIVE",
        majority: "INCONCLUSIVE",
        weighted: "INCONCLUSIVE",
        adjudicator: "INCONCLUSIVE",
      },
    },
  ];

  for (const row of table) {
    describe(row.name, () => {
      for (const policy of POLICIES) {
        it(`${policy} → ${row.expected[policy]}`, async () => {
          expect(await outcome(policy, row.seats)).toBe(row.expected[policy]);
        });
      }
    });
  }

  it("default policy is security-veto with an unchanged summary", async () => {
    const explicit = await build("security-veto", [P, N]).review(panelInput());
    const implicit = await new PanelReviewer({ reviewers: [member("M1", "PASS"), member("M2", "NEEDS_WORK")] }).review(
      panelInput(),
    );
    expect(implicit.result).toEqual(explicit.result);
    expect(implicit.result!.summary).toBe("Panel: changes required after correlation");
  });

  it("lists per-seat verdicts in the summary of non-default policies", async () => {
    const turn = await build("majority", [P, P, N]).review(panelInput());
    expect(turn.result!.summary).toMatch(/^Panel \[majority\] M1 PASS, M2 PASS, M3 NEEDS_WORK\./);
  });

  it("weighted: a security-role seat outweighs one ordinary seat but not two", async () => {
    const roles = ["security-reviewer", "code-reviewer", "code-reviewer"];
    // security NEEDS_WORK (2) vs two PASS (2): tie → NEEDS_WORK, where plain majority would PASS
    expect(await outcome("weighted", [N, P, P], { roles })).toBe("NEEDS_WORK");
    expect(await outcome("majority", [N, P, P], { roles })).toBe("PASS");
    // security PASS (2) + one PASS (1) outweighs one NEEDS_WORK (1)
    expect(await outcome("weighted", [P, P, N], { roles })).toBe("PASS");
    // overridden weights
    expect(
      await outcome("weighted", [N, P, P], { roles, roleWeights: { "security-reviewer": 1 } }),
    ).toBe("PASS");
  });

  it("a PASS majority drops a dissenter's minor objection but keeps an evidenced blocker", async () => {
    const minor = await build("majority", [P, P, ["NEEDS_WORK", [minorObjection]]]).review(panelInput());
    expect(minor.result!.status).toBe(ReviewStatus.Pass);
    expect(minor.result!.issues).toEqual([]);

    const blocker = await build("majority", [P, P, ["NEEDS_WORK", [blockerEvidenced]]]).review(panelInput());
    expect(blocker.result!.status).toBe(ReviewStatus.NeedsWork);
    expect(blocker.result!.issues!.map((i) => i.id)).toContain("BLK-1");
    expect(blocker.result!.requiredChanges!.length).toBeGreaterThan(0);
  });

  it("weighted: a missing heavy seat keeps the vote undecided; a missing light one does not", async () => {
    // security seat (2) failed: P(1) vs N(1) with 2 missing could be decided either way
    const heavyMissing = ["security-reviewer", "code-reviewer", "code-reviewer"];
    expect(await outcome("weighted", [F, P, N], { roles: heavyMissing })).toBe("INCONCLUSIVE");
    // light seat failed: N(3 of 4) already wins whatever the missing seat says
    expect(await outcome("weighted", [N, N, F], { roles: heavyMissing })).toBe("NEEDS_WORK");
  });

  it("weighted: rejects non-positive weights", () => {
    expect(
      () => new ReviewCoordinator({ reviewers: [], roleWeights: { x: 0 } }),
    ).toThrow(/positive number/);
  });

  it("weighted follows duplicate member ids (#2, #3) to their own weights", async () => {
    const coordinator = new ReviewCoordinator({
      policy: "weighted",
      reviewers: [member("Opus", "PASS"), member("Opus", "PASS"), member("Opus", "NEEDS_WORK")],
      roles: ["code-reviewer", "code-reviewer", "security-reviewer"],
    });
    const { findings } = await coordinator.runIndependentReviews(panelInput());
    // Opus#3 is the security seat (2): 2 vs 2 tie → NEEDS_WORK
    expect((await coordinator.decide(findings)).status).toBe(ReviewStatus.NeedsWork);
  });
});

describe("adjudicator", () => {
  const profile = { id: "adjudicator", routing: "BALANCED" } as unknown as LogicalAgentProfile;
  const routing = {
    generate: async () => ({
      response: {
        text: JSON.stringify({
          status: "PASS",
          confidence: 0.8,
          summary: "adjudicator: fine",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      },
    }),
  } as unknown as RoutingEngine;

  it("rules on a split for security-veto and adjudicator, but not for the other policies", async () => {
    const seats: Array<[Verdict]> = [P, N];
    const withJudge = { routing, adjudicatorProfile: profile };
    expect(await outcome("security-veto", seats, withJudge)).toBe("PASS");
    expect(await outcome("adjudicator", seats, withJudge)).toBe("PASS");
    expect(await outcome("unanimous", seats, withJudge)).toBe("NEEDS_WORK");
    expect(await outcome("majority", seats, withJudge)).toBe("NEEDS_WORK");
  });

  it("an adjudicator PASS still loses to an evidenced security finding", async () => {
    const seats: Array<[Verdict, Issue[]?]> = [P, ["NEEDS_WORK", [securityMajor]]];
    expect(await outcome("adjudicator", seats, { routing, adjudicatorProfile: profile })).toBe("NEEDS_WORK");
  });

  it("an adjudicator PASS cannot hide a failed member", async () => {
    expect(
      await outcome("adjudicator", [P, N, F], { routing, adjudicatorProfile: profile }),
    ).toBe("INCONCLUSIVE");
  });

  it("without an adjudicator it falls back to the most severe verdict and says so", async () => {
    const turn = await build("adjudicator", [P, B]).review(panelInput());
    expect(turn.result!.status).toBe(ReviewStatus.Blocked);
    expect(turn.result!.summary).toContain("No adjudicator configured");
  });
});

describe("onDisagreement (negotiate tiebreak)", () => {
  const negotiatedPass = result(ReviewStatus.Pass);

  it("is consulted on a split when tiebreak is negotiate, for every policy but unanimous", async () => {
    for (const policy of POLICIES.filter((p) => p !== "unanimous")) {
      const onDisagreement = vi.fn(async (_findings: ReviewerFinding[]) => negotiatedPass);
      const status = await outcome(policy, [P, N], { tiebreak: "negotiate", onDisagreement });
      expect(status, policy).toBe("PASS");
      expect(onDisagreement).toHaveBeenCalledTimes(1);
      expect(onDisagreement.mock.calls[0]![0]).toHaveLength(2);
    }
  });

  it("is not consulted without a disagreement or with the adjudicator tiebreak", async () => {
    const onDisagreement = vi.fn(async () => negotiatedPass);
    await outcome("majority", [P, P], { tiebreak: "negotiate", onDisagreement });
    await outcome("majority", [P, N], { tiebreak: "adjudicator", onDisagreement });
    await outcome("majority", [P, N], { onDisagreement });
    expect(onDisagreement).not.toHaveBeenCalled();
  });

  it("falls back to the policy when it returns nothing or throws", async () => {
    expect(
      await outcome("unanimous", [P, N], { tiebreak: "negotiate", onDisagreement: async () => undefined }),
    ).toBe("NEEDS_WORK");
    expect(
      await outcome("unanimous", [P, N], {
        tiebreak: "negotiate",
        onDisagreement: async () => {
          throw new Error("negotiation crashed");
        },
      }),
    ).toBe("NEEDS_WORK");
  });

  it("a negotiated PASS still loses to an evidenced security finding and to a failed member", async () => {
    const hook = { tiebreak: "negotiate" as const, onDisagreement: async () => negotiatedPass };
    expect(await outcome("majority", [P, ["NEEDS_WORK", [securityMajor]]], hook)).toBe("NEEDS_WORK");
    expect(await outcome("majority", [P, N, F], hook)).toBe("INCONCLUSIVE");
  });
});

describe("onDisagreement and security claims", () => {
  const unevidencedClaim: Issue = { ...securityMajor, id: "SEC-U", evidence: [], affectedFiles: ["src/db.ts"] };
  const hook = {
    tiebreak: "negotiate" as const,
    onDisagreement: async () => result(ReviewStatus.Pass),
  };

  it("a negotiated PASS over an unevidenced security claim asks for the diff once, then blocks", async () => {
    for (const policy of ["majority", "weighted", "adjudicator"] as const) {
      const panel = build(policy, [P, ["NEEDS_WORK", [unevidencedClaim]]], hook);
      const first = await panel.review(panelInput());
      expect(first.result!.status, policy).toBe(ReviewStatus.NeedsWork);
      expect(first.result!.evidenceRequests!.length, policy).toBeGreaterThan(0);
      expect(first.result!.summary).toContain("Unverified security claim");

      const second = await panel.review(panelInput());
      expect(second.result!.status, policy).toBe(ReviewStatus.Blocked);
      expect(second.result!.summary).toContain("a human must decide");
    }
  });

  it("unanimous never consults the hook", async () => {
    const onDisagreement = vi.fn(async (_f: ReviewerFinding[]) => result(ReviewStatus.Pass));
    expect(await outcome("unanimous", [P, N], { tiebreak: "negotiate", onDisagreement })).toBe("NEEDS_WORK");
    expect(onDisagreement).not.toHaveBeenCalled();
  });

  it("a FAILED hook result is ignored", async () => {
    const failed = makeReviewResult({
      status: ReviewStatus.Failed,
      confidence: 1,
      summary: "negotiation could not run",
      issues: [],
      requiredChanges: [],
      optionalChanges: [],
      evidenceRequests: [],
    });
    expect(
      await outcome("majority", [P, N], { tiebreak: "negotiate", onDisagreement: async () => failed }),
    ).toBe("NEEDS_WORK");
  });
});

describe("onDisagreement may not clear a member's BLOCKED or evidenced blocker (T02-09)", () => {
  const hook = { tiebreak: "negotiate" as const, onDisagreement: async () => result(ReviewStatus.Pass) };
  const evidencedBlocker: Issue = {
    id: "COR-1",
    severity: Severity.Blocker,
    category: IssueCategory.Correctness,
    description: "Deletes user data on retry",
    evidence: ["src/sync.ts:42 rm(dir)"],
    affectedFiles: ["src/sync.ts"],
  };

  it("a negotiated PASS over a BLOCKED member falls back to the policy", async () => {
    for (const policy of ["majority", "weighted", "adjudicator", "security-veto"] as const) {
      expect(await outcome(policy, [P, ["BLOCKED"]], hook), policy).toBe("BLOCKED");
    }
  });

  it("a negotiated PASS over an evidenced non-security blocker falls back to the policy", async () => {
    for (const policy of ["majority", "weighted"] as const) {
      expect(await outcome(policy, [P, ["NEEDS_WORK", [evidencedBlocker]]], hook), policy).toBe("NEEDS_WORK");
    }
  });

  it("a negotiated non-PASS over a BLOCKED member still stands", async () => {
    const needsWork = { tiebreak: "negotiate" as const, onDisagreement: async () => result(ReviewStatus.NeedsWork) };
    expect(await outcome("majority", [P, ["BLOCKED"]], needsWork)).toBe("NEEDS_WORK");
  });
});
