import type { EngineEventOf } from "#assentor/protocol/events.js";
import { IssueCategory, ReviewIssueSchema, Severity } from "#assentor/protocol/review-result.js";
import {
  rankCorrelatedFindings,
  REVIEW_POLICIES,
  type CorrelatedFinding,
  type ReviewPolicy,
} from "#assentor/engine/review/ranking.js";

/**
 * Pure model for the review view (T04-10p). Everything here is derived from
 * the event stream; nothing is fetched and nothing is written back.
 */

export type Verdict = EngineEventOf<"review.verdict">;
export type FindingEvent = EngineEventOf<"review.finding">;

/**
 * A finding as the view shows it: the engine's correlated shape plus the required change, when the stream has one.
 * `severity` is the stream's string, kept as given when the schema does not know it.
 */
export type FindingView = Omit<CorrelatedFinding, "severity"> & { severity: string; requiredChange?: string };

/** Severities the schema knows. Any other string in the stream is shown as given and matches the "other" filter. */
const KNOWN_SEVERITIES: ReadonlySet<string> = new Set<string>(Object.values(Severity));

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set<string>(Object.values(IssueCategory));

export interface ReviewDecision {
  status: string;
  summary?: string;
  confidence?: number;
  /** From the verdict's `policy`; older logs only have the summary's `Panel [policy]` label, which non-default policies add. */
  policy?: ReviewPolicy;
}

/** The final decision of the latest reviewer verdict. */
export function decisionOf(verdict: Verdict | undefined): ReviewDecision | undefined {
  if (!verdict) {
    return undefined;
  }
  const { status, summary, confidence } = verdict.data;
  const label = verdict.data.policy ?? summary?.match(/^Panel \[([a-z-]+)\]/)?.[1];
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
 * `unreadable` counts issues that fail `ReviewIssueSchema` and are left out.
 */
export function findingsOf(
  findingEvents: readonly FindingEvent[],
  verdict: Verdict | undefined,
): { source: "findings" | "issues"; findings: FindingView[]; unreadable: number } {
  if (findingEvents.length > 0) {
    return { source: "findings", findings: rankFindings(findingEvents.map(fromFindingEvent)), unreadable: 0 };
  }
  const issues: unknown = verdict?.data.issues;
  const parsed = Array.isArray(issues) ? issues.map((item) => ReviewIssueSchema.safeParse(item)) : [];
  const findings = parsed.flatMap((result) => (result.success ? [result.data] : []));
  return {
    source: "issues",
    unreadable: parsed.length - findings.length,
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
  const { key, description, severity, affectedFiles, agreement, reviewerIds, category, evidence } = event.data;
  return {
    key,
    description,
    severity,
    category: KNOWN_CATEGORIES.has(category ?? "") ? (category as FindingView["category"]) : "other",
    agentIds: reviewerIds ?? [],
    issueIds: [],
    affectedFiles,
    evidence: evidence ?? [],
    agreement: agreement
      ? { count: agreement.count, total: agreement.total, ratio: agreement.total > 0 ? agreement.count / agreement.total : 0 }
      : { count: 0, total: 0, ratio: 0 },
  };
}

/**
 * Engine order: severity, then agreement, then key. Only the severity rank and
 * the agreement count are read, and an unknown severity ranks after every known
 * one. The objects are kept as they are, so the extra fields survive.
 */
function rankFindings(list: FindingView[]): FindingView[] {
  return rankCorrelatedFindings(list as CorrelatedFinding[]) as FindingView[];
}

/** True when at least one finding has an agreement count. Without one, "only disagreements" cannot apply. */
export function hasAgreement(findings: readonly FindingView[]): boolean {
  return findings.some((f) => f.agreement.total > 0);
}

/**
 * The panel seat exists only for more than one reviewer, so one `reviewer-N`
 * seat and no panel seat means a single reviewer.
 */
export function isSingleReviewer(seatIds: readonly string[]): boolean {
  return !seatIds.includes("panel") && seatIds.filter((id) => id.startsWith("reviewer-")).length === 1;
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

/** `"other"` matches any severity string the schema does not know. */
export type SeverityFilter = Severity | "other" | "all";

export interface FindingFilter {
  severity: SeverityFilter;
  onlyDisagreements: boolean;
  /** Seat id (or member name) from a finding's `reviewerIds`; undefined = every reviewer. */
  reviewer?: string;
}

export function filterFindings(findings: readonly FindingView[], filter: FindingFilter): FindingView[] {
  return findings.filter(
    (f) =>
      (filter.severity === "all" ||
        (filter.severity === "other" ? !KNOWN_SEVERITIES.has(f.severity) : f.severity === filter.severity)) &&
      (!filter.onlyDisagreements || isDisagreement(f)) &&
      (!filter.reviewer || f.agentIds.includes(filter.reviewer)),
  );
}
