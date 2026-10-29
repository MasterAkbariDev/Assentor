import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPlaybookRun, listPlaybooks, type PlaybookCommandOptions } from "../../src/cli/playbooks.js";
import { builtinPlaybookDir } from "../../src/playbooks/library.js";

describe("assentor playbooks", () => {
  let root: string;
  let out: string[];
  let err: string[];
  let opts: PlaybookCommandOptions;
  let previousUserDir: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-playbooks-"));
    // Keep the user layer and the prompt library inside the temp dir.
    previousUserDir = process.env.ASSENTOR_USER_DIR;
    process.env.ASSENTOR_USER_DIR = path.join(root, "home");
    out = [];
    err = [];
    opts = {
      projectPath: path.join(root, "project"),
      builtinDir: builtinPlaybookDir(),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
  });

  afterEach(async () => {
    if (previousUserDir === undefined) delete process.env.ASSENTOR_USER_DIR;
    else process.env.ASSENTOR_USER_DIR = previousUserDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists the built-in playbooks", async () => {
    expect(await listPlaybooks(opts)).toBe(0);
    const text = out.join("\n");
    for (const id of ["feature-build", "bug-hunt", "explain-codebase", "security-audit"]) {
      expect(text).toContain(id);
    }
    expect(err).toEqual([]);
  });

  it("reports a broken user playbook on stderr and still lists the built-ins", async () => {
    const dir = path.join(process.env.ASSENTOR_USER_DIR!, "playbooks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "broken.yaml"), "id: broken\n");
    expect(await listPlaybooks(opts)).toBe(0);
    expect(err.join("\n")).toContain("broken.yaml");
    expect(out.join("\n")).toContain("feature-build");
  });

  it("run --playbook: an unknown id is a clear error", async () => {
    expect(await checkPlaybookRun({ ...opts, id: "nope" })).toBe(1);
    expect(err.join("\n")).toContain('Unknown playbook "nope". Available: ');
    expect(err.join("\n")).toContain("feature-build");
  });

  it("run --playbook: a valid id validates but says running is not wired", async () => {
    expect(await checkPlaybookRun({ ...opts, id: "pr-review" })).toBe(1);
    expect(err.join("\n")).toContain('Playbook "pr-review" is valid, but running playbooks is not wired yet');
  });

  it("run --playbook: a broken user file explains why its id is unavailable", async () => {
    const dir = path.join(opts.projectPath, ".assentor", "playbooks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "mine.yaml"), "id: mine\nteams: 1\n");
    expect(await checkPlaybookRun({ ...opts, id: "mine" })).toBe(1);
    expect(err.join("\n")).toContain('Playbook "mine" failed to load');
  });
});
