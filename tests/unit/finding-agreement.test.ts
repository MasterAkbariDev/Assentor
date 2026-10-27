import { describe, expect, it } from "vitest";
import * as engine from "../../src/index.js";
import {
  IssueCategory,
  ReviewStatus,
  Severity,
  makeReviewResult,
} from "../../src/index.js";
import {
  correlateFindings,
  rankCorrelatedFindings,
  type CorrelatedFinding,
} from "../../src/review/coordinator.js";

function reviewWith(issues: Array<{ id: string; severity: string; category: string; file: string; description: string }>) {
  return makeReviewResult({
    status: issues.length > 0 ? ReviewStatus.NeedsWork : ReviewStatus.Pass,
    confidence: 0.9,
    summary: "review",
    issues: issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity as never,
      category: issue.category as never,
      description: issue.description,
      affectedFiles: [issue.file],
      evidence: [],
    })),
    requiredChanges: [],
    optionalChanges: [],
    evidenceRequests: [],
  });
}

const authIssue = {
  id: "auth-42",
  severity: Severity.Major,
  category: IssueCategory.Security,
  file: "src/auth.ts",
  description: "Token is compared with ==",
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function cluster(
  key: string,
  severity: CorrelatedFinding["severity"],
  count: number,
): CorrelatedFinding {
  return {
    key,
    description: key,
    severity,
    category: IssueCategory.Correctness,
    agentIds: Array.from({ length: count }, (_, i) => `agent-${i}`),
    issueIds: [],
    affectedFiles: [],
    evidence: [],
    agreement: { count, total: 5, ratio: count / 5 },
  };
}

describe("finding agreement counts", () => {
  it("3 of 4 reviewers flagging the same issue gives 3/4 = 0.75", () => {
    const correlated = correlateFindings([
      { agentId: "a", result: reviewWith([authIssue]) },
      { agentId: "b", result: reviewWith([authIssue]) },
      { agentId: "c", result: reviewWith([authIssue]) },
      { agentId: "d", result: reviewWith([]) },
    ]);

    expect(correlated).toHaveLength(1);
    expect(correlated[0]!.agreement).toEqual({ count: 3, total: 4, ratio: 0.75 });
  });

  it("a single reviewer gives 1/1", () => {
    const correlated = correlateFindings([{ agentId: "solo", result: reviewWith([authIssue]) }]);

    expect(correlated[0]!.agreement).toEqual({ count: 1, total: 1, ratio: 1 });
  });

  it("total counts distinct reviewers across all clusters, not per cluster", () => {
    const otherIssue = {
      id: "perf-7",
      severity: Severity.Minor,
      category: IssueCategory.Performance,
      file: "src/cache.ts",
      description: "Unbounded cache growth",
    };
    const correlated = correlateFindings([
      { agentId: "a", result: reviewWith([authIssue]) },
      { agentId: "b", result: reviewWith([authIssue]) },
      { agentId: "c", result: reviewWith([otherIssue]) },
      { agentId: "d", result: reviewWith([]) },
    ]);

    const byKey = new Map(correlated.map((c) => [c.key, c.agreement]));
    const agreements = [...byKey.values()];
    expect(agreements).toHaveLength(2);
    expect(agreements.every((a) => a.total === 4)).toBe(true);
    expect(agreements.map((a) => a.count).sort()).toEqual([1, 2]);
  });

  it("ranks most severe first, then agreement desc, then key asc, without mutating the input", () => {
    const list = deepFreeze([
      cluster("a", Severity.Minor, 3),
      cluster("z", Severity.Blocker, 1),
      cluster("m", Severity.Blocker, 2),
      cluster("b", Severity.Blocker, 2),
      cluster("x", Severity.Major, 5),
    ]);
    const before = list.map((c) => c.key);

    const ranked = rankCorrelatedFindings(list);

    expect(ranked).not.toBe(list);
    expect(ranked.map((c) => c.key)).toEqual(["b", "m", "z", "x", "a"]);
    expect(list.map((c) => c.key)).toEqual(before);
  });

  it("returns an empty array for no findings", () => {
    const empty = deepFreeze([] as CorrelatedFinding[]);

    expect(rankCorrelatedFindings(empty)).toEqual([]);
    expect(correlateFindings([])).toEqual([]);
  });
});

describe("package exports", () => {
  it("exposes rankCorrelatedFindings from src/index.js as the same function", () => {
    expect(engine.rankCorrelatedFindings).toBe(rankCorrelatedFindings);
  });
});
