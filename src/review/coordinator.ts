import {
  adjudicate,
  reviewersDisagree,
  type AdjudicatorDecision,
  type ReviewerFinding,
} from "../agents/routed-reviewer.js";
import type { LogicalAgentProfile } from "../agents/index.js";
import { IssueCategory } from "../protocol/review-result.js";
import {
  makeReviewResult,
  type ReviewIssue,
  type ReviewResult,
} from "../protocol/review-result.js";
import { ReviewStatus, Severity } from "../core/types.js";
import type { RoutingEngine } from "../routing/engine.js";
import type {
  ReviewContinuation,
  Reviewer,
  ReviewerTurnResult,
  ReviewInput,
} from "../providers/reviewers/types.js";
import { MessageType, type ProtocolMessage } from "../protocol/messages.js";

export interface CorrelatedFinding {
  key: string;
  description: string;
  severity: ReviewIssue["severity"];
  category: NonNullable<ReviewIssue["category"]>;
  agentIds: string[];
  issueIds: string[];
  affectedFiles: string[];
  evidence: string[];
}

export interface ReviewCoordinatorOptions {
  reviewers: Reviewer[];
  /** Optional LLM adjudicator; when omitted, uses deterministic weighted merge. */
  routing?: RoutingEngine;
  adjudicatorProfile?: LogicalAgentProfile;
  goal?: string;
  acceptanceCriteria?: string[];
}

/**
 * Runs independent reviews, correlates overlapping issues, and produces a
 * single merged ReviewResult (debate/adjudicate on disagreement).
 */
export class ReviewCoordinator {
  private readonly reviewers: Reviewer[];
  private readonly routing?: RoutingEngine;
  private readonly adjudicatorProfile?: LogicalAgentProfile;
  private readonly goal: string;
  private readonly acceptanceCriteria: string[];

  constructor(options: ReviewCoordinatorOptions) {
    this.reviewers = [...options.reviewers];
    this.routing = options.routing;
    this.adjudicatorProfile = options.adjudicatorProfile;
    this.goal = options.goal ?? "";
    this.acceptanceCriteria = options.acceptanceCriteria ?? [];
  }

  async runIndependentReviews(
    input: ReviewInput | ReviewContinuation,
    method: "review" | "continue" = "review",
  ): Promise<{
    findings: ReviewerFinding[];
    turns: Array<{ agentId: string; turn: ReviewerTurnResult }>;
  }> {
    const turns = await Promise.all(
      this.reviewers.map(async (reviewer) => {
        const turn =
          method === "review"
            ? await reviewer.review(input as ReviewInput)
            : await reviewer.continue(input as ReviewContinuation);
        return { agentId: reviewer.name, turn };
      }),
    );

    const findings: ReviewerFinding[] = [];
    for (const { agentId, turn } of turns) {
      if (turn.result) {
        findings.push({ agentId, result: turn.result });
      }
    }
    return { findings, turns };
  }

  correlate(findings: ReviewerFinding[]): CorrelatedFinding[] {
    return correlateFindings(findings);
  }

  async decide(findings: ReviewerFinding[]): Promise<ReviewResult> {
    if (findings.length === 0) {
      return makeReviewResult({
        status: ReviewStatus.Failed,
        confidence: 1,
        summary: "No reviewer returned a structured result",
        issues: [],
        requiredChanges: [],
        optionalChanges: [],
        evidenceRequests: [],
      });
    }

    if (findings.length === 1) {
      return normalizeResult(findings[0]!.result);
    }

    const veto = securityVeto(findings);
    if (veto) {
      return veto;
    }

    if (!reviewersDisagree(findings)) {
      return mergeAgreeing(findings);
    }

    if (this.routing && this.adjudicatorProfile) {
      const evidenceSummary = findings
        .map(
          (f) =>
            `${f.agentId}: ${f.result.status} — ${(f.result.issues ?? [])
              .map((i) => i.description)
              .join("; ")}`,
        )
        .join("\n");
      const decision = await adjudicate({
        routing: this.routing,
        profile: this.adjudicatorProfile,
        goal: this.goal,
        acceptanceCriteria: this.acceptanceCriteria,
        findings,
        evidenceSummary,
      });
      if (decision.raw) {
        return applySecurityVetoToResult(normalizeResult(decision.raw), findings);
      }
      return decisionToResult(decision.decision, decision.summary, findings);
    }

    return weightedMerge(findings);
  }
}

/**
 * Reviewer that fans out to multiple independent reviewers and merges.
 * Least-invasive multi-reviewer adapter for Supervisor (single Reviewer slot).
 */
export class PanelReviewer implements Reviewer {
  readonly name: string;
  private readonly coordinator: ReviewCoordinator;
  private readonly members: Reviewer[];
  callCount = 0;

