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
import {
  EvidenceKind,
  MessageType,
  type ProtocolMessage,
} from "../protocol/messages.js";

/**
 * What one panel member did in a turn. Every configured member gets one, so a
 * failure is recorded instead of silently shrinking the panel.
 */
export type MemberOutcome =
  | { agentId: string; kind: "result"; result: ReviewResult }
  /** Asked for evidence or a clarification without concluding. */
  | { agentId: string; kind: "pending"; messages: ProtocolMessage[] }
  /** Threw, errored, or returned nothing usable. */
  | { agentId: string; kind: "failed"; error: string; retryable: boolean };

/** Auth/permission problems do not go away on retry; everything else may. */
const NON_RETRYABLE_MEMBER_ERROR =
  /\bauth(?:entication|orization)?\b|unauthori[sz]ed|api key|invalid key|permission denied|\b40[13]\b/i;

export interface CorrelatedFinding {
  key: string;
  description: string;
  severity: ReviewIssue["severity"];
  category: NonNullable<ReviewIssue["category"]>;
  agentIds: string[];
  issueIds: string[];
  affectedFiles: string[];
  evidence: string[];
  /** How many reviewers flagged this finding, out of all configured reviewers. */
  agreement: { count: number; total: number; ratio: number };
}

/**
 * How member verdicts combine (`modes.review.policy`). Whatever the policy,
 * a member that failed can never produce a PASS (`PanelReviewer` makes that
 * turn inconclusive) and an evidenced blocker/major security finding always
 * vetoes a PASS.
 *
 * - `security-veto` (default): unanimous agreement stands; on disagreement an
 *   adjudicator rules when one is configured, else the most severe verdict wins.
 * - `unanimous`: PASS only if every answering member passes; any BLOCKED
 *   blocks; otherwise NEEDS_WORK. Never adjudicates.
 * - `majority`: the verdict with more than half of the answering members wins;
 *   no majority (ties, three-way splits) is NEEDS_WORK. A dissenting member's
 *   non-security objections do not survive a PASS majority.
 * - `weighted`: like `majority`, with each member weighted by its seat role
 *   (`security*` roles weigh 2, others 1, overridable with `roleWeights`).
 * - `adjudicator`: on any disagreement the adjudicator rules. Without one
 *   configured it falls back to the most severe verdict, and says so.
 */
export const REVIEW_POLICIES = [
  "security-veto",
  "unanimous",
  "majority",
  "weighted",
  "adjudicator",
] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/** Weight of a seat role under the `weighted` policy when not overridden. */
export function defaultRoleWeight(role: string): number {
  return /security/i.test(role) ? 2 : 1;
}

export interface DecideOptions {
  totalReviewers?: number;
  /**
   * Keys of unevidenced security claims already sent for verification.
   * The same claim coming back unsupported blocks for a human instead of
   * asking again. Updated in place.
   */
  verificationRequested?: Set<string>;
}

export interface ReviewCoordinatorOptions {
  reviewers: Reviewer[];
  /** Optional LLM adjudicator; when omitted, uses deterministic weighted merge. */
  routing?: RoutingEngine;
  adjudicatorProfile?: LogicalAgentProfile;
  goal?: string;
  acceptanceCriteria?: string[];
  /** Decision policy; default `security-veto`. */
  policy?: ReviewPolicy;
  /** Seat role of each reviewer, same order as `reviewers` (used by `weighted`). Missing = weight 1. */
  roles?: string[];
  /** Role → weight overrides for `weighted`; each must be a positive number. */
  roleWeights?: Record<string, number>;
  /** `modes.review.tiebreak`; `negotiate` consults `onDisagreement` first. Default `adjudicator`. */
  tiebreak?: "adjudicator" | "negotiate";
  /**
   * Called on a split panel when `tiebreak` is `negotiate` (implemented by the
   * negotiate mode, T02-09). A returned result replaces the policy's merge but
   * still goes through the security veto. `undefined` (or a throw) falls back
   * to the policy.
   */
  onDisagreement?: (findings: ReviewerFinding[]) => Promise<ReviewResult | undefined>;
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
  private readonly policy: ReviewPolicy;
  private readonly tiebreak: "adjudicator" | "negotiate";
  private readonly onDisagreement?: ReviewCoordinatorOptions["onDisagreement"];
  /** Member id (as in `runIndependentReviews`) → weight. */
  private readonly memberWeights = new Map<string, number>();

