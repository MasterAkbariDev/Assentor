import type { ComplexityAnalysis } from "./complexity.js";

const SIGNAL_LABELS: Record<string, string> = {
  trivial_task_text: "Short, simple goal wording",
  short_task_text: "Brief goal description",
  medium_task_text: "Medium-length goal description",
  long_task_text: "Long / detailed goal description",
  polyglot: "Project uses several languages",
  no_tests_detected: "No tests detected in the project",
  large_module_count: "Large codebase (many modules)",
  medium_module_count: "Medium-sized codebase",
};

const STRATEGY_BLURBS: Record<string, string> = {
  SINGLE: "One reviewer checks the work — fastest, cheapest.",
  ADAPTIVE: "Assentor adds more reviewers when the goal looks harder.",
  PANEL: "Several specialist reviewers must agree.",
  FULL: "Full specialty panel on every task.",
};

/** Turn raw analyzer signals into short human lines. */
export function explainSignals(signals: string[]): string[] {
  return signals.map((signal) => {
    if (SIGNAL_LABELS[signal]) return SIGNAL_LABELS[signal]!;
    if (signal.startsWith("keyword:")) {
      const name = signal.slice("keyword:".length);
      return `Goal mentions ${name}-related work`;
    }
    if (signal.startsWith("framework:")) {
      return `Detected framework: ${signal.slice("framework:".length)}`;
    }
    if (signal.startsWith("project_type:")) {
      return `Project type: ${signal.slice("project_type:".length)}`;
    }
    return signal.replace(/_/g, " ");
  });
}

export function explainStrategy(strategy: string): string {
  return STRATEGY_BLURBS[strategy] ?? `Strategy: ${strategy}`;
}

export function explainRisk(risk: ComplexityAnalysis["risk"]): string {
  switch (risk) {
    case "low":
      return "Low risk — likely a small, contained change.";
    case "medium":
      return "Medium risk — expect a normal review pass.";
    case "high":
      return "High risk — broader impact; more reviewers recommended.";
    case "critical":
      return "Critical risk — treat carefully; deep evidence + panel.";
  }
}

export function explainEvidenceDepth(
  depth: ComplexityAnalysis["evidenceDepth"],
): string {
  switch (depth) {
    case "QUICK":
      return "Quick evidence — light file/diff scan.";
    case "STANDARD":
      return "Standard evidence — key files, tests, and diff.";
    case "DEEP":
      return "Deep evidence — broader pack before judging.";
  }
}

/** Plain-language lines for TUI / CLI review plan. */
export function formatReviewPlanExplanation(
  plan: ComplexityAnalysis,
  options: { goal: string; strategy: string },
): string[] {
  const roles =
    plan.recommendedRoles.length > 0
      ? plan.recommendedRoles.join(", ")
      : "general";
  return [
    `Goal: ${options.goal}`,
    "",
    `Complexity ${plan.score}/100 — ${explainRisk(plan.risk)}`,
    explainEvidenceDepth(plan.evidenceDepth),
    "",
    `Assentor will bring ~${plan.recommendedCount} reviewer(s): ${roles}`,
    explainStrategy(options.strategy),
    "",
    "Why this plan:",
    ...explainSignals(plan.signals)
      .slice(0, 8)
      .map((s) => `• ${s}`),
  ];
}
