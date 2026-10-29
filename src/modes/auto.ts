import type { ComplexityAnalysis } from "../review/complexity.js";

/**
 * Auto mode router (task T02B-08). Pure and deterministic: same input gives the
 * same mode and reasons. No model calls, no I/O. Design: docs/plans/modes.md §6 "Auto".
 */

export interface ModeSuggestionInput {
  task: string;
  complexity: ComplexityAnalysis;
  /** Accepted for future repo-size rules; the T02B-08 rules do not read it. */
  repoFileCount?: number;
  /** Mode ids the caller can run right now. The router never suggests anything else. */
  availableModes: string[];
}

export interface ModeSuggestion {
  mode: string;
  /** 0.8 keyword match, 0.6 risk or multi-part match, 0.4 fallback. */
  confidence: number;
  /** Plain-language reasons. The first one explains the chosen mode. */
  reasons: string[];
  /** Up to 2 other available modes whose rules also matched. */
  alternatives: string[];
}

interface Candidate {
  mode: string;
  confidence: number;
  reason: string;
}

const BUILD_VERB = /\b(?:add|implement|build|create|fix|refactor|write|update)\b/i;

/** Keyword rules in precedence order. Whole-word, case-insensitive. */
const KEYWORD_RULES: Array<{
  mode: string;
  re: RegExp;
  /** Only applies when the goal has no build verb (it asks a question, not for code). */
  noBuildVerb?: boolean;
  why: string;
}> = [
  { mode: "review", re: /\b(?:review|audit|check my|look over)\b/i, why: "asks for a review or audit" },
  {
    mode: "explore",
    re: /\b(?:why|how does|explain|where is|what does)\b/i,
    noBuildVerb: true,
    why: "asks how something works or where it lives",
  },
  {
    mode: "plan",
    re: /\b(?:plan|design|spec|roadmap|break down)\b/i,
    noBuildVerb: true,
    why: "asks for a plan or design before code",
  },
  {
    mode: "swarm",
    re: /\b(?:rename|migrate|replace all|bump|across (?:the )?(?:repo|codebase)|every file)\b/i,
    why: "is a mechanical change spread across many files",
  },
  {
    mode: "debug",
    re: /\b(?:flaky|intermittent|crash|regression|stack trace|incident)\b/i,
    why: "describes a bug to track down",
  },
  { mode: "tdd", re: /\b(?:test first|tdd)\b/i, why: "asks for test-first work" },
];

const FALLBACK: Candidate = {
  mode: "solo",
  confidence: 0.4,
  reason: "No specific pattern matched, so one executor with review is the simplest fit.",
};

/** Every rule that matches, in precedence order. `solo` is not a candidate here. */
function candidates(input: ModeSuggestionInput): Candidate[] {
  const task = input.task;
  const out: Candidate[] = [];
  const hasBuildVerb = BUILD_VERB.test(task);

  for (const rule of KEYWORD_RULES) {
    const hit = rule.re.exec(task);
    if (!hit) continue;
    if (rule.noBuildVerb && hasBuildVerb) continue;
    out.push({
      mode: rule.mode,
      confidence: 0.8,
      reason: `Your goal ${rule.why} ("${hit[0]}"), so ${rule.mode} fits.`,
    });
  }

  const risk = input.complexity.risk;
  if (risk === "high" || risk === "critical") {
    out.push({
      mode: "cascade",
      confidence: 0.6,
      reason: `The complexity check rates this ${risk} risk, so a cheap-first ladder that escalates on failure fits.`,
    });
  }

  const listedItems = task
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
  const buildSentences = task.split(/[.!?\n]+/).filter((part) => BUILD_VERB.test(part)).length;
  if (listedItems >= 3) {
    out.push({
      mode: "lead",
      confidence: 0.6,
      reason: `The goal lists ${listedItems} separate items, so a lead should split and assign them.`,
    });
  } else if (buildSentences >= 3) {
    out.push({
      mode: "lead",
      confidence: 0.6,
      reason: `The goal asks for build work in ${buildSentences} separate sentences, so a lead should split it.`,
    });
  }

  return out;
}

/**
 * Picks the first matching rule whose mode is available; `solo` is the final
 * fallback. Matched rules whose mode is unavailable are skipped and noted in reasons.
 */
export function suggestMode(input: ModeSuggestionInput): ModeSuggestion {
  const available = new Set(input.availableModes);
  const matched = candidates(input);

  const skippedNotes: string[] = [];
  let chosen: Candidate = FALLBACK;
  for (const candidate of matched) {
    if (available.has(candidate.mode)) {
      chosen = candidate;
      break;
    }
    skippedNotes.push(`${candidate.mode} also fits, but it is not available here, so it was skipped.`);
  }

  const alternatives = matched
    .map((candidate) => candidate.mode)
    .filter((mode) => mode !== chosen.mode && available.has(mode))
    .slice(0, 2);

  return {
    mode: chosen.mode,
    confidence: chosen.confidence,
    reasons: [chosen.reason, ...skippedNotes],
    alternatives,
  };
}
