import { describe, expect, it } from "vitest";
import { STALL_PATTERNS } from "../../src/orchestrator/phase-steering.js";
import { EvidenceRequestItemSchema } from "../../src/protocol/messages.js";
import { makeReviewResult } from "../../src/protocol/review-result.js";
import {
  PromptLibrary,
  renderPrompt,
  templateVariables,
  type PromptDefinition,
} from "../../src/prompts/index.js";

/** Reviewer roles (T03-03a) and the specialty each one carries, with the permissions, output, and variables they must declare. */
const REVIEWERS: Record<
  string,
  {
    role: "reviewer" | "meta";
    specialty?: string;
    output: "review-result" | "text";
    variables: string[];
  }
> = {
  "architecture-reviewer": {
    role: "reviewer",
    specialty: "architecture",
    output: "review-result",
    variables: ["goal", "projectSummary", "diff", "evidence"],
  },
  "code-reviewer": {
    role: "reviewer",
    specialty: "code",
    output: "review-result",
    variables: ["goal", "acceptanceCriteria", "diff", "evidence"],
  },
  "security-reviewer": {
    role: "reviewer",
    specialty: "security",
    output: "review-result",
    variables: ["goal", "diff", "evidence"],
  },
  "performance-reviewer": {
    role: "reviewer",
    specialty: "performance",
    output: "review-result",
    variables: ["goal", "diff", "evidence"],
  },
  "ux-reviewer": {
    role: "reviewer",
    specialty: "ui",
    output: "review-result",
    variables: ["goal", "diff", "evidence"],
  },
  "test-reviewer": {
    role: "reviewer",
    specialty: "testing",
    output: "review-result",
    variables: ["goal", "acceptanceCriteria", "testOutput", "evidence"],
  },
  "devils-advocate": {
    role: "reviewer",
    output: "text",
    variables: ["goal", "diff", "evidence"],
  },
  summarizer: {
    role: "meta",
    output: "text",
    variables: ["goal", "evidence", "reviewFeedback"],
  },
};

/** The T03-02 vocabulary plus `evidence` (T03-03a). */
const VOCABULARY = new Set([
  "goal",
  "acceptanceCriteria",
  "projectSummary",
  "plan",
  "subtask",
  "diff",
  "testOutput",
  "errorLog",
  "conflicts",
  "reviewFeedback",
  "evidence",
]);

const SECTIONS = ["## Mission", "## Inputs", "## Process", "## Output format", "## Rules"];

const VENDOR_NAMES = /claude|gpt|gemini|openai|anthropic|cursor|codex|copilot/i;

const library = PromptLibrary.loadBuiltinSync();

function prompt(id: string): PromptDefinition {
  const found = library.get(id);
  if (!found) {
    throw new Error(`missing built-in prompt ${id}`);
  }
  return found;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The bullets under "Required checks:" and "Evidence rules:" in a specialty
 * prompt, with the leading "- " removed. Read from the specialty files, so the
 * reviewer prompts are checked against the text the review pipeline uses.
 */
function specialtyBullets(specialtyId: string): string[] {
  const lines = prompt(specialtyId).body.split("\n");
  const bullets: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line === "Required checks:" || line === "Evidence rules:") {
      inSection = true;
      continue;
    }
    if (line.trim() === "") {
      inSection = false;
      continue;
    }
    if (inSection && line.startsWith("- ")) {
      bullets.push(line.slice(2));
    }
  }
  return bullets;
}

/** The JSON example in a review-result prompt: exactly one fenced block. */
function jsonExample(body: string): unknown {
  const matches = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
  expect(matches, "exactly one json example").toHaveLength(1);
  return JSON.parse(matches[0]![1]!);
}