  constructor(options: ReviewCoordinatorOptions) {
    this.reviewers = [...options.reviewers];
    this.routing = options.routing;
    this.adjudicatorProfile = options.adjudicatorProfile;
    this.goal = options.goal ?? "";
    this.acceptanceCriteria = options.acceptanceCriteria ?? [];
    this.policy = options.policy ?? "security-veto";
    this.tiebreak = options.tiebreak ?? "adjudicator";
    this.onDisagreement = options.onDisagreement;

    for (const [role, weight] of Object.entries(options.roleWeights ?? {})) {
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`roleWeights["${role}"] must be a positive number, got ${weight}`);
      }
    }
    const ids = uniqueMemberIds(this.reviewers.map((reviewer) => reviewer.name));
    ids.forEach((id, index) => {
      const role = options.roles?.[index];
      this.memberWeights.set(
        id,
        role === undefined
          ? 1
          : (options.roleWeights?.[role] ?? defaultRoleWeight(role)),
      );
    });
  }

  /** Number of configured reviewers (the panel size, whether or not they answer). */
  get size(): number {
    return this.reviewers.length;
  }

  /**
   * Run every reviewer. A reviewer that throws is recorded as a failed member,
   * never a panel-wide rejection. Members with the same name get `#2`, `#3`…
   * so agreement counts and outcomes stay per member.
   */
  async runIndependentReviews(
    input: ReviewInput | ReviewContinuation,
    method: "review" | "continue" = "review",
  ): Promise<{
    findings: ReviewerFinding[];
    turns: Array<{ agentId: string; turn: ReviewerTurnResult }>;
    outcomes: MemberOutcome[];
  }> {
    const ids = uniqueMemberIds(this.reviewers.map((reviewer) => reviewer.name));
    const settled = await Promise.allSettled(
      this.reviewers.map((reviewer) =>
        method === "review"
          ? reviewer.review(input as ReviewInput)
          : reviewer.continue(input as ReviewContinuation),
      ),
    );

    const turns = settled.map((entry, index) => ({
      agentId: ids[index]!,
      turn:
        entry.status === "fulfilled"
          ? entry.value
          : ({ error: errorText(entry.reason) } satisfies ReviewerTurnResult),
    }));

    const findings: ReviewerFinding[] = [];
    const outcomes: MemberOutcome[] = [];
    for (const { agentId, turn } of turns) {
      // A FAILED verdict is the reviewer saying it could not review: an
      // operational failure, not a finding.
      if (turn.result?.status === ReviewStatus.Failed) {
        const error = turn.result.summary || "reviewer returned FAILED";
        outcomes.push({
          agentId,
          kind: "failed",
          error,
          retryable: !NON_RETRYABLE_MEMBER_ERROR.test(error),
        });
        continue;
      }
      if (turn.result) {
        findings.push({ agentId, result: turn.result });
        outcomes.push({ agentId, kind: "result", result: turn.result });
        continue;
      }
      const communication = collectCommunication([{ agentId, turn }]);
      if (!turn.error && communication.length > 0) {
        outcomes.push({ agentId, kind: "pending", messages: communication });
        continue;
      }
      const error = turn.error ?? "returned no structured result";
      outcomes.push({
        agentId,
        kind: "failed",
        error,
        retryable: !NON_RETRYABLE_MEMBER_ERROR.test(error),
      });
    }
    return { findings, turns, outcomes };
  }

  correlate(findings: ReviewerFinding[]): CorrelatedFinding[] {
    return correlateFindings(findings, this.reviewers.length);
  }

  /**
   * Merge member results. `totalReviewers` (default: the configured panel
   * size) is the denominator for agreement counts. Whatever the merge says,
   * a PASS never survives an evidenced blocker/major security finding, and an
   * unevidenced one turns the PASS into a verification request.
   */
  async decide(
    findings: ReviewerFinding[],
    options: DecideOptions = {},
  ): Promise<ReviewResult> {
    const outcome = await this.decideOutcome(findings, options);
    return (
      outcome.result ??
      makeReviewResult({
        status: ReviewStatus.Failed,
        confidence: 1,
        summary: outcome.inconclusive ?? "Panel inconclusive",
        issues: [],
        requiredChanges: [],
        optionalChanges: [],
        evidenceRequests: [],
      })
    );
  }

  /**
   * Like `decide`, but a vote that members who did not answer (failed or
   * pending) could still change comes back as `inconclusive` instead of a
   * result, so the caller can retry rather than send a guess to the executor.
   */
  async decideOutcome(
    findings: ReviewerFinding[],
    options: DecideOptions = {},
  ): Promise<{ result?: ReviewResult; inconclusive?: string }> {
    if (findings.length === 0) {
      return {
        result: makeReviewResult({
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: "No reviewer returned a structured result",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      };
    }
    const total = options.totalReviewers ?? (this.reviewers.length || undefined);
    const base = await this.mergeFindings(findings, total);
    if ("inconclusive" in base) {
      return base;
    }
    const result = enforceSecurityAuthority(base, findings, options.verificationRequested);
    return {
      result:
        this.policy === "security-veto" ? result : labelVerdicts(this.policy, findings, result),
    };
  }

  /** Weight of configured members that have no finding (failed, pending or absent). */
  private missingWeight(findings: ReviewerFinding[]): number {
    const answered = new Set(findings.map((f) => f.agentId));
    let missing = 0;
    for (const [id, weight] of this.memberWeights) {
      if (!answered.has(id)) missing += weight;
    }
    return missing;
  }

  private async mergeFindings(
    findings: ReviewerFinding[],
    total: number | undefined,
  ): Promise<ReviewResult | { inconclusive: string }> {
    if (findings.length === 1) {
      return normalizeResult(findings[0]!.result);
    }

    if (!reviewersDisagree(findings)) {
      return mergeAgreeing(findings, total);
    }

    // `unanimous` never lets anyone but the members decide.
    if (this.tiebreak === "negotiate" && this.onDisagreement && this.policy !== "unanimous") {
      try {
        const negotiated = await this.onDisagreement(findings);
        // A FAILED negotiation is an operational failure, not a ruling.
        if (negotiated && negotiated.status !== ReviewStatus.Failed) {
          return normalizeResult(negotiated);
        }
      } catch {
        // A failed negotiation falls back to the policy; it never decides.
      }
    }

    switch (this.policy) {
      case "unanimous":
        return weightedMerge(findings, total);
      case "majority":
        return voteMerge(findings, total, () => 1, this.missingWeight(findings));
      case "weighted":
        return voteMerge(
          findings,
          total,
          (id) => this.memberWeights.get(id) ?? 1,
          this.missingWeight(findings),
        );
      case "adjudicator":
      case "security-veto":
        break;
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
        return normalizeResult(decision.raw);
      }
      return decisionToResult(decision.decision, decision.summary, findings, total);
    }

    const merged = weightedMerge(findings, total);
    return this.policy === "adjudicator"
      ? makeReviewResult({
          ...merged,
          summary: truncate(`No adjudicator configured; most severe verdict wins. ${merged.summary}`, 500),
        })
      : merged;
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
  /** Unevidenced security claims already sent for verification in this task. */
  private readonly verificationRequested = new Set<string>();
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
    const { findings, turns, outcomes } = await this.coordinator.runIndependentReviews(
      input,
      method,
    );
    const failed = outcomes.filter(
      (o): o is Extract<MemberOutcome, { kind: "failed" }> => o.kind === "failed",
    );
    const pending = outcomes.filter((o) => o.kind === "pending");
    const rawOutput = (correlated: CorrelatedFinding[]) =>
      JSON.stringify({
        panel: this.name,
        members: outcomes.map(describeOutcomeForRaw),
        correlated,
      });

    if (failed.length === outcomes.length && outcomes.length > 0) {
      return {
        error: failed.map((f) => `${f.agentId}: ${f.error}`).join("; "),
        retryable: failed.every((f) => f.retryable),
        rawOutput: turns.map((t) => t.turn.rawOutput).filter(Boolean).join("\n"),
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

    const decided = await this.coordinator.decideOutcome(findings, {
      totalReviewers: outcomes.length,
      verificationRequested: this.verificationRequested,
    });
    // A vote that failed or pending members could still change is not a
    // verdict: same path as a PASS with failed members.
    if (decided.inconclusive !== undefined || !decided.result) {
      if (failed.length === 0) {
        return { messages: communication };
      }
      return {
        error: inconclusiveSummary(outcomes),
        retryable: failed.every((f) => f.retryable),
        rawOutput: rawOutput(this.coordinator.correlate(findings)),
      };
    }
    const result = decided.result;

    // PASS needs every configured member. Members still asking get their
    // evidence first; failed members make the turn inconclusive. That is an
    // operational problem, so it is retried rather than sent to the executor
    // as NEEDS_WORK. Non-PASS results stand: they rest on real findings.
    if (result.status === ReviewStatus.Pass && (failed.length > 0 || pending.length > 0)) {
      if (failed.length === 0) {
        return { messages: communication };
      }
      return {
        error: inconclusiveSummary(outcomes),
        retryable: failed.every((f) => f.retryable),
        rawOutput: rawOutput(this.coordinator.correlate(findings)),
      };
    }

    return {
      result,
      messages: communication.length > 0 ? communication : undefined,
      rawOutput: rawOutput(this.coordinator.correlate(findings)),
    };
  }
}

function uniqueMemberIds(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}#${count}`;
  });
}

