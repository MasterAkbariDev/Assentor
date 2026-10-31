import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STALL_PATTERNS } from "../../packages/engine/src/orchestrator/phase-steering.js";
import {
  builtinPromptDir,
  PromptLibrary,
  renderPrompt,
  templateVariables,
  type PromptDefinition,
} from "../../packages/engine/src/prompts/index.js";

/** The eleven builder prompts (T03-02), with the permissions, output, and variables each one must declare. */
const EXPECTED: Record<
  string,
  { permissions: "read-only" | "edit"; output: "subtasks" | "text"; variables: string[] }
> = {
  planner: {
    permissions: "read-only",
    output: "subtasks",
    variables: ["goal", "acceptanceCriteria", "projectSummary"],
  },
  architect: {
    permissions: "read-only",
    output: "text",
    variables: ["goal", "projectSummary", "acceptanceCriteria"],
  },
  engineer: { permissions: "edit", output: "text", variables: ["goal", "subtask", "acceptanceCriteria"] },
  refactorer: { permissions: "edit", output: "text", variables: ["goal", "subtask", "testOutput"] },
  debugger: { permissions: "edit", output: "text", variables: ["goal", "errorLog", "testOutput"] },
  "test-writer": {
    permissions: "edit",
    output: "text",
    variables: ["goal", "acceptanceCriteria", "projectSummary"],
  },
  "docs-writer": { permissions: "edit", output: "text", variables: ["goal", "diff", "projectSummary"] },
  devops: { permissions: "edit", output: "text", variables: ["goal", "projectSummary", "errorLog"] },
  "db-migrations": {
    permissions: "edit",
    output: "text",
    variables: ["goal", "projectSummary", "acceptanceCriteria"],
  },
  "requirements-analyst": {
    permissions: "read-only",
    output: "text",
    variables: ["goal", "projectSummary", "acceptanceCriteria"],
  },
  integrator: { permissions: "edit", output: "text", variables: ["goal", "conflicts", "diff"] },
};

/** Roles that may not change the repository (review item 3). */
const READ_ONLY = ["planner", "architect", "requirements-analyst"];

/** Roles whose reply ends with a handoff block (review item 9). */
const EDIT_ROLES = [
  "engineer",
  "refactorer",
  "debugger",
  "integrator",
  "test-writer",
  "docs-writer",
  "devops",
  "db-migrations",
];

/** The keys the review pipeline reads from the handoff block. */
const HANDOFF_KEYS = [
  "architectureSummary",
  "assumptions",
  "limitations",
  "risks",
  "unchanged",
  "why",
  "whatChanged",
];

/** The last sentence of "Rules", which tells the role how long to keep working. */
const FINAL_PHRASE: Record<string, string> = {
  planner: "until the plan is complete",
  "requirements-analyst": "until the requirements are complete",
  architect: "until the design is complete",
  integrator: "until the merge is resolved",
};

/** Variable names the builder prompts may use (plan §4.5 vocabulary). */
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