describe("built-in reviewer prompts load", () => {
  it("the built-in library has zero load errors", () => {
    expect(library.errors).toEqual([]);
  });

  it.each(Object.keys(REVIEWERS))("%s is a loaded prompt with its id, title, and version", (id) => {
    const def = prompt(id);
    expect(def.id).toBe(id);
    expect(def.title.trim().length).toBeGreaterThan(0);
    expect(def.icon.trim().split(/\s+/)).toHaveLength(1);
    expect(def.recommendedModels).toEqual([]);
    expect(def.version).toBe(1);
  });
});

describe("built-in reviewer prompt contract", () => {
  it.each(Object.entries(REVIEWERS))("%s has the right role, permissions, and output", (id, expected) => {
    const def = prompt(id);
    expect(def.role).toBe(expected.role);
    expect(def.permissions).toBe("read-only");
    expect(def.output).toBe(expected.output);
  });

  it.each(Object.entries(REVIEWERS))("%s declares exactly the variables its body uses", (id, expected) => {
    const def = prompt(id);
    expect([...def.variables].sort()).toEqual([...expected.variables].sort());
    expect(new Set(templateVariables(def.body))).toEqual(new Set(def.variables));
    for (const variable of def.variables) {
      expect(VOCABULARY.has(variable), `${id} uses ${variable}`).toBe(true);
    }
  });

  it.each(Object.keys(REVIEWERS))("%s has the five body sections in order", (id) => {
    const headings = prompt(id)
      .body.split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual(SECTIONS);
  });

  it.each(Object.keys(REVIEWERS))("%s is between 300 and 900 words", (id) => {
    const count = words(prompt(id).body);
    expect(count, `${id} has ${count} words`).toBeGreaterThanOrEqual(300);
    expect(count, `${id} has ${count} words`).toBeLessThanOrEqual(900);
  });

  it.each(Object.keys(REVIEWERS))("%s renders with dummy values for its variables", (id) => {
    const def = prompt(id);
    const values = Object.fromEntries(def.variables.map((name) => [name, `<${name}>`]));
    const rendered = renderPrompt(def.body, values);
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    for (const name of def.variables) {
      expect(rendered).toContain(`<${name}>`);
    }
  });

  it.each(Object.keys(REVIEWERS))("%s has no vendor or model names", (id) => {
    expect(prompt(id).body).not.toMatch(VENDOR_NAMES);
  });

  it.each(Object.keys(REVIEWERS))("%s has no stall-trigger phrases", (id) => {
    for (const pattern of STALL_PATTERNS) {
      expect(prompt(id).body).not.toMatch(pattern);
    }
  });

  it.each(Object.keys(REVIEWERS))("%s carries the shared rules", (id) => {
    const body = prompt(id).body;
    expect(body).toMatch(/never edit files, and never run commands that change the repository/i);
    expect(body).toContain("Cite the files and evidence you read");
    expect(body).toMatch(/do not claim tests pass/i);
    expect(body).toMatch(/never ask permission to continue/i);
    if (REVIEWERS[id]!.output === "review-result") {
      expect(body).toContain("If a file is not in the evidence pack, request it; never assume its contents.");
      expect(body).toContain("below 0.5 means you want more evidence");
    }
  });
});

describe("specialty bullets are carried verbatim", () => {
  const specialtyRoles = Object.entries(REVIEWERS).filter(([, expected]) => expected.specialty);

  it.each(specialtyRoles)("%s contains every Required check and Evidence rule of its specialty", (id, expected) => {
    const bullets = specialtyBullets(`specialty-${expected.specialty}`);
    expect(bullets.length, `specialty-${expected.specialty} has bullets`).toBeGreaterThan(0);
    const body = prompt(id).body;
    for (const bullet of bullets) {
      expect(body, bullet).toContain(bullet);
    }
  });
});

