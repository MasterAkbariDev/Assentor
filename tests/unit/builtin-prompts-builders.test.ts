import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  builtinPromptDir,
  PromptLibrary,
  renderPrompt,
  templateVariables,
  type PromptDefinition,
} from "../../src/prompts/index.js";

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

/** Same words the stall detector treats as waiting for confirmation (phase-steering.ts). */
const STALL_PHRASES = [
  /should i (proceed|continue|start)/i,
  /would you like me to (proceed|continue|implement)/i,
  /let me know if you want me to/i,
  /shall i (go ahead|move to|proceed)/i,
  /ready to proceed to phase/i,
];

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

  it.each(Object.keys(EXPECTED))("%s has the five sections in order", (id) => {
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
    for (const pattern of STALL_PHRASES) {
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
  });
});

describe("planner output", () => {
  it("is subtasks, with a fenced JSON example whose ids and dependencies are valid", () => {
    const def = prompt("planner");
    expect(def.output).toBe("subtasks");

    const match = /```json\n([\s\S]*?)\n```/.exec(def.body);
    expect(match).not.toBeNull();
    const example = JSON.parse(match![1]!) as {
      subtasks: Array<{ id: string; description: string; ownedPaths: string[]; dependsOn: string[] }>;
    };

    const seen = new Set<string>();
    for (const subtask of example.subtasks) {
      expect(typeof subtask.description).toBe("string");
      expect(Array.isArray(subtask.ownedPaths)).toBe(true);
      for (const dep of subtask.dependsOn) {
        expect(seen.has(dep), `${subtask.id} depends on ${dep}, which comes earlier`).toBe(true);
      }
      expect(seen.has(subtask.id)).toBe(false);
      seen.add(subtask.id);
    }
    expect(seen.size).toBe(example.subtasks.length);
  });

  it("states that ownedPaths must not overlap unless a dependency orders them", () => {
    expect(prompt("planner").body).toMatch(/ownedPaths/);
    expect(prompt("planner").body).toMatch(/do not overlap/i);
  });
});

describe("integrator", () => {
  it("never drops one side of a conflict silently", () => {
    const body = prompt("integrator").body;
    expect(body).toMatch(/never delete one side/i);
    expect(body).toMatch(/silent/i);
  });
});

describe("devops escaping", () => {
  it("writes a workflow expression as a literal that renders with its braces", () => {
    const def = prompt("devops");
    const values = Object.fromEntries(def.variables.map((name) => [name, "x"]));
    expect(renderPrompt(def.body, values)).toContain("${{ secrets.RELEASE_TOKEN }}");
  });
});
