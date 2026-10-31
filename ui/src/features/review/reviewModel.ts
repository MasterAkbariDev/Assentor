import type { EngineEventOf } from "@engine/protocol/events.js";
import { ReviewIssueSchema } from "@engine/protocol/review-result.js";
import {
  rankCorrelatedFindings,
  REVIEW_POLICIES,
  type CorrelatedFinding,
  type ReviewPolicy,
} from "@engine/review/ranking.js";

/**
 * Pure model for the review view (T04-10p). Everything here is derived from
 * the event stream; nothing is fetched and nothing is written back.
 */

export type Verdict = EngineEventOf<"review.verdict">;
export type FindingEvent = EngineEventOf<"review.finding">;

/** A finding as the view shows it: the engine's correlated shape plus the required change, when the stream has one. */
export type FindingView = CorrelatedFinding & { requiredChange?: string };

const SEVERITY = ReviewIssueSchema.shape.severity;

export interface ReviewDecision {
  status: string;
  summary?: string;
  confidence?: number;
  /** Only when the summary carries the engine's `Panel [policy]` label, which it does for non-default policies. */
  policy?: ReviewPolicy;
}

/** The final decision of the latest reviewer verdict. */
export function decisionOf(verdict: Verdict | undefined): ReviewDecision | undefined {
  if (!verdict) {
    return undefined;
  }
  const { status, summary, confidence } = verdict.data;
  const label = summary?.match(/^Panel \[([a-z-]+)\]/)?.[1];
  return {
    status,
    summary,
    confidence,
    policy: REVIEW_POLICIES.find((policy) => policy === label),
  };
}

/**
 * The findings to show. `review.finding` events carry the correlated shape
 * with agreement, so they win. Otherwise the findings are the latest verdict's
 * `issues`, which carry evidence and required changes but no agreement count.
 */
export function findingsOf(
  findingEvents: readonly FindingEvent[],
  verdict: Verdict | undefined,
): { source: "findings" | "issues"; findings: FindingView[] } {
  if (findingEvents.length > 0) {
    return { source: "findings", findings: rankFindings(findingEvents.map(fromFindingEvent)) };
  }
  const issues: unknown = verdict?.data.issues;
  const parsed = Array.isArray(issues) ? issues.map((item) => ReviewIssueSchema.safeParse(item)) : [];
  const findings = parsed.flatMap((result) => (result.success ? [result.data] : []));
  return {
    source: "issues",
    findings: rankFindings(
      findings.map((issue) => ({
        key: issue.id,
        description: issue.description,
        severity: issue.severity,
        category: issue.category,
        agentIds: [],
        issueIds: [issue.id],
        affectedFiles: issue.affectedFiles,
        evidence: issue.evidence,
        agreement: { count: 0, total: 0, ratio: 0 },
        requiredChange: issue.requiredChange,
      })),
    ),
  };
}

function fromFindingEvent(event: FindingEvent): FindingView {
  const { key, description, severity, affectedFiles, agreement } = event.data;
  const parsed = SEVERITY.safeParse(severity);
  return {
    key,
    description,
    // An unknown severity ranks last rather than breaking the sort.
    severity: parsed.success ? parsed.data : "info",
    category: "other",
    agentIds: [],
    issueIds: [],
    affectedFiles,
    evidence: [],
    agreement: agreement
      ? { count: agreement.count, total: agreement.total, ratio: agreement.total > 0 ? agreement.count / agreement.total : 0 }
      : { count: 0, total: 0, ratio: 0 },
  };
}

/** Engine order: severity, then agreement, then key. `rankCorrelatedFindings` keeps the object identities, so extra fields survive. */
function rankFindings(list: FindingView[]): FindingView[] {
  return rankCorrelatedFindings(list) as FindingView[];
}

export interface FileGroup {
  /** The finding's first affected file; `""` for findings that name none. */
  file: string;
  findings: FindingView[];
}

/**
 * Findings grouped by file (each under its first affected file), files in
 * path order, the "no file" group last. Each group keeps the input order, so
 * severity order inside a file is the ranking order.
 */
export function groupByFile(findings: readonly FindingView[]): FileGroup[] {
  const byFile = new Map<string, FindingView[]>();
  for (const finding of findings) {
    const file = finding.affectedFiles[0] ?? "";
    byFile.set(file, [...(byFile.get(file) ?? []), finding]);
  }
  return [...byFile]
    .sort(([a], [b]) => Number(a === "") - Number(b === "") || (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, items]) => ({ file, findings: items }));
}

/** Agreement is partial: some reviewers flagged it and some did not. Unknown agreement is not a disagreement. */
export function isDisagreement(finding: FindingView): boolean {
  return finding.agreement.total > 0 && finding.agreement.count < finding.agreement.total;
}

export function agreementText(finding: FindingView): string {
  return finding.agreement.total > 0 ? `${finding.agreement.count}/${finding.agreement.total}` : "agreement not recorded";
}

export interface FindingFilter {
  severity: FindingView["severity"] | "all";
  onlyDisagreements: boolean;
}

export function filterFindings(findings: readonly FindingView[], filter: FindingFilter): FindingView[] {
  return findings.filter(
    (f) =>
      (filter.severity === "all" || f.severity === filter.severity) &&
      (!filter.onlyDisagreements || isDisagreement(f)),
  );
}