describe("review-result prompts", () => {
  const reviewRoles = Object.entries(REVIEWERS).filter(([, expected]) => expected.output === "review-result");

  it.each(reviewRoles)("%s has one JSON example that is a valid ReviewResult", (id) => {
    const example = jsonExample(prompt(id).body);
    expect(() => makeReviewResult(example as Parameters<typeof makeReviewResult>[0])).not.toThrow();
    expect((example as { status: string }).status).toBe("NEEDS_WORK");
  });

  it.each(reviewRoles)("%s states the PASS and NEEDS_WORK schema rules", (id) => {
    const body = prompt(id).body;
    expect(body).toContain("PASS has no requiredChanges, no evidenceRequests, and no blocker or major issues");
    expect(body).toContain("NEEDS_WORK has at least one issue, requiredChange, or evidenceRequest");
    expect(body).toContain("Use FAILED only when the review could not be done at all.");
    expect(body).toContain("Use BLOCKED when a human must decide, with the question in summary.");
    expect(body).toContain(
      "Missing evidence: return NEEDS_WORK with evidenceRequests. A human must decide: return BLOCKED with the question in summary. Use FAILED only when the review could not be done at all.",
    );
    expect(body).not.toContain("say the one specific question in summary, use FAILED");
  });

  it.each(reviewRoles)("%s describes a clean PASS and says how to read confidence", (id) => {
    const body = prompt(id).body;
    expect(body).toContain(
      "A clean PASS has every acceptance criterion satisfied, only minor or info issues, and empty requiredChanges and evidenceRequests.",
    );
    expect(body).toContain("Confidence is a number from 0 to 1; below 0.5 means you want more evidence.");
  });

  it("the security example's blocker quotes the code it cites", () => {
    const example = jsonExample(prompt("security-reviewer").body) as {
      issues: Array<{ severity: string; evidence: string[] }>;
    };
    const blockers = example.issues.filter((issue) => issue.severity === "blocker" || issue.severity === "major");
    expect(blockers.length).toBeGreaterThan(0);
    for (const issue of blockers) {
      expect(issue.evidence.some((item) => item.trim().length > 0)).toBe(true);
    }
  });

  it("the security reviewer never downgrades a blocker to an optional change", () => {
    expect(prompt("security-reviewer").body).toMatch(/Never put a blocker or major security finding under optionalChanges/);
  });
});