function errorText(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.trim() || "reviewer threw";
}

function describeOutcomeForRaw(outcome: MemberOutcome) {
  switch (outcome.kind) {
    case "result":
      return {
        agentId: outcome.agentId,
        status: outcome.result.status,
        summary: outcome.result.summary,
      };
    case "pending":
      return { agentId: outcome.agentId, status: "pending", summary: "asked for evidence" };
    case "failed":
      return { agentId: outcome.agentId, status: "error", summary: outcome.error };
  }
}

function inconclusiveSummary(outcomes: MemberOutcome[]): string {
  const answered = outcomes.filter((o) => o.kind === "result").length;
  const parts = outcomes.map((o) =>
    o.kind === "result"
      ? `${o.agentId} ${o.result.status}`
      : o.kind === "pending"
        ? `${o.agentId} asked for evidence`
        : `${o.agentId} failed: ${truncate(o.error, 160)}`,
  );
  return `Panel inconclusive: ${answered} of ${outcomes.length} reviewers returned a result (${parts.join("; ")})`;
}

/**
 * Group overlapping issues across reviewers. `totalReviewers` is the agreement
 * denominator: pass the configured panel size so a reviewer that failed still
 * counts. It never goes below the number of distinct reviewers in `findings`.
 */
export function correlateFindings(
  findings: ReviewerFinding[],
  totalReviewers?: number,
): CorrelatedFinding[] {
  type ResultIssue = NonNullable<ReviewResult["issues"]>[number];
  type Item = { agentId: string; issue: ResultIssue };
  const items: Item[] = [];
  for (const finding of findings) {
    for (const issue of finding.result.issues ?? []) {
      items.push({ agentId: finding.agentId, issue });
    }
  }

  const totalAgents = Math.max(
    totalReviewers ?? 0,
    new Set(findings.map((f) => f.agentId)).size,
  );
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
    const agentIds = [...new Set(group.map((g) => g.agentId))];
    clusters.push({
      key: clusterKey(seed.issue),
      description: seed.issue.description,
      severity: maxSeverity(severities),
      category: seed.issue.category ?? IssueCategory.Other,
      agentIds,
      agreement: agreementOf(agentIds.length, totalAgents),
      issueIds: group.map((g) => g.issue.id),
      affectedFiles: files,
      evidence,
    });
  }

  return clusters;
}