  constructor(
    options: ReviewCoordinatorOptions & {
      name?: string;
    },
  ) {
    this.name = options.name ?? "panel";
    this.members = [...options.reviewers];
    this.coordinator = new ReviewCoordinator(options);
  }

  get memberNames(): string[] {
    return this.members.map((m) => m.name);
  }

  async review(input: ReviewInput): Promise<ReviewerTurnResult> {
    return this.turn(input, "review");
  }

  async continue(input: ReviewContinuation): Promise<ReviewerTurnResult> {
    return this.turn(input, "continue");
  }

  private async turn(
    input: ReviewInput | ReviewContinuation,
    method: "review" | "continue",
  ): Promise<ReviewerTurnResult> {
    this.callCount += 1;
    const { findings, turns } = await this.coordinator.runIndependentReviews(
      input,
      method,
    );

    const errors = turns.filter((t) => t.turn.error && !t.turn.result);
    if (errors.length === turns.length && turns.length > 0) {
      return {
        error: errors.map((e) => `${e.agentId}: ${e.turn.error}`).join("; "),
        rawOutput: errors.map((e) => e.turn.rawOutput).filter(Boolean).join("\n"),
      };
    }

    const communication = collectCommunication(turns);
    const anyConclusive = findings.length > 0;
    if (communication.length > 0 && !anyConclusive) {
      return { messages: communication };
    }

    // Prefer fulfilling evidence when any member asks and none issued hard fail
    const evidenceOnly = findings.filter(
      (f) =>
        f.result.status === ReviewStatus.NeedsWork &&
        (f.result.evidenceRequests?.length ?? 0) > 0 &&
        (f.result.requiredChanges?.length ?? 0) === 0 &&
        (f.result.issues?.length ?? 0) === 0,
    );
    if (
      evidenceOnly.length > 0 &&
      findings.every(
        (f) =>
          f.result.status === ReviewStatus.Pass ||
          evidenceOnly.some((e) => e.agentId === f.agentId),
      )
    ) {
      const mergedRequests = evidenceOnly.flatMap(
        (f) => f.result.evidenceRequests ?? [],
      );
      return {
        result: makeReviewResult({
          status: ReviewStatus.NeedsWork,
          confidence: averageConfidence(findings),
          summary: "Panel needs additional evidence before deciding",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: dedupeEvidenceRequests(mergedRequests),
        }),
        messages: communication.length > 0 ? communication : undefined,
      };
    }

    const result = await this.coordinator.decide(findings);
    return {
      result,
      messages: communication.length > 0 ? communication : undefined,
      rawOutput: JSON.stringify({
        panel: this.name,
        members: turns.map((t) => ({
          agentId: t.agentId,
          status: t.turn.result?.status ?? "error",
          summary: t.turn.result?.summary ?? t.turn.error,
        })),
        correlated: this.coordinator.correlate(findings),
      }),
    };
  }
}

export function correlateFindings(
  findings: ReviewerFinding[],
): CorrelatedFinding[] {
  type ResultIssue = NonNullable<ReviewResult["issues"]>[number];
  type Item = { agentId: string; issue: ResultIssue };
  const items: Item[] = [];
  for (const finding of findings) {
    for (const issue of finding.result.issues ?? []) {
      items.push({ agentId: finding.agentId, issue });
    }
  }

  const clusters: CorrelatedFinding[] = [];
  const used = new Set<number>();

  for (let i = 0; i < items.length; i += 1) {
    if (used.has(i)) continue;
    const seed = items[i]!;
    const group = [seed];
    used.add(i);

    for (let j = i + 1; j < items.length; j += 1) {
      if (used.has(j)) continue;
      const other = items[j]!;
      if (issuesLikelySame(seed.issue, other.issue)) {
        group.push(other);
        used.add(j);
      }
    }

    const files = [
      ...new Set(group.flatMap((g) => g.issue.affectedFiles ?? [])),
    ];
    const evidence = [...new Set(group.flatMap((g) => g.issue.evidence ?? []))];
    const severities = group.map((g) => g.issue.severity);
    clusters.push({
      key: clusterKey(seed.issue),
      description: seed.issue.description,
      severity: maxSeverity(severities),
      category: seed.issue.category ?? IssueCategory.Other,
      agentIds: [...new Set(group.map((g) => g.agentId))],
      issueIds: group.map((g) => g.issue.id),
      affectedFiles: files,
      evidence,
    });
  }

  return clusters;
}

