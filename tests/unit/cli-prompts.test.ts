import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  editPrompt,
  forkPrompt,
  listPrompts,
  resolveEditor,
  showPrompt,
  validatePrompts,
  type EditorSpawn,
  type PromptCommandOptions,
} from "../../packages/cli/src/cli/prompts.js";

/** Minimal valid prompt file. `extra` adds front-matter lines (each ending in a newline). */
function promptText(
  id: string,
  options: { role?: string; title?: string; body?: string; extra?: string } = {},
): string {
  return [
    "---",
    `id: ${id}`,
    `role: ${options.role ?? "builder"}`,
    `title: ${options.title ?? id}`,
    "version: 1",
    ...(options.extra ? [options.extra.replace(/\n$/, "")] : []),
    "---",
    options.body ?? `Body of ${id}.`,
    "",
  ].join("\n");
}

/** A spawner that records the call and reports the given exit code. Never starts a process. */
function fakeEditor(exitCode = 0) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: EditorSpawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", exitCode, null));
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

describe("assentor prompts", () => {
  let root: string;
  let builtin: string;
  let user: string;
  let project: string;
  let out: string[];
  let err: string[];
  let opts: PromptCommandOptions;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-prompts-"));
    builtin = path.join(root, "builtin");
    user = path.join(root, "user");
    project = path.join(root, "project");
    await fs.mkdir(builtin, { recursive: true });
    await fs.mkdir(user, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    out = [];
    err = [];
    opts = {
      projectPath: project,
      userDir: user,
      builtinDir: builtin,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function write(dir: string, file: string, text: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, file);
    await fs.writeFile(target, text, "utf8");
    return target;
  }

  const projectPromptsDir = () => path.join(project, ".assentor", "prompts");

  describe("list", () => {
    it("sorts by id, shows the layer and the override, and lists the built-in alpha as overridden", async () => {
      await write(builtin, "alpha.md", promptText("alpha", { title: "Alpha built-in" }));
      await write(builtin, "gamma.md", promptText("gamma", { role: "reviewer" }));
      await write(user, "alpha.md", promptText("alpha", { title: "Alpha user" }));
      await write(user, "beta.md", promptText("beta"));

      expect(await listPrompts(opts)).toBe(0);

      expect(out.map((line) => line.split(/\s+/)[0])).toEqual(["ID", "alpha", "beta", "gamma"]);
      const alpha = out[1]!;
      expect(alpha).toMatch(/Alpha user/);
      expect(alpha).toMatch(/user\s+builtin$/);
      expect(out[2]).toMatch(/beta\s+beta\s+builder\s+user\s+-$/);
      expect(out[3]).toMatch(/gamma\s+gamma\s+reviewer\s+builtin\s+-$/);
    });

    it("--role keeps only that role", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));
      await write(builtin, "gamma.md", promptText("gamma", { role: "reviewer" }));

      expect(await listPrompts({ ...opts, role: "reviewer" })).toBe(0);
      expect(out).toHaveLength(2);
      expect(out[1]).toMatch(/^gamma/);
    });

    it("rejects an unknown --role", async () => {
      expect(await listPrompts({ ...opts, role: "wizard" })).toBe(1);
      expect(err[0]).toContain('--role must be one of builder, reviewer, meta, got "wizard"');
    });

    it("says how many prompt files failed to load", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));
      await write(user, "broken.md", "no front matter here\n");

      await listPrompts(opts);
      expect(out.at(-1)).toBe('1 prompt file(s) failed to load; run "assentor prompts validate"');
    });
  });

  describe("show", () => {
    it("prints the front-matter summary and then the body", async () => {
      await write(builtin, "alpha.md", promptText("alpha", { body: "Do the alpha thing." }));

      expect(await showPrompt({ ...opts, id: "alpha" })).toBe(0);
      expect(out).toEqual(
        expect.arrayContaining([
          "id: alpha",
          "role: builder",
          "layer: builtin",
          "overrides: -",
          "variables: none",
        ]),
      );
      expect(out.at(-1)).toBe("Do the alpha thing.");
    });

    it("an unknown id exits 1 with the message", async () => {
      expect(await showPrompt({ ...opts, id: "nope" })).toBe(1);
      expect(err).toEqual(['Unknown prompt "nope"']);
    });
  });

  describe("fork", () => {
    it("copies the file into the user layer, unchanged", async () => {
      const original = promptText("alpha");
      await write(builtin, "alpha.md", original);

      expect(await forkPrompt({ ...opts, id: "alpha" })).toBe(0);
      expect(await fs.readFile(path.join(user, "alpha.md"), "utf8")).toBe(original);
    });

    it("--to project writes into <project>/.assentor/prompts and creates the folder", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));

      expect(await forkPrompt({ ...opts, id: "alpha", to: "project" })).toBe(0);
      expect(existsSync(path.join(projectPromptsDir(), "alpha.md"))).toBe(true);
    });

    it("--as renames the copy: the id line changes and nothing else does", async () => {
      const original = promptText("alpha", { body: "Keep this line." });
      await write(builtin, "alpha.md", original);

      expect(await forkPrompt({ ...opts, id: "alpha", as: "gamma2" })).toBe(0);
      const written = await fs.readFile(path.join(user, "gamma2.md"), "utf8");
      expect(written).toBe(original.replace("id: alpha", "id: gamma2"));
    });

    it("rejects an --as that equals the original id, or is not kebab-case", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));

      expect(await forkPrompt({ ...opts, id: "alpha", as: "alpha" })).toBe(1);
      expect(err.at(-1)).toBe('--as must differ from "alpha"');

      expect(await forkPrompt({ ...opts, id: "alpha", as: "Bad_Id" })).toBe(1);
      expect(err.at(-1)).toContain("must be kebab-case");
    });

    it("rejects an unknown --to layer", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));

      expect(await forkPrompt({ ...opts, id: "alpha", to: "builtin" })).toBe(1);
      expect(err[0]).toBe('--to must be "user" or "project", got "builtin"');
    });

    it("refuses to overwrite an existing copy, exits 1, and leaves the file alone", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));
      expect(await forkPrompt({ ...opts, id: "alpha" })).toBe(0);

      const copy = path.join(user, "alpha.md");
      await fs.writeFile(copy, "EDITED BY USER\n", "utf8");

      expect(await forkPrompt({ ...opts, id: "alpha" })).toBe(1);
      expect(err).toEqual([`Prompt "alpha" already exists at ${copy}`]);
      expect(await fs.readFile(copy, "utf8")).toBe("EDITED BY USER\n");
    });

    it("a copy that fails to load is reported, exits 1, and is kept on disk", async () => {
      // A project child that extends a same-layer parent. Copied to the user layer,
      // the parent is above it, so the copy cannot resolve `extends`.
      await write(projectPromptsDir(), "parent.md", promptText("parent"));
      await write(projectPromptsDir(), "mine.md", promptText("mine", { extra: "extends: parent\n" }));

      expect(await forkPrompt({ ...opts, id: "mine", to: "user" })).toBe(1);
      expect(err.some((line) => line.includes("does not load"))).toBe(true);
      expect(err.some((line) => line.includes("extends unknown prompt"))).toBe(true);
      expect(existsSync(path.join(user, "mine.md"))).toBe(true);
    });
  });

  describe("edit", () => {
    it("exits 1 and tells the user to fork when only the built-in exists", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));
      const editor = fakeEditor();

      expect(await editPrompt({ ...opts, id: "alpha", spawn: editor.spawn })).toBe(1);
      expect(err[0]).toBe(
        'Only the built-in prompt "alpha" exists. Run "assentor prompts fork alpha" first, then edit the copy.',
      );
      expect(editor.calls).toEqual([]);
    });

    it("edits the project copy over the user copy", async () => {
      await write(user, "alpha.md", promptText("alpha"));
      const projectCopy = await write(projectPromptsDir(), "alpha.md", promptText("alpha"));
      const editor = fakeEditor(0);

      expect(
        await editPrompt({ ...opts, id: "alpha", spawn: editor.spawn, env: { VISUAL: "nano" } }),
      ).toBe(0);
      expect(editor.calls).toEqual([{ command: "nano", args: [projectCopy] }]);
    });

    it("edits the user copy when there is no project copy", async () => {
      const userCopy = await write(user, "alpha.md", promptText("alpha"));
      const editor = fakeEditor(0);

      await editPrompt({ ...opts, id: "alpha", spawn: editor.spawn, env: {}, platform: "linux" });
      expect(editor.calls).toEqual([{ command: "vi", args: [userCopy] }]);
    });

    it("propagates a non-zero editor exit code", async () => {
      await write(user, "alpha.md", promptText("alpha"));
      const editor = fakeEditor(3);

      expect(await editPrompt({ ...opts, id: "alpha", spawn: editor.spawn, env: {} })).toBe(3);
    });

    it("reports an editor that cannot start, and exits 1", async () => {
      await write(user, "alpha.md", promptText("alpha"));
      const spawn: EditorSpawn = () => {
        throw new Error("spawn nope ENOENT");
      };

      expect(await editPrompt({ ...opts, id: "alpha", spawn, env: { EDITOR: "nope" } })).toBe(1);
      expect(err[0]).toBe('Could not start editor "nope": spawn nope ENOENT');
    });
  });

  describe("resolveEditor", () => {
    it("VISUAL wins over EDITOR, and its arguments are split on whitespace", () => {
      expect(resolveEditor({ VISUAL: "code --wait", EDITOR: "vim" }, "linux")).toEqual({
        command: "code",
        args: ["--wait"],
      });
    });

    it("EDITOR with arguments is used when VISUAL is unset or blank", () => {
      expect(resolveEditor({ EDITOR: "emacs -nw" }, "darwin")).toEqual({
        command: "emacs",
        args: ["-nw"],
      });
      expect(resolveEditor({ VISUAL: "   ", EDITOR: "nano" }, "linux")).toEqual({
        command: "nano",
        args: [],
      });
    });

    it("falls back to notepad on Windows and vi elsewhere", () => {
      expect(resolveEditor({}, "win32")).toEqual({ command: "notepad", args: [] });
      expect(resolveEditor({}, "linux")).toEqual({ command: "vi", args: [] });
      expect(resolveEditor({}, "darwin")).toEqual({ command: "vi", args: [] });
    });
  });

  describe("validate", () => {
    it("prints the loaded count and exits 0 when every file loads", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));
      await write(builtin, "gamma.md", promptText("gamma"));
      await write(user, "beta.md", promptText("beta"));

      expect(await validatePrompts(opts)).toBe(0);
      expect(out).toEqual(["All prompts valid (3 loaded)"]);
    });

    it("prints each error as <layer> <file>: <message> and exits 1", async () => {
      await write(builtin, "alpha.md", promptText("alpha"));
      const broken = await write(user, "broken.md", "no front matter here\n");

      expect(await validatePrompts(opts)).toBe(1);
      expect(out).toHaveLength(1);
      expect(out[0]!.startsWith(`user ${broken}: `)).toBe(true);
    });
  });
});
