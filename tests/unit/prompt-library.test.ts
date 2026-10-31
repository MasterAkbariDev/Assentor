import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  builtinPromptDir,
  MAX_PROMPT_FILE_BYTES,
  PromptLibrary,
  renderPrompt,
  SPECIALTY_PROMPT_ADDENDA,
  splitPromptFile,
  TemplateError,
  templateVariables,
} from "../../packages/engine/src/index.js";

const repoRoot = path.resolve(__dirname, "../..");

function prompt(id: string, fields: Record<string, string> = {}, body = `Body of ${id}.`): string {
  const front = { role: "builder", title: id, version: "1", ...fields };
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return `---\nid: ${id}\n${lines.join("\n")}\n---\n${body}\n`;
}

function child(id: string, parent: string, fields: Record<string, string> = {}, body = `Body of ${id}.`): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\nid: ${id}\nextends: ${parent}\n${lines.join("\n")}\n---\n${body}\n`;
}

describe("renderPrompt", () => {
  it("fills variables and repeats each blocks", () => {
    const text = renderPrompt(
      "Goal: {{goal}}\n{{#each criteria}}- {{this}}\n{{/each}}{{#each files}}{{path}} ({{goal}})\n{{/each}}",
      {
        goal: "average",
        criteria: ["handles empty", "rounds"],
        files: [{ path: "a.ts" }, { path: "b.ts" }],
      },
    );
    expect(text).toBe(
      "Goal: average\n- handles empty\n- rounds\na.ts (average)\nb.ts (average)\n",
    );
  });

  it("inserts values literally and never re-expands them", () => {
    expect(renderPrompt("{{a}}", { a: "{{b}} and {{#each x}}" })).toBe("{{b}} and {{#each x}}");
  });

  it("lists every missing variable", () => {
    try {
      renderPrompt("{{a}} {{b}} {{a}} {{#each items}}{{c}}{{/each}}", { b: "ok" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as TemplateError).missing).toEqual(["a", "items"]);
      expect((error as Error).message).toBe("Missing template variables: a, items");
    }
  });

  it("rejects anything but {{name}} and {{#each}}", () => {
    for (const template of [
      "{{#if x}}y{{/if}}",
      "{{> partial}}",
      "{{a.b}}",
      "{{a | upper}}",
      "{{}}",
      "{{{raw}}}",
      "{{constructor.name}}",
    ]) {
      expect(() => renderPrompt(template, { x: "1", a: "2", raw: "3" }), template).toThrow(
        TemplateError,
      );
    }
    expect(() => renderPrompt("{{#each a}}x", { a: [] })).toThrow(/Unclosed/);
    expect(() => renderPrompt("x{{/each}}", {})).toThrow(/without a matching/);
    expect(() => renderPrompt("x {{a", { a: "1" })).toThrow(/Unclosed \{\{/);
  });

  it("does not read inherited object properties", () => {
    expect(() => renderPrompt("{{toString}}", {})).toThrow(/Missing template variables: toString/);
    const items = JSON.parse('[{"__proto__": {"polluted": "yes"}, "name": "a"}]');
    expect(() => renderPrompt("{{#each items}}{{polluted}}{{/each}}", { items })).toThrow(
      /Missing template variables: polluted/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("writes a literal {{ for \\{{", () => {
    expect(renderPrompt("run: $\\{{ github.sha }} for {{goal}}", { goal: "ci" })).toBe(
      "run: ${{ github.sha }} for ci",
    );
    expect(templateVariables("$\\{{ github.sha }}")).toEqual([]);
  });

  it("parses hostile input in linear time", () => {
    const started = Date.now();
    expect(() => templateVariables("{{".repeat(128 * 1024))).toThrow(TemplateError);
    expect(() => templateVariables("{{a}".repeat(64 * 1024))).toThrow(TemplateError);
    expect(() => templateVariables("}}{{x}}".repeat(32 * 1024))).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("lists top-level variables", () => {
    expect(templateVariables("{{goal}} {{#each files}}{{path}}{{this}}{{/each}} {{goal}}")).toEqual([
      "goal",
      "files",
    ]);
  });
});

describe("splitPromptFile", () => {
  it("accepts CRLF and a BOM", () => {
    const parsed = splitPromptFile("﻿---\r\nid: a\r\nrole: meta\r\n---\r\nLine 1\r\nLine 2\r\n\r\n");
    expect(parsed.frontMatter).toEqual({ id: "a", role: "meta" });
    expect(parsed.body).toBe("Line 1\nLine 2");
  });

  it("requires a front-matter block holding a mapping", () => {
    expect(() => splitPromptFile("no front matter")).toThrow(/front-matter/);
    expect(() => splitPromptFile("---\n- a\n- b\n---\nbody")).toThrow(/mapping/);
    expect(() => splitPromptFile("---\nid: [unclosed\n---\nbody")).toThrow(/invalid YAML/);
  });
});

describe("PromptLibrary", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let projectPath: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-library-"));
    builtinDir = path.join(root, "builtin");
    userDir = path.join(root, "user");
    projectPath = path.join(root, "project");
    projectDir = path.join(projectPath, ".assentor", "prompts");
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = (dir: string, name: string, text: string) =>
    fs.writeFile(path.join(dir, name), text, "utf8");
  const load = () => PromptLibrary.load({ builtinDir, userDir, projectPath });

  it("lets a higher layer replace the whole prompt", async () => {
    await write(builtinDir, "planner.md", prompt("planner", { icon: "map" }, "builtin plan"));
    await write(userDir, "planner.md", prompt("planner", {}, "user plan"));
    await write(builtinDir, "coder.md", prompt("coder", {}, "builtin code"));
    await write(userDir, "coder.md", prompt("coder", {}, "user code"));
    await write(projectDir, "coder.md", prompt("coder", { role: "reviewer" }, "project code"));

    const library = await load();
    expect(library.errors).toEqual([]);
    expect(library.get("planner")).toMatchObject({ layer: "user", body: "user plan", icon: "" });
    expect(library.get("coder")).toMatchObject({
      layer: "project",
      body: "project code",
      role: "reviewer",
    });
    expect(library.list().map((p) => p.id)).toEqual(["coder", "planner"]);
    expect(library.list("reviewer").map((p) => p.id)).toEqual(["coder"]);
  });

  it("extends: inherits front-matter, child keys win, body appended", async () => {
    await write(
      builtinDir,
      "code-reviewer.md",
      prompt("code-reviewer", { role: "reviewer", icon: "eye", variables: "[goal]", output: "review-result" }, "Review {{goal}}."),
    );
    await write(projectDir, "strict-reviewer.md", child("strict-reviewer", "code-reviewer", { title: "Strict" }, "Be strict."));
    // A prompt may extend its own id to build on the lower layer's version.
    await write(userDir, "code-reviewer.md", child("code-reviewer", "code-reviewer", { version: "2" }, "Cite files."));

    const library = await load();
    expect(library.errors).toEqual([]);
    expect(library.get("code-reviewer")).toMatchObject({
      layer: "user",
      version: 2,
      icon: "eye",
      body: "Review {{goal}}.\n\nCite files.",
    });
    expect(library.get("strict-reviewer")).toMatchObject({
      role: "reviewer",
      title: "Strict",
      output: "review-result",
      variables: ["goal"],
      extends: "code-reviewer",
      body: "Review {{goal}}.\n\nCite files.\n\nBe strict.",
    });
    expect(library.render("strict-reviewer", { goal: "average()" })).toBe(
      "Review average().\n\nCite files.\n\nBe strict.",
    );
  });

  it("detects extends cycles and unknown parents", async () => {
    await write(projectDir, "a.md", child("a", "b"));
    await write(projectDir, "b.md", child("b", "a"));
    await write(projectDir, "c.md", child("c", "missing"));
    await write(projectDir, "d.md", child("d", "a"));
    await write(projectDir, "ok.md", prompt("ok"));

    const library = await load();
    expect(library.has("ok")).toBe(true);
    expect(["a", "b", "c", "d"].some((id) => library.has(id))).toBe(false);
    const messages = library.errors.map((e) => `${path.basename(e.file)}: ${e.message}`);
    expect(messages.sort()).toEqual([
      "a.md: extends cycle: a → b → a",
      "b.md: extends cycle: a → b → a",
      'c.md: extends unknown prompt "missing"',
      'd.md: extends "a", which failed to load',
    ]);
  });

  it("reports a failed parent against the parent's file, not the child's", async () => {
    await write(builtinDir, "z-parent.md", prompt("z-parent"));
    await write(userDir, "z-parent.md", prompt("z-parent", { role: "boss" }));
    await write(userDir, "a-child.md", child("a-child", "z-parent"));

    const library = await load();
    expect(library.get("z-parent")).toMatchObject({ layer: "builtin" });
    expect(library.has("a-child")).toBe(false);
    const messages = library.errors.map((e) => `${path.basename(e.file)}: ${e.message}`);
    expect(messages).toHaveLength(2);
    expect(messages).toContainEqual('a-child.md: extends "z-parent", which failed to load');
    expect(messages.find((m) => m.startsWith("z-parent.md: "))).toMatch(/role/);
  });

  it("records which layer a prompt overrides and every loaded version", async () => {
    await write(builtinDir, "planner.md", prompt("planner", {}, "builtin"));
    await write(projectDir, "planner.md", prompt("planner", {}, "project"));
    await write(projectDir, "fresh.md", prompt("fresh"));

    const library = await load();
    expect(library.get("planner")).toMatchObject({ layer: "project", overrides: "builtin" });
    expect(library.get("fresh")!.overrides).toBeUndefined();
    expect(library.versions("planner").map((p) => [p.layer, p.body])).toEqual([
      ["builtin", "builtin"],
      ["project", "project"],
    ]);
    expect(library.versions("nope")).toEqual([]);
  });

  it("collects invalid files and keeps loading the rest", async () => {
    await write(builtinDir, "planner.md", prompt("planner", {}, "builtin plan"));
    await write(userDir, "planner.md", prompt("planner", { role: "boss" }));
    await write(userDir, "typo.md", prompt("typo", { titel: "x" }));
    await write(userDir, "wrong-name.md", prompt("other"));
    await write(userDir, "Bad_Id.md", prompt("Bad_Id"));
    await write(userDir, "broken.md", "no front matter");
    await write(userDir, "syntax.md", prompt("syntax", {}, "{{#if x}}"));
    await write(userDir, "good.md", prompt("good"));

    const library = await load();
    expect(library.has("good")).toBe(true);
    // A bad override leaves the built-in in place.
    expect(library.get("planner")).toMatchObject({ layer: "builtin", body: "builtin plan" });
    const byFile = Object.fromEntries(library.errors.map((e) => [path.basename(e.file), e]));
    expect(Object.keys(byFile).sort()).toEqual([
      "Bad_Id.md",
      "broken.md",
      "planner.md",
      "syntax.md",
      "typo.md",
      "wrong-name.md",
    ]);
    expect(byFile["planner.md"]!.message).toMatch(/role/);
    expect(byFile["typo.md"]!.message).toMatch(/titel|Unrecognized/);
    expect(byFile["wrong-name.md"]!.message).toMatch(/match the file name/);
    expect(byFile["planner.md"]!.layer).toBe("user");
  });

  it("reads only .md files directly inside the layer directory", async () => {
    await write(projectDir, "notes.txt", "ignored");
    await fs.mkdir(path.join(projectDir, "nested"));
    await write(path.join(projectDir, "nested"), "deep.md", prompt("deep"));
    await fs.mkdir(path.join(projectDir, "dir.md"));
    await write(projectDir, "big.md", prompt("big", {}, "x".repeat(MAX_PROMPT_FILE_BYTES)));
    await write(projectDir, "shout.MD", prompt("shout"));

    const library = await load();
    expect(library.has("deep")).toBe(false);
    expect(library.list()).toEqual([]);
    expect(library.errors.map((e) => `${path.basename(e.file)}: ${e.message}`).sort()).toEqual([
      `big.md: file is larger than ${MAX_PROMPT_FILE_BYTES} bytes`,
      "shout.MD: prompt files must end in lowercase .md",
    ]);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink that escapes the directory", async () => {
    const outside = path.join(root, "outside.md");
    await fs.writeFile(outside, prompt("escape"), "utf8");
    await fs.symlink(outside, path.join(projectDir, "escape.md"));
    await write(projectDir, "real-target.md", prompt("real-target"));
    await fs.symlink(path.join(projectDir, "real-target.md"), path.join(projectDir, "inside.md"));

    const library = await load();
    expect(library.has("escape")).toBe(false);
    expect(library.errors).toContainEqual(
      expect.objectContaining({
        file: path.join(projectDir, "escape.md"),
        message: "symlink points outside the prompt directory",
      }),
    );
    // A symlink that stays inside is read (its id must match the link name).
    expect(library.errors).toContainEqual(
      expect.objectContaining({ file: path.join(projectDir, "inside.md") }),
    );
    expect(library.has("real-target")).toBe(true);
  });

  it("treats missing layer directories as empty", async () => {
    const library = await PromptLibrary.load({
      builtinDir: path.join(root, "nope"),
      userDir: path.join(root, "nope-too"),
    });
    expect(library.list()).toEqual([]);
    expect(library.errors).toEqual([]);
  });

  it("renders with missing-variable errors", async () => {
    await write(builtinDir, "goal.md", prompt("goal", { variables: "[goal]" }, "Do {{goal}} with {{extra}}"));
    const library = await load();
    expect(() => library.render("goal", { goal: "x" })).toThrow("Missing template variables: extra");
    expect(() => library.render("nope")).toThrow(/Unknown prompt/);
  });
});

describe("built-in prompts", () => {
  it("ship in the package and load without errors", async () => {
    expect(builtinPromptDir()).toBe(path.join(repoRoot, "prompts", "builtin"));
    const library = PromptLibrary.loadBuiltinSync();
    expect(library.errors).toEqual([]);
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.files).toContain("prompts");
  });

  it("keeps the reviewer specialty addenda text identical (v0.3.19 snapshot)", async () => {
    const expected = JSON.parse(
      await fs.readFile(path.join(repoRoot, "tests", "fixtures", "specialty-addenda.json"), "utf8"),
    );
    expect(SPECIALTY_PROMPT_ADDENDA).toEqual(expected);
  });
});
