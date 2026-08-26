import type { ReviewerSpecialty } from "../agents/index.js";
import {
  explainEvidenceDepth,
  explainRisk,
  explainSignals,
} from "./plan-explain.js";

export type EvidenceDepth = "QUICK" | "STANDARD" | "DEEP";

export type ComplexityRisk = "low" | "medium" | "high" | "critical";

export interface ProjectOverviewSignals {
  projectType?: string;
  framework?: string;
  languages?: string[];
  packageManager?: string;
  hasTests?: boolean;
  moduleCount?: number;
}

export interface ComplexityAnalysis {
  /** 0–100 deterministic complexity score */
  score: number;
  risk: ComplexityRisk;
  recommendedRoles: ReviewerSpecialty[];
  recommendedCount: number;
  evidenceDepth: EvidenceDepth;
  signals: string[];
}

export interface TaskComplexityAnalyzerInput {
  taskText: string;
  projectOverview?: ProjectOverviewSignals;
}

const ROLE_ORDER: ReviewerSpecialty[] = [
  "general",
  "architecture",
  "code",
  "testing",
  "security",
  "performance",
  "ui",
];

/**
 * Deterministic complexity / reviewer-count engine from task text + overview.
 * No network or model calls — safe for offline CLI preflight.
 */
export class TaskComplexityAnalyzer {
  analyze(input: TaskComplexityAnalyzerInput): ComplexityAnalysis {
    const text = input.taskText ?? "";
    const lower = text.toLowerCase();
    const signals: string[] = [];
    let score = 10;

    const len = text.trim().length;
    if (len > 500) {
      score += 25;
      signals.push("long_task_text");
    } else if (len > 200) {
      score += 15;
      signals.push("medium_task_text");
    } else if (len > 80) {
      score += 8;
      signals.push("short_task_text");
    } else {
      signals.push("trivial_task_text");
    }

    const keywordGroups: Array<{
      name: string;
      re: RegExp;
      weight: number;
      roles: ReviewerSpecialty[];
    }> = [
      {
        name: "security",
        re: /auth|oauth|jwt|password|token|secret|permission|rbac|xss|csrf|inject/i,
        weight: 18,
        roles: ["security", "architecture", "testing"],
      },
      {
        name: "architecture",
        re: /refactor|architecture|migrat|module|boundary|redesign|hexagonal|clean arch/i,
        weight: 16,
        roles: ["architecture", "code", "testing", "performance"],
      },
      {
        name: "database",
        re: /database|sql|schema|prisma|migration|orm|postgres|mongo/i,
        weight: 12,
        roles: ["architecture", "testing", "security"],
      },
      {
        name: "performance",
        re: /perf|latency|throughput|optim|cache|n\+1|scalab/i,
        weight: 12,
        roles: ["performance", "architecture", "code"],
      },
      {
        name: "ui",
        re: /\bui\b|ux|css|html|react|svelte|accessibility|a11y|frontend/i,
        weight: 10,
        roles: ["ui", "code", "testing"],
      },
      {
        name: "distributed",
        re: /distributed|microservice|queue|kafka|event.?driven|concurrency|race/i,
        weight: 14,
        roles: ["architecture", "performance", "testing", "code"],
      },
      {
        name: "testing",
        re: /test coverage|e2e|integration test|acceptance/i,
        weight: 8,
        roles: ["testing", "general"],
      },
    ];

    const roles = new Set<ReviewerSpecialty>(["general"]);
    for (const group of keywordGroups) {
      if (group.re.test(lower)) {
        score += group.weight;
        signals.push(`keyword:${group.name}`);
        for (const role of group.roles) {
          roles.add(role);
        }
      }
    }

    const overview = input.projectOverview;
    if (overview) {
      if (overview.framework) {
        score += 4;
        signals.push(`framework:${overview.framework}`);
      }
      if ((overview.languages?.length ?? 0) > 2) {
        score += 6;
        signals.push("polyglot");
      }
      if (overview.hasTests === false) {
        score += 5;
        signals.push("no_tests_detected");
        roles.add("testing");
      }
      if ((overview.moduleCount ?? 0) > 40) {
        score += 10;
        signals.push("large_module_count");
        roles.add("architecture");
      } else if ((overview.moduleCount ?? 0) > 15) {
        score += 5;
        signals.push("medium_module_count");
      }
      if (
        overview.projectType === "monorepo" ||
        overview.projectType === "unknown"
      ) {
        score += 4;
        signals.push(`project_type:${overview.projectType}`);
      }
    }

    score = Math.max(0, Math.min(100, score));

    const risk: ComplexityRisk =
      score >= 75
        ? "critical"
        : score >= 55
          ? "high"
          : score >= 30
            ? "medium"
            : "low";

    const evidenceDepth: EvidenceDepth =
      score >= 65 ? "DEEP" : score >= 30 ? "STANDARD" : "QUICK";

    const recommendedCount =
      score < 25 ? 1 : score < 45 ? 2 : score < 70 ? 4 : 6;

    const matchedRoles = [...roles].filter((r) => r !== "general");
    const recommendedRoles: ReviewerSpecialty[] = [];
    // Prefer keyword-matched specialties first (not just ROLE_ORDER position).
    for (const role of matchedRoles) {
      if (recommendedRoles.length >= recommendedCount) break;
      if (!recommendedRoles.includes(role)) recommendedRoles.push(role);
    }
    if (
      recommendedRoles.length < recommendedCount &&
      !recommendedRoles.includes("general")
    ) {
      recommendedRoles.unshift("general");
    }
    while (
      recommendedRoles.length < recommendedCount &&
      ROLE_ORDER.some((r) => !recommendedRoles.includes(r))
    ) {
      const next = ROLE_ORDER.find((r) => !recommendedRoles.includes(r));
      if (!next) break;
      recommendedRoles.push(next);
    }

    return {
      score,
      risk,
      recommendedRoles: recommendedRoles.slice(0, recommendedCount),
      recommendedCount,
      evidenceDepth,
      signals,
    };
  }
}

const ROLE_LABEL: Record<string, string> = {
  architecture: "Architecture",
  code: "Code quality",
  testing: "Testing",
  security: "Security",
  performance: "Performance",
  ui: "UI",
  general: "General",
  adjudicator: "Adjudicator",
};

export interface ReviewPlanExplanation {
  headline: string;
  reviewers: string[];
  reasons: string[];
  depthLabel: string;
  riskLabel: string;
}

/** Plain-language explanation of a complexity analysis for the TUI/CLI. */
export function explainReviewPlan(plan: ComplexityAnalysis): ReviewPlanExplanation {
  const reviewers = plan.recommendedRoles.map(
    (role) => ROLE_LABEL[role] ?? role,
  );
  const reasons = explainSignals(plan.signals);
  const count = plan.recommendedCount;
  const headline =
    count === 1
      ? "Assentor recommends 1 reviewer for this goal."
      : `Assentor recommends ${count} reviewers for this goal.`;

  return {
    headline,
    reviewers,
    reasons: reasons.length
      ? reasons
      : ["the goal is small — a lighter review is enough"],
    depthLabel: explainEvidenceDepth(plan.evidenceDepth),
    riskLabel: explainRisk(plan.risk),
  };
}