/** Every fenced ```json block in `body`, parsed, in order. */
function jsonBlocks(body: string): unknown[] {
  return [...body.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
}

/** The text of the last fenced ```json block in `body`, and where it starts. */
function lastJsonBlock(body: string): { text: string; start: number } {
  const matches = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
  const last = matches.at(-1);
  if (!last) {
    throw new Error("no json block");
  }
  return { text: last[1]!, start: last.index! };
}

describe("built-in builder prompts load", () => {
  it("the built-in library has zero load errors", () => {
    expect(library.errors).toEqual([]);
  });

  it("every builder prompt file is a loaded prompt, so nothing else in the folder is loaded by accident", () => {
    const files = readdirSync(builtinPromptDir()).filter((file) => file.endsWith(".md"));
    for (const file of files) {
      expect(library.get(file.replace(/\.md$/, "")), file).toBeDefined();
    }
  });

  it.each(Object.keys(EXPECTED))("%s is a builder prompt with its id, title, and version", (id) => {
    const def = prompt(id);
    expect(def.id).toBe(id);
    expect(def.role).toBe("builder");
    expect(def.title.trim().length).toBeGreaterThan(0);
    expect(def.description.split(/\s+/).length).toBeGreaterThan(3);
    expect(def.icon.trim().split(/\s+/)).toHaveLength(1);
    expect(def.recommendedModels).toEqual([]);
    expect(def.version).toBe(1);
  });
});

describe("built-in builder prompt contract", () => {
  it.each(Object.entries(EXPECTED))("%s has the right permissions and output", (id, expected) => {
    const def = prompt(id);
    expect(def.permissions).toBe(expected.permissions);
    expect(def.output).toBe(expected.output);
  });

  it.each(Object.entries(EXPECTED))("%s declares exactly the variables its body uses", (id, expected) => {
    const def = prompt(id);
    expect([...def.variables].sort()).toEqual([...expected.variables].sort());
    expect(new Set(templateVariables(def.body))).toEqual(new Set(def.variables));
    for (const variable of def.variables) {
      expect(VOCABULARY.has(variable), `${id} uses ${variable}`).toBe(true);
    }
  });

  it.each(Object.keys(EXPECTED))("%s has the five body sections in order", (id) => {
    const headings = prompt(id)
      .body.split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual(SECTIONS);
  });

  it.each(Object.keys(EXPECTED))("%s is between 300 and 900 words", (id) => {
    const count = words(prompt(id).body);
    expect(count, `${id} has ${count} words`).toBeGreaterThanOrEqual(300);
    expect(count, `${id} has ${count} words`).toBeLessThanOrEqual(900);
  });

  it.each(Object.keys(EXPECTED))("%s renders with dummy values for its variables", (id) => {
    const def = prompt(id);
    const values = Object.fromEntries(def.variables.map((name) => [name, `<${name}>`]));
    const rendered = renderPrompt(def.body, values);
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    for (const name of def.variables) {
      expect(rendered).toContain(`<${name}>`);
    }
  });

  it.each(Object.keys(EXPECTED))("%s has no vendor or model names", (id) => {
    expect(prompt(id).body).not.toMatch(VENDOR_NAMES);
  });

  it.each(Object.keys(EXPECTED))("%s has no stall-trigger phrases", (id) => {
    for (const pattern of STALL_PATTERNS) {
      expect(prompt(id).body).not.toMatch(pattern);
    }
  });

  it.each(Object.keys(EXPECTED))("%s carries the shared rules", (id) => {
    const body = prompt(id).body;
    expect(body).toContain("Cite the files you read");
    expect(body).toMatch(/do not claim (that )?tests pass/i);
    expect(body).toMatch(/ask one specific question/i);
    expect(body).toContain("Never ask permission to continue");
    expect(body).toContain("Do not stop between phases to ask for confirmation");
    expect(body).toContain(FINAL_PHRASE[id] ?? "until the goal is met");
  });

  it.each(READ_ONLY)("%s is read-only: it never edits files or changes the repository", (id) => {
    expect(prompt(id).body).toMatch(/never edit files, and never run commands that change the repository/i);
    expect(prompt(id).body).toMatch(/installs, formatters, git writes, and migrations/);
  });

  it.each(Object.keys(EXPECTED))("%s does not use a private restatement as output", (id) => {
    expect(prompt(id).body).not.toMatch(/restate .* and confirm/i);
  });
});

describe("planner output", () => {
  const body = () => prompt("planner").body;

  it("is subtasks, and its reply is one fenced JSON block", () => {
    expect(prompt("planner").output).toBe("subtasks");
    expect(body()).toMatch(/Your entire reply is one fenced JSON block/);
  });

  it("has the subtasks example, the blocked shape, and the empty shape, each valid", () => {
    const [main, blocked, empty] = jsonBlocks(body()) as Array<Record<string, unknown>>;
    expect(main).toBeDefined();
    expect(blocked).toBeDefined();
    expect(empty).toBeDefined();

    const subtasks = (main!.subtasks as Array<{ id: string; ownedPaths: string[]; dependsOn: string[] }>);
    // The subtasks example carries no notes; notes are added only when they have content.
    expect(main!.notes).toBeUndefined();
    const seen = new Set<string>();
    for (const subtask of subtasks) {
      expect(Array.isArray(subtask.ownedPaths)).toBe(true);
      for (const dep of subtask.dependsOn) {
        expect(seen.has(dep), `${subtask.id} depends on ${dep}, which comes earlier`).toBe(true);
      }
      expect(seen.has(subtask.id)).toBe(false);
      seen.add(subtask.id);
    }

    expect(blocked).toEqual({
      subtasks: [],
      question: "one specific question",
      notes: "what you already checked",
    });
    expect(empty).toEqual({ subtasks: [], notes: "why no change is needed" });
  });

  it("states the ownership rules: no overlap, and a directory owns everything under it", () => {
    expect(body()).toMatch(/do not overlap/i);
    expect(body()).toMatch(/owns everything under it/);
  });

  it("keeps the restatement private", () => {
    expect(body()).toMatch(/for yourself; do not output the restatement/);
  });

  it("omits notes when they would be empty, and says the blocked shape may carry what was checked", () => {
    expect(body()).toMatch(/Omit `notes` when it would be empty/);
    expect(body()).toMatch(/It may carry `notes` with what you already checked/);
    expect(body()).not.toContain("optional: why a criterion");
  });
});

describe("edit roles hand off even when blocked", () => {
  const EDIT_ROLE_IDS = [
    "engineer",
    "refactorer",
    "debugger",
    "integrator",
    "test-writer",
    "docs-writer",
    "devops",
    "db-migrations",
  ];

  it.each(EDIT_ROLE_IDS)("%s ends with the handoff even when blocked, and puts the question under limitations", (id) => {
    const body = prompt(id).body;
    expect(body).toContain("End the reply with this block, even when you are blocked");
    expect(body).toContain("When you are blocked, put the blocking question under `limitations`.");
  });
});

describe("engineer's source-file rule", () => {
  it("forbids changing source files outside the subtask, and says build output is not source", () => {
    const body = prompt("engineer").body;
    expect(body).toContain("never change source files outside the subtask");
    expect(body).not.toContain("never run commands that change files outside the subtask");
    expect(body).toContain("Build output such as `dist/` is not a source file.");
  });
});

describe("integrator rules", () => {
  const body = () => prompt("integrator").body;

  it("never drops a side silently, and drops one only when it is fully superseded", () => {
    expect(body()).toMatch(/never drop one side/i);
    expect(body()).toMatch(/fully supersedes it/);
  });

  it("never stages, commits, or finishes the merge while a conflict marker remains", () => {
    expect(body()).toMatch(/Never stage, commit, or finish a merge while any conflict marker remains/);
  });

  it("never uses whole-side shortcuts", () => {
    expect(body()).toMatch(/--ours/);
    expect(body()).toMatch(/--theirs/);
    expect(body()).toMatch(/-X ours/);
    expect(body()).toMatch(/Never use `--ours`/);
  });

  it("lists the files left unmerged", () => {
    expect(body()).toContain("### Files left unmerged");
  });
});

describe("devops rules", () => {
  const body = () => prompt("devops").body;

  it("never runs publish, release, or deploy, and never pushes, tags, or triggers remote workflows", () => {
    expect(body()).toMatch(/Never run commands that publish, release, or deploy anything/);
    expect(body()).toMatch(/Never push, tag, or trigger remote workflows/);
  });

  it("never writes a real secret value into a file", () => {
    expect(body()).toMatch(/Never write a real secret value into any file/);
  });

  it("does not widen token permissions or use pull_request_target unless the goal says so", () => {
    expect(body()).toMatch(/Do not widen a workflow's token permissions/);
    expect(body()).toContain("`pull_request_target`");
  });
});

describe("db-migrations rules", () => {
  const body = () => prompt("db-migrations").body;

  it("never edits a committed or applied migration; it adds a new one", () => {
    expect(body()).toMatch(/Never edit a migration that is already committed or applied/);
  });

  it("applies migrations only to a database it created for the test", () => {
    expect(body()).toMatch(/Never apply a migration to a configured, staging, or production database/);
    expect(body()).toMatch(/a database you created for the test/);
  });

  it("states irreversibility under Rollback and never applies irreversible steps to existing data", () => {
    expect(body()).toMatch(/### Rollback\nState whether the migration is irreversible/);
    expect(body()).toMatch(/Never apply an irreversible step to an existing database/);
  });
});

describe("test-writer labels tests meant to fail", () => {
  it("names them with the expected-fail: prefix and reports them under Results", () => {
    const body = prompt("test-writer").body;
    expect(body).toContain("`expected-fail:`");
    expect(body).toMatch(/### Results[\s\S]*expected-fail:/);
  });
});

describe("engineer and refactorer rules", () => {
  it("engineer fixes only its own regressions and reports the rest under Open issues", () => {
    const body = prompt("engineer").body;
    expect(body).toContain("Fix only the regressions your change caused");
    expect(body).toMatch(/Report failures that already existed/);
    expect(body).toMatch(/including test files, is in the subtask's owned paths/);
  });

  it("refactorer updates uses only inside its files, keeps aliases elsewhere, and has Open issues", () => {
    const body = prompt("refactorer").body;
    expect(body).toMatch(/Update uses of anything you rename or move only inside the subtask's files/);
    expect(body).toContain("keep the old name as an alias or re-export");
    expect(body).toContain("Continue only when the results match the baseline");
    expect(body).toContain("### Open issues");
  });
});

describe("handoff block", () => {
  it.each(EDIT_ROLES)("%s ends its reply with a handoff block that has exactly the seven keys", (id) => {
    const body = prompt(id).body;
    expect(body).toContain("### Handoff");
    const block = lastJsonBlock(body);
    expect(block.start).toBeGreaterThan(body.indexOf("### Handoff"));
    expect(block.start).toBeLessThan(body.indexOf("## Rules"));
    const parsed = JSON.parse(block.text) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...HANDOFF_KEYS].sort());
  });

  it.each(READ_ONLY)("%s has no handoff block (it does not edit)", (id) => {
    expect(prompt(id).body).not.toContain("### Handoff");
  });
});