describe("devils-advocate", () => {
  it("argues the strongest alternative and ends with what would change its mind", () => {
    const body = prompt("devils-advocate").body;
    expect(body).toMatch(/### Strongest alternative/);
    const headings = body
      .split("\n")
      .filter((line) => line.startsWith("### "));
    const outputHeadings = headings.slice(headings.indexOf("### Approach under test"));
    expect(outputHeadings.at(-1)).toBe("### What would change my mind");
    expect(body).toContain("What would change my mind");
  });
});

describe("summarizer", () => {
  it("is a meta prompt that makes no new judgments and gives no verdict", () => {
    const def = prompt("summarizer");
    expect(def.role).toBe("meta");
    expect(def.output).toBe("text");
    expect(prompt("summarizer").body).toMatch(/Make no new judgments and give no verdict/);
  });
});

const REVIEW_ROLE_IDS = Object.entries(REVIEWERS)
  .filter(([, expected]) => expected.output === "review-result")
  .map(([id]) => id);

/** The evidence kinds the prompts list, with a sample item for each that must parse. */
const KIND_SAMPLES: Array<{ kind: string; item: Record<string, unknown> }> = [
  { kind: "file", item: { kind: "file", path: "src/a.ts" } },
  { kind: "files", item: { kind: "files", paths: ["src/a.ts", "src/b.ts"] } },
  { kind: "search", item: { kind: "search", query: "parseRange" } },
  { kind: "symbol", item: { kind: "symbol", symbol: "parseRange" } },
  { kind: "callers", item: { kind: "callers", symbol: "parseRange" } },
  { kind: "config", item: { kind: "config", path: ".assentor/config.yaml" } },
  { kind: "test", item: { kind: "test" } },
  { kind: "screenshot", item: { kind: "screenshot", description: "settings page" } },
  { kind: "architecture", item: { kind: "architecture" } },
  { kind: "project_structure", item: { kind: "project_structure" } },
];

describe("evidence requests", () => {
  it.each(REVIEW_ROLE_IDS)("%s's example evidence requests all parse with EvidenceRequestItemSchema", (id) => {
    const example = jsonExample(prompt(id).body) as { evidenceRequests: unknown[] };
    for (const item of example.evidenceRequests) {
      expect(() => EvidenceRequestItemSchema.parse(item)).not.toThrow();
    }
  });

  it.each(["architecture-reviewer", "security-reviewer", "ux-reviewer"])(
    "%s's example carries at least one valid evidence request",
    (id) => {
      const example = jsonExample(prompt(id).body) as { evidenceRequests: unknown[] };
      expect(example.evidenceRequests.length).toBeGreaterThan(0);
    },
  );

  it("test-reviewer asks for the test kind, not a command", () => {
    const example = jsonExample(prompt("test-reviewer").body) as { evidenceRequests: unknown[] };
    expect(example.evidenceRequests).toEqual([{ kind: "test" }]);
  });

  it.each(KIND_SAMPLES)("the $kind kind parses with its listed fields", ({ item }) => {
    expect(() => EvidenceRequestItemSchema.parse(item)).not.toThrow();
  });

  it.each(REVIEW_ROLE_IDS)("%s lists every kind it may request, and warns about invalid items", (id) => {
    const body = prompt(id).body;
    for (const { kind } of KIND_SAMPLES) {
      expect(body, `${id} names ${kind}`).toContain(`\`${kind}\``);
    }
    expect(body).toContain("Any other kind, or a missing field, makes the whole review unreadable");
  });
});

describe("redaction", () => {
  it("the security reviewer quotes a leaked secret with the value replaced by [REDACTED]", () => {
    expect(prompt("security-reviewer").body).toContain(
      "For a leaked secret, the evidence is the file, the line and the key name, with the value replaced by `[REDACTED]`; that still counts as quoted evidence.",
    );
  });

  it("the security example's evidence contains [REDACTED] and is a valid ReviewResult", () => {
    const example = jsonExample(prompt("security-reviewer").body) as {
      issues: Array<{ evidence: string[] }>;
    };
    expect(example.issues.some((issue) => issue.evidence.some((item) => item.includes("[REDACTED]")))).toBe(true);
    expect(() => makeReviewResult(example as Parameters<typeof makeReviewResult>[0])).not.toThrow();
  });

  it.each(["security-reviewer", "devils-advocate", "summarizer"])(
    "%s never echoes a secret value and keeps [REDACTED] markers",
    (id) => {
      expect(prompt(id).body).toContain(
        "Never echo a secret value; name the file and key only. Keep existing `[REDACTED]` markers as they are.",
      );
    },
  );
});

describe("ux-reviewer covers command-line tools", () => {
  it("names the CLI checks next to the web checks", () => {
    const body = prompt("ux-reviewer").body;
    expect(body).toContain("For a command-line change, apply the same checks to the CLI:");
    expect(body).toContain("`--help` and usage text");
    expect(body).toContain("Error messages name the fix, not only the failure.");
    expect(body).toContain("Exit codes:");
    expect(body).toContain("stdout vs stderr:");
    expect(body).toContain("`NO_COLOR`");
    expect(body).toContain("Progress output for long operations:");
  });

  it("its example is a CLI case, not a web component", () => {
    const example = jsonExample(prompt("ux-reviewer").body) as { summary: string; issues: Array<{ evidence: string[] }> };
    expect(JSON.stringify(example)).toContain("assentor import");
    expect(JSON.stringify(example)).not.toContain("SettingsForm");
  });
});

describe("performance-reviewer covers Node hotspots", () => {
  it("names the Node hotspots", () => {
    const body = prompt("performance-reviewer").body;
    expect(body).toContain("synchronous fs calls inside loops or request handlers");
    expect(body).toContain("one subprocess spawned per file where one batched call would do");
    expect(body).toContain("whole files read into memory where a stream would do");
    expect(body).toContain("unbounded Promise.all over input that can grow");
  });
});