export function securityVeto(
  findings: ReviewerFinding[],
): ReviewResult | undefined {
  const securityIssues = findings.flatMap((f) =>
    (f.result.issues ?? [])
      .filter(
        (issue) =>
          issue.category === IssueCategory.Security &&
          (issue.severity === Severity.Blocker ||
            issue.severity === Severity.Major),
      )
      .map((issue) => ({ agentId: f.agentId, issue })),
  );

  const securityBlocked = findings.filter(
    (f) =>
      f.result.status === ReviewStatus.Blocked &&
      (f.agentId.includes("security") ||
        (f.result.issues ?? []).some(
          (i) => i.category === IssueCategory.Security,
        )),
  );

  const majorityPass =
    findings.filter((f) => f.result.status === ReviewStatus.Pass).length >
    findings.length / 2;

  if (
    (securityIssues.length > 0 || securityBlocked.length > 0) &&
    majorityPass
  ) {
    const issues = securityIssues.map((s) => s.issue);
    for (const blocked of securityBlocked) {
      for (const issue of blocked.result.issues ?? []) {
        issues.push(issue);
      }
    }
    return makeReviewResult({
      status: ReviewStatus.NeedsWork,
      confidence: 0.95,
      summary:
        "Security veto: blocker/critical security findings override majority PASS",
      issues:
        issues.length > 0
          ? issues
          : [
              {
                id: "SEC-VETO",
                severity: Severity.Blocker,
                category: IssueCategory.Security,
                description:
                  securityBlocked[0]?.result.summary ??
                  "Security reviewer blocked the change",
                evidence: [],
              },
            ],
      requiredChanges: [
        ...new Set(
          findings.flatMap((f) => f.result.requiredChanges ?? []),
        ),
      ],
      optionalChanges: [],
      evidenceRequests: [],
    });
  }

  return undefined;
}

function applySecurityVetoToResult(
  result: ReviewResult,
  findings: ReviewerFinding[],
): ReviewResult {
  if (result.status !== ReviewStatus.Pass) {
    return result;
  }
  return securityVeto(findings) ?? result;
}

function weightedMerge(findings: ReviewerFinding[]): ReviewResult {
  const veto = securityVeto(findings);
  if (veto) return veto;

  const statuses = findings.map((f) => f.result.status);
  if (statuses.includes(ReviewStatus.Failed)) {
    return mergeStatus(ReviewStatus.Failed, findings, "Panel: reviewer failed");
  }
  if (statuses.includes(ReviewStatus.Blocked)) {
    return mergeStatus(ReviewStatus.Blocked, findings, "Panel: reviewer blocked");
  }
  if (statuses.includes(ReviewStatus.NeedsWork)) {
    return mergeStatus(
      ReviewStatus.NeedsWork,
      findings,
      "Panel: changes required after correlation",
    );
  }
  return mergeAgreeing(findings);
}

function mergeAgreeing(findings: ReviewerFinding[]): ReviewResult {
  const status = findings[0]!.result.status;
  return mergeStatus(
    status,
    findings,
    findings.map((f) => f.result.summary).join(" | "),
  );
}

function mergeStatus(
  status: ReviewResult["status"],
  findings: ReviewerFinding[],
  summary: string,
): ReviewResult {
  const correlated = correlateFindings(findings);
  const issues: ReviewIssue[] =
    status === ReviewStatus.Pass
      ? []
      : correlated.map((c, idx) => ({
          id: c.issueIds[0] ?? `CORR-${idx + 1}`,
          severity: c.severity,
          category: c.category,
          description:
            c.agentIds.length > 1
              ? `${c.description} (correlated: ${c.agentIds.join(", ")})`
              : c.description,
          evidence: c.evidence,
          affectedFiles: c.affectedFiles,
        }));

  // Preserve uncategorized issues that did not cluster (already in correlated)
  const allIssueIds = new Set(issues.map((i) => i.id));
  if (status !== ReviewStatus.Pass) {
    for (const finding of findings) {
      for (const issue of finding.result.issues ?? []) {
        if (!allIssueIds.has(issue.id)) {
          // already represented via correlate; skip duplicates by id
        }
      }
    }
  }

  const requiredChanges = [
    ...new Set(findings.flatMap((f) => f.result.requiredChanges ?? [])),
  ];
  const optionalChanges = [
    ...new Set(findings.flatMap((f) => f.result.optionalChanges ?? [])),
  ];
  const evidenceRequests = dedupeEvidenceRequests(
    findings.flatMap((f) => f.result.evidenceRequests ?? []),
  );

  if (status === ReviewStatus.Pass) {
    return makeReviewResult({
      status,
      confidence: averageConfidence(findings),
      summary: truncate(summary, 500),
      issues: [],
      requiredChanges: [],
      optionalChanges,
      evidenceRequests: [],
    });
  }

  return makeReviewResult({
    status,
    confidence: averageConfidence(findings),
    summary: truncate(summary, 500),
    issues,
    requiredChanges:
      requiredChanges.length > 0
        ? requiredChanges
        : issues.length > 0
          ? issues.map((i) => i.requiredChange ?? i.description)
          : evidenceRequests.length > 0
            ? []
            : ["Address panel findings"],
    optionalChanges,
    evidenceRequests,
  });
}

