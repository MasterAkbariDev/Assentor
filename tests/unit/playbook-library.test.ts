import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  builtinPlaybookDir,
  MAX_PLAYBOOK_FILE_BYTES,
  PlaybookLibrary,
  type PlaybookLoadError,
} from "../../packages/engine/src/playbooks/library.js";
import { PromptLibrary, builtinPromptDir } from "../../packages/engine/src/prompts/index.js";

/** A valid two-debater playbook. Edit the text to break one thing at a time. */
function playbookText(id: string): string {
  return [
    `id: ${id}`,
    `title: ${id} title`,
    "description: Test playbook.",
    "teams:",
    "  pair:",
    "    seats:",
    "      - { role: planner }",
    "      - { role: architect }",
    "stages:",
    "  - id: plan",
    "    kind: negotiate",
    "    team: pair",
    "    strategy: debate",
    "",
  ].join("\n");
}

describe("PlaybookLibrary", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let projectPath: string;
  let prompts: PromptLibrary;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "playbook-library-"));
    userDir = path.join(root, "user");
    projectPath = path.join(root, "project");
    builtinDir = builtinPlaybookDir();
    await fs.mkdir(userDir, { recursive: true });
    prompts = await PromptLibrary.load({ builtinDir: builtinPromptDir(), userDir: path.join(root, "no-prompts") });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function write(dir: string, name: string, text: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fs.writeFile(file, text);
    return file;
  }

  function load(extra: { projectPath?: string } = {}) {
    return PlaybookLibrary.load({ builtinDir, userDir, prompts, ...extra });
  }

  function errorFor(errors: readonly PlaybookLoadError[], file: string): string | undefined {
    return errors.find((error) => error.file === file)?.message;
  }

  it("loads the built-ins with no errors", async () => {
    const library = await load();
    expect(library.errors).toEqual([]);
    expect(library.list().length).toBe(12);
  });

  it("a user playbook replaces the built-in with the same id and records it", async () => {
    await write(userDir, "bug-hunt.yaml", playbookText("bug-hunt"));
    const library = await load();
    expect(library.errors).toEqual([]);
    const playbook = library.get("bug-hunt")!;
    expect(playbook.layer).toBe("user");
    expect(playbook.overrides).toBe("builtin");
    expect(playbook.title).toBe("bug-hunt title");
  });

  it("the project layer overrides the user layer", async () => {
    await write(userDir, "custom.yaml", playbookText("custom"));
    await write(path.join(projectPath, ".assentor", "playbooks"), "custom.yaml", playbookText("custom"));
    const library = await load({ projectPath });
    expect(library.get("custom")).toMatchObject({ layer: "project", overrides: "user" });
  });

  it("an invalid override is reported and the built-in stays", async () => {
    const file = await write(userDir, "bug-hunt.yaml", playbookText("bug-hunt").replace("role: planner", "role: nope"));
    const library = await load();
    expect(library.get("bug-hunt")!.layer).toBe("builtin");
    expect(library.list().length).toBe(12);
    expect(errorFor(library.errors, file)).toContain('unknown prompt id "nope"');
  });

  it("rejects bad files with a clear message and never breaks the built-ins", async () => {
    const cases: Array<[name: string, text: string, expected: string]> = [
      ["bad-yaml.yaml", "id: [unclosed\n", "invalid YAML"],
      ["unknown-key.yaml", playbookText("unknown-key") + "color: red\n", "Unrecognized key"],
      ["stage-key.yaml", playbookText("stage-key").replace("strategy: debate", "strategy: debate\n    colour: x"), "Unrecognized key"],
      ["bad-kind.yaml", playbookText("bad-kind").replace("kind: negotiate", "kind: merge"), "kind"],
      ["no-team.yaml", playbookText("no-team").replace("team: pair", "team: missing"), 'unknown team "missing"'],
      ["unused-team.yaml", playbookText("unused-team").replace("stages:\n", "  spare:\n    seats:\n      - { role: planner }\nstages:\n"), 'team "spare" is not used'],
      ["unknown-prompt.yaml", playbookText("unknown-prompt").replace("role: architect", "role: ghost"), 'unknown prompt id "ghost"'],
      ["bad-strategy.yaml", playbookText("bad-strategy").replace("strategy: debate", "strategy: best-of-n"), 'unknown negotiation strategy "best-of-n"'],
      ["bad-review.yaml", playbookText("bad-review").replace("kind: negotiate", "kind: review").replace("strategy: debate", "strategy: vote"), "must be \"panel\""],
      ["read-only-exec.yaml", "readOnly: true\n" + playbookText("read-only-exec").replace("kind: negotiate", "kind: execute").replace(/    team: pair\n    strategy: debate\n/, ""), "read-only playbook cannot have an execute stage"],
      ["edit-seat.yaml", "readOnly: true\n" + playbookText("edit-seat").replace("role: planner }", "role: planner, permissions: edit }"), "cannot have an edit seat"],
      ["cycle.yaml", playbookText("cycle").replace("strategy: debate", "strategy: debate\n    next: back\n  - id: back\n    kind: negotiate\n    team: pair\n    strategy: vote\n    next: plan"), "cycle"],
      ["mismatch.yaml", playbookText("other"), "id must match the file name"],
      ["shouty.YAML", playbookText("shouty"), "must end in lowercase .yaml"],
      ["wrong-ext.yml", playbookText("wrong-ext"), "must end in lowercase .yaml"],
      ["big.yaml", playbookText("big") + "#".repeat(MAX_PLAYBOOK_FILE_BYTES), "larger than"],
    ];
    for (const [name, text, expected] of cases) {
      await write(userDir, name, text);
    }
    const library = await load();
    for (const [name, , expected] of cases) {
      const file = path.join(userDir, name);
      expect(errorFor(library.errors, file), name).toContain(expected);
    }
    expect(library.list().map((playbook) => playbook.layer).every((layer) => layer === "builtin")).toBe(true);
    expect(library.list().length).toBe(12);
  });

  it("refuses a symlink that points outside the playbook directory", async () => {
    const outside = await write(root, "outside.yaml", playbookText("link"));
    const link = path.join(userDir, "link.yaml");
    await fs.symlink(outside, link);
    const library = await load();
    expect(errorFor(library.errors, link)).toContain("symlink points outside");
    expect(library.has("link")).toBe(false);
  });

  it("accepts a symlink that stays inside the playbook directory", async () => {
    const target = await write(path.join(userDir, "shared"), "alias.yaml", playbookText("alias"));
    await fs.symlink(target, path.join(userDir, "alias.yaml"));
    const library = await load();
    expect(library.errors).toEqual([]);
    expect(library.has("alias")).toBe(true);
  });
});
