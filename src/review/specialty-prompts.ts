import type { ReviewerSpecialty } from "../agents/index.js";

export type SpecialtyPromptKey = Exclude<ReviewerSpecialty, "adjudicator">;

/**
 * Per-specialty addenda layered on DEFAULT_AGENT_PROFILES instructions.
 * Every finding must cite concrete evidence — no vague opinions.
 */
export const SPECIALTY_PROMPT_ADDENDA: Record<SpecialtyPromptKey, string> = {
  architecture: [
    "## Specialty: Architecture",
    "Focus on module boundaries, layering, coupling, and design consistency.",
    "Required checks:",
    "- Compare changed files against unchanged interfaces, repositories, and callers.",
    "- Flag bypassed abstractions (e.g. service talking past a repository/interface).",
    "- Verify dependency direction (domain ← application ← infra/api).",
    "- Assess whether new modules belong where they were placed.",
    "Evidence rules:",
    "- Cite concrete paths (changed + unchanged important files) and pack architecture summary.",
    "- Do not claim a boundary violation without naming the interface/caller/repo involved.",
    "- If structure or architecture sections are missing, return NEEDS_WORK with evidenceRequests.",
  ].join("\n"),

  code: [
    "## Specialty: Code quality",
    "Focus on correctness bugs, edge cases, readability, and maintainability.",
    "Required checks:",
    "- Trace changed functions against callers and contracts in the evidence pack.",
    "- Look for null/empty handling, error paths, and inconsistent types.",
    "- Prefer specific requiredChanges over general style commentary.",
    "Evidence rules:",
    "- Every issue must cite a file path and/or diff hunk from the pack.",
    "- Do not invent APIs or file contents not present in evidence.",
  ].join("\n"),

  testing: [
    "## Specialty: Testing",
    "Ensure acceptance criteria are verifiable with tests and run evidence.",
    "Required checks:",
    "- Map each acceptance criterion to tests or explicit verification gaps.",
    "- Inspect pack.tests / command outputs; treat NOT_RUN as insufficient when criteria need proof.",
    "- Flag missing negative/edge-case coverage for changed behavior.",
    "Evidence rules:",
    "- Cite test file paths, assertions, or command output markers.",
    "- If tests were not run and criteria require them, request evidence — do not PASS.",
  ].join("\n"),

  security: [
    "## Specialty: Security",
    "Look for auth gaps, injection, secret leakage, unsafe defaults, and trust-boundary issues.",
    "Required checks:",
    "- Auth/session/token handling on changed surfaces.",
    "- Input validation at trust boundaries; SQL/command/path injection risks.",
    "- Secrets in diffs, logs, config excerpts (names/paths only — never echo secret values).",
    "Evidence rules:",
    "- Blocker/major security issues must cite the exact file/snippet.",
    "- Security blockers MUST NOT be downgraded to optionalChanges.",
    "- Vague 'might be insecure' without evidence is forbidden — request evidence instead.",
  ].join("\n"),

  performance: [
    "## Specialty: Performance",
    "Flag hotspots, N+1 patterns, unbounded work, and missing caching/limits.",
    "Required checks:",
    "- Loops over I/O or DB without batching; unbounded collections/recursion.",
    "- Synchronous work on hot paths when evidence shows async alternatives exist.",
    "Evidence rules:",
    "- Cite algorithms/call sites in changed files; do not invent benchmarks.",
    "- If runtime metrics are absent, say so — do not fabricate timings.",
  ].join("\n"),

  ui: [
    "## Specialty: UI / UX",
    "Check accessibility, layout clarity, interaction affordances, and responsive behavior.",
    "Required checks:",
    "- Labels, focus order, contrast/a11y hooks when UI files changed.",
    "- Loading/error empty states for user-visible flows in the task.",
    "Evidence rules:",
    "- Cite component/file paths from the pack; do not invent screenshots.",
    "- Request screenshots or UI files when visual claims cannot be verified.",
  ].join("\n"),

  general: [
    "## Specialty: General quality gate",
    "Evaluate overall acceptance-criteria satisfaction across the evidence pack.",
    "Required checks:",
    "- Each acceptance criterion: satisfied / not / unknown with notes.",
    "- Cross-check executor claims against pack artifacts (diff, files, tests).",
    "Evidence rules:",
    "- No PASS when required evidence is missing or executor claims are unverified.",
    "- Issues must cite pack sections or artifact ids — no vague 'looks incomplete'.",
    "- A clean git working tree is not a defect if Section G lists files changed since task start, or those files are inlined in the pack.",
    "- Never require the executor to git add/commit unless the contract says so.",
  ].join("\n"),
};

export function specialtyAddendum(
  specialty?: ReviewerSpecialty | string,
): string {
  if (!specialty || specialty === "adjudicator") {
    return SPECIALTY_PROMPT_ADDENDA.general;
  }
  const key = specialty as SpecialtyPromptKey;
  return SPECIALTY_PROMPT_ADDENDA[key] ?? SPECIALTY_PROMPT_ADDENDA.general;
}

export function expandProfileInstructions(
  baseInstructions: string,
  specialty?: ReviewerSpecialty | string,
): string {
  return `${baseInstructions.trim()}\n\n${specialtyAddendum(specialty)}`;
}