function decisionToResult(
  decision: AdjudicatorDecision,
  summary: string,
  findings: ReviewerFinding[],
): ReviewResult {
  const map: Record<AdjudicatorDecision, ReviewResult["status"]> = {
    PASS: ReviewStatus.Pass,
    NEEDS_WORK: ReviewStatus.NeedsWork,
    MORE_EVIDENCE: ReviewStatus.NeedsWork,
    BLOCKED: ReviewStatus.Blocked,
  };
  const status = map[decision];
  const base = mergeStatus(status, findings, summary);
  if (decision === "MORE_EVIDENCE") {
    const requests = dedupeEvidenceRequests(
      findings.flatMap((f) => f.result.evidenceRequests ?? []),
    );
    return makeReviewResult({
      ...base,
      status: ReviewStatus.NeedsWork,
      evidenceRequests:
        requests.length > 0
          ? requests
          : [{ kind: "file", path: ".", description: "Provide more evidence" }],
      requiredChanges: [],
      issues: base.issues ?? [],
    });
  }
  return applySecurityVetoToResult(base, findings);
}

function issuesLikelySame(
  a: NonNullable<ReviewResult["issues"]>[number],
  b: NonNullable<ReviewResult["issues"]>[number],
): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const catA = a.category ?? IssueCategory.Other;
  const catB = b.category ?? IssueCategory.Other;
  if (catA !== catB) return false;

  const filesA = new Set((a.affectedFiles ?? []).map((f) => f.toLowerCase()));
  const filesB = (b.affectedFiles ?? []).map((f) => f.toLowerCase());
  const fileOverlap =
    filesA.size === 0 || filesB.length === 0
      ? false
      : filesB.some((f) => filesA.has(f));

  const tokensA = tokenize(a.description);
  const tokensB = tokenize(b.description);
  const overlap = jaccard(tokensA, tokensB);

  if (fileOverlap && overlap >= 0.2) return true;
  if (overlap >= 0.4) return true;
  if (
    a.requiredChange &&
    b.requiredChange &&
    jaccard(tokenize(a.requiredChange), tokenize(b.requiredChange)) >= 0.35
  ) {
    return true;
  }
  // Shared distinctive stems (bypass/repositor/etc.) + same category
  const stemsA = new Set(tokensA.map(stem));
  const stemsB = tokensB.map(stem);
  const stemHits = stemsB.filter((t) => stemsA.has(t) && t.length >= 5).length;
  if (fileOverlap && stemHits >= 2) return true;
  return false;
}

function stem(token: string): string {
  return token.replace(/(ing|tion|tions|ies|ied|ed|es|s)$/i, "");
}

function clusterKey(issue: NonNullable<ReviewResult["issues"]>[number]): string {
  const files = (issue.affectedFiles ?? []).map((f) => f.toLowerCase()).sort();
  return [
    issue.category ?? "other",
    files.join(","),
    tokenize(issue.description).slice(0, 6).join("-"),
  ].join("|");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/.-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function maxSeverity(
  severities: Array<ReviewIssue["severity"]>,
): ReviewIssue["severity"] {
  const order = [
    Severity.Blocker,
    Severity.Major,
    Severity.Minor,
    Severity.Info,
  ] as const;
  for (const s of order) {
    if (severities.includes(s)) return s;
  }
  return Severity.Major;
}

function averageConfidence(findings: ReviewerFinding[]): number {
  if (findings.length === 0) return 0.5;
  const sum = findings.reduce((acc, f) => acc + (f.result.confidence ?? 0.5), 0);
  return Math.min(1, Math.max(0, sum / findings.length));
}

function normalizeResult(result: ReviewResult): ReviewResult {
  return makeReviewResult(result);
}

function collectCommunication(
  turns: Array<{ agentId: string; turn: ReviewerTurnResult }>,
): ProtocolMessage[] {
  const out: ProtocolMessage[] = [];
  for (const { turn } of turns) {
    for (const message of turn.messages ?? []) {
      if (
        message.type === MessageType.EvidenceRequest ||
        message.type === MessageType.Question ||
        message.type === MessageType.InvestigationRequest ||
        message.type === MessageType.TestRequest ||
        message.type === MessageType.BuildRequest ||
        message.type === MessageType.ClarificationRequest
      ) {
        out.push(message);
      }
    }
  }
  return out;
}

function dedupeEvidenceRequests<T extends { kind: string; path?: string; command?: string; query?: string }>(
  requests: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const req of requests) {
    const key = `${req.kind}|${req.path ?? ""}|${req.command ?? ""}|${req.query ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(req);
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