/**
 * Most severe first, then most agreement first, then key ascending.
 * Returns a new array; the input is not modified.
 */
export function rankCorrelatedFindings(
  list: CorrelatedFinding[],
): CorrelatedFinding[] {
  return [...list].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.agreement.count - a.agreement.count ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

type ResultIssue = NonNullable<ReviewResult["issues"]>[number];
type SecurityClaim = { agentId: string; issue: ResultIssue };

/** Blocker/major security issues from every reviewer, whatever its own verdict. */
function securityClaims(findings: ReviewerFinding[]): SecurityClaim[] {
  return findings.flatMap((f) =>
    (f.result.issues ?? [])
      .filter(
        (issue) =>
          issue.category === IssueCategory.Security &&
          (issue.severity === Severity.Blocker || issue.severity === Severity.Major),
      )
      .map((issue) => ({ agentId: f.agentId, issue })),
  );
}

/** A claim is evidenced when it cites evidence (a file listing alone is not enough). */
function isEvidenced(issue: ResultIssue): boolean {
  return (issue.evidence ?? []).some((item) => item.trim().length > 0);
}

function claimKey(claim: SecurityClaim): string {
  return `${claim.agentId}|${claim.issue.id}|${claim.issue.description}`;
}

/**
 * Security veto. Authority comes from the finding itself — security category,
 * blocker/major severity and cited evidence — not from the reviewer's name or
 * from how many others passed. Returns a NEEDS_WORK result when any reviewer
 * has such a finding, else undefined.
 */
export function securityVeto(
  findings: ReviewerFinding[],
): ReviewResult | undefined {
  const evidenced = securityClaims(findings).filter((c) => isEvidenced(c.issue));
  if (evidenced.length === 0) {
    return undefined;
  }
  const issues = evidenced.map((c) => c.issue);
  const raisedBy = new Set(evidenced.map((c) => c.agentId));
  return makeReviewResult({
    status: ReviewStatus.NeedsWork,
    confidence: 0.95,
    summary: `Security veto: evidenced blocker/major security findings from ${[...raisedBy].join(", ")} override PASS`,
    issues,
    requiredChanges: [
      ...new Set([
        ...issues.map((i) => i.requiredChange ?? i.description),
        ...findings
          .filter((f) => raisedBy.has(f.agentId))
          .flatMap((f) => f.result.requiredChanges ?? []),
      ]),
    ],
    optionalChanges: [],
    evidenceRequests: [],
  });
}

/**
 * Applied to every merged panel result: a PASS cannot clear a severe security
 * claim. Evidenced claims veto. Unevidenced ones first ask for verification
 * (the diff and the cited files, as an evidence request, so the executor is
 * not sent to change code over an unsupported claim); if the same claim comes
 * back still unsupported, the result is BLOCKED for a human.
 */
function enforceSecurityAuthority(
  result: ReviewResult,
  findings: ReviewerFinding[],
  verificationRequested?: Set<string>,
): ReviewResult {
  if (result.status !== ReviewStatus.Pass) {
    return result;
  }
  const veto = securityVeto(findings);
  if (veto) {
    return veto;
  }
  const unsupported = securityClaims(findings).filter((c) => !isEvidenced(c.issue));
  if (unsupported.length === 0) {
    return result;
  }
  const described = unsupported
    .map((c) => `${c.agentId}: ${truncate(c.issue.description, 120)}`)
    .join("; ");

  const fresh = unsupported.filter((c) => !verificationRequested?.has(claimKey(c)));
  if (fresh.length === 0) {
    return makeReviewResult({
      status: ReviewStatus.Blocked,
      confidence: averageConfidence(findings),
      summary: `Unverified security claim still unsupported after verification; a human must decide: ${described}`,
      issues: unsupported.map((c) => c.issue),
      requiredChanges: [],
      optionalChanges: [],
      evidenceRequests: [],
    });
  }
  for (const claim of fresh) {
    verificationRequested?.add(claimKey(claim));
  }

  const files = [...new Set(unsupported.flatMap((c) => c.issue.affectedFiles ?? []))];
  return makeReviewResult({
    status: ReviewStatus.NeedsWork,
    confidence: averageConfidence(findings),
    summary: `Unverified security claim blocks PASS; cite evidence or withdraw it: ${described}`,
    issues: [],
    requiredChanges: [],
    optionalChanges: [],
    evidenceRequests: [
      {
        kind: EvidenceKind.GitDiff,
        description: `Verify security claim(s): ${described}`,
      },
      ...(files.length > 0
        ? [
            {
              kind: EvidenceKind.Files,
              paths: files,
              description: "Files named by the unverified security claim",
            },
          ]
        : []),
    ],
  });
}

function weightedMerge(findings: ReviewerFinding[], total?: number): ReviewResult {
  const statuses = findings.map((f) => f.result.status);
  if (statuses.includes(ReviewStatus.Failed)) {
    return mergeStatus(ReviewStatus.Failed, findings, "Panel: reviewer failed", total);
  }
  if (statuses.includes(ReviewStatus.Blocked)) {
    return mergeStatus(ReviewStatus.Blocked, findings, "Panel: reviewer blocked", total);
  }
  if (statuses.includes(ReviewStatus.NeedsWork)) {
    return mergeStatus(
      ReviewStatus.NeedsWork,
      findings,
      "Panel: changes required after correlation",
      total,
    );
  }
  return mergeAgreeing(findings, total);
}

/**
 * Vote for `majority` and `weighted`. The threshold is half of the configured
 * panel's weight: `missing` is the weight of members with no finding.
 *
 * - Any BLOCKED verdict keeps the result BLOCKED; a vote never clears it.
 * - A FAILED verdict wins outright, as in `weightedMerge`.
 * - A side with more than half the weight wins; anything else is NEEDS_WORK,
 *   unless the missing members could still decide it, which is inconclusive.
 * - A PASS majority drops dissenters' major/minor/info objections, but not an
 *   evidenced blocker (any category): that makes the result NEEDS_WORK.
 */
function voteMerge(
  findings: ReviewerFinding[],
  total: number | undefined,
  weightOf: (agentId: string) => number,
  missing: number,
): ReviewResult | { inconclusive: string } {
  if (
    findings.some(
      (f) => f.result.status === ReviewStatus.Failed || f.result.status === ReviewStatus.Blocked,
    )
  ) {
    return weightedMerge(findings, total);
  }
  const tally = new Map<ReviewResult["status"], number>();
  let answered = 0;
  for (const f of findings) {
    const weight = weightOf(f.agentId);
    tally.set(f.result.status, (tally.get(f.result.status) ?? 0) + weight);
    answered += weight;
  }
  const panel = answered + missing;
  const winner = [...tally.entries()].find(([, weight]) => weight * 2 > panel)?.[0];

  if (winner === undefined) {
    const couldDecide = [ReviewStatus.Pass, ReviewStatus.NeedsWork, ReviewStatus.Blocked].some(
      (status) => ((tally.get(status) ?? 0) + missing) * 2 > panel,
    );
    if (missing > 0 && couldDecide) {
      return {
        inconclusive: "Panel vote is undecided and members that did not answer could still decide it",
      };
    }
    return mergeStatus(ReviewStatus.NeedsWork, findings, "Panel: no majority; changes required", total);
  }
  if (winner === ReviewStatus.Pass) {
    const blockers = findings.some((f) =>
      (f.result.issues ?? []).some((i) => i.severity === Severity.Blocker && isEvidenced(i)),
    );
    return blockers
      ? mergeStatus(
          ReviewStatus.NeedsWork,
          findings,
          "Panel: evidenced blocker issue overrides the PASS majority",
          total,
        )
      : mergeStatus(ReviewStatus.Pass, findings, "Panel: majority passed", total);
  }
  return mergeStatus(ReviewStatus.NeedsWork, findings, "Panel: majority requires changes", total);
}

/** Prefix the summary with each member's verdict, e.g. `Panel [majority] A PASS, B NEEDS_WORK`. */
function labelVerdicts(
  policy: ReviewPolicy,
  findings: ReviewerFinding[],
  result: ReviewResult,
): ReviewResult {
  if (findings.length < 2) {
    return result;
  }
  const verdicts = findings.map((f) => `${f.agentId} ${f.result.status}`).join(", ");
  return makeReviewResult({
    ...result,
    summary: truncate(`Panel [${policy}] ${verdicts}. ${result.summary}`, 500),
  });
}

function mergeAgreeing(findings: ReviewerFinding[], total?: number): ReviewResult {
  const status = findings[0]!.result.status;
  return mergeStatus(
    status,
    findings,
    findings.map((f) => f.result.summary).join(" | "),
    total,
  );
}

function mergeStatus(
  status: ReviewResult["status"],
  findings: ReviewerFinding[],
  summary: string,
  total?: number,
): ReviewResult {
  const correlated = correlateFindings(findings, total);
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
  total?: number,
): ReviewResult {
  const map: Record<AdjudicatorDecision, ReviewResult["status"]> = {
    PASS: ReviewStatus.Pass,
    NEEDS_WORK: ReviewStatus.NeedsWork,
    MORE_EVIDENCE: ReviewStatus.NeedsWork,
    BLOCKED: ReviewStatus.Blocked,
  };
  const status = map[decision];
  const base = mergeStatus(status, findings, summary, total);
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
  return base;
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

const SEVERITY_ORDER = [
  Severity.Blocker,
  Severity.Major,
  Severity.Minor,
  Severity.Info,
] as const;

/** Position in the severity order; 0 is most severe. Unknown values rank after every known one. */
function severityRank(severity: ReviewIssue["severity"]): number {
  const index = SEVERITY_ORDER.indexOf(severity as (typeof SEVERITY_ORDER)[number]);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function maxSeverity(
  severities: Array<ReviewIssue["severity"]>,
): ReviewIssue["severity"] {
  let best: ReviewIssue["severity"] | undefined;
  for (const s of severities) {
    const rank = severityRank(s);
    if (rank === SEVERITY_ORDER.length) continue;
    if (best === undefined || rank < severityRank(best)) best = s;
  }
  return best ?? Severity.Major;
}

function agreementOf(count: number, total: number) {
  return { count, total, ratio: total === 0 ? 0 : count / total };
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
