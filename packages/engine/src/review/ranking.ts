import { Severity } from "../core/types.js";
import type { ReviewIssue } from "#assentor/protocol/review-result.js";

/**
 * Pure review helpers with no Node imports, so the web UI can use them through
 * `@engine/`. `coordinator.ts` re-exports everything here, so existing imports keep working.
 */

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

export const SEVERITY_ORDER = [
  Severity.Blocker,
  Severity.Major,
  Severity.Minor,
  Severity.Info,
] as const;

/** Position in the severity order; 0 is most severe. Unknown values rank after every known one. */
export function severityRank(severity: ReviewIssue["severity"]): number {
  const index = SEVERITY_ORDER.indexOf(severity as (typeof SEVERITY_ORDER)[number]);
  return index === -1 ? SEVERITY_ORDER.length : index;
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
