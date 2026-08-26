import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EvidencePackBuilder,
  emptyEvidencePack,
  saveEvidencePack,
  loadEvidencePack,
  buildReviewPrompt,
  createEmptyContract,
} from "../../src/index.js";

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-pack-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "demo",
      type: "module",
      dependencies: { react: "^18.0.0" },
      scripts: { test: "echo ok" },
    }),
    "utf8",
  );
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "service.ts"),
    "export function serve() { return 1; }\n",
    "utf8",
  );
  return dir;
}

describe("evidence pack", () => {
  it("builds overview and structure from a node project", async () => {
    const projectPath = await tempProject();
    const builder = new EvidencePackBuilder({
      projectPath,
      taskId: "t1",
      round: 1,
      depth: "QUICK",
      runCommands: false,
    });
    const pack = await builder.build();
    expect(pack.overview.projectType).toBe("node");
    expect(pack.overview.framework).toBe("react");
    expect(pack.structure.tree.length).toBeGreaterThan(0);
    expect(pack.tests.test.status).toBe("NOT_RUN");
    await builder.persist(pack, "t1");
    const loaded = await loadEvidencePack(projectPath, "t1");
    expect(loaded?.overview.framework).toBe("react");
  });

  it("formats pack-aware review prompts", () => {
    const pack = emptyEvidencePack("/tmp/p", { taskId: "t", round: 1 });
    pack.overview.projectType = "node";
    pack.relevantFiles = [
      {
        path: "src/a.ts",
        role: "changed",
        content: "export const a = 1;",
      },
    ];
    const prompt = buildReviewPrompt({
      contract: createEmptyContract("Fix a"),
      round: 1,
      artifacts: [],
      evidencePack: pack,
    });
    expect(prompt).toContain("Evidence pack");
    expect(prompt).toContain("Do NOT guess");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toMatch(/Do NOT require git add/i);
  });

  it("includes committed files since git baseline in the pack", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const projectPath = await tempProject();
    await execFileAsync("git", ["-c", "init.templateDir=", "init"], {
      cwd: projectPath,
    });
    await execFileAsync("git", ["config", "user.email", "assentor@test"], {
      cwd: projectPath,
    });
    await execFileAsync("git", ["config", "user.name", "Assentor Test"], {
      cwd: projectPath,
    });
    await execFileAsync("git", ["add", "."], { cwd: projectPath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: projectPath });
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectPath })
    ).stdout.toString().trim();

    await fs.mkdir(path.join(projectPath, "src", "ai"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "src", "ai", "minimax.js"),
      "export const depth = 7;\n",
    );
    await execFileAsync("git", ["add", "src/ai/minimax.js"], {
      cwd: projectPath,
    });
    await execFileAsync("git", ["commit", "-m", "deeper search"], {
      cwd: projectPath,
    });

    const builder = new EvidencePackBuilder({
      projectPath,
      taskId: "t-git",
      round: 1,
      depth: "QUICK",
      runCommands: false,
      gitBaselineHead: head,
    });
    const pack = await builder.build({
      executorResult: {
        status: "completed",
        summary: "Updated src/ai/minimax.js for harder AI.",
      },
    });

    expect(pack.git.workingTreeClean).toBe(true);
    expect(pack.git.changedFiles).toContain("src/ai/minimax.js");
    expect(pack.git.note).toMatch(/commits since task start/i);
    const minimax = pack.relevantFiles.find((f) => f.path === "src/ai/minimax.js");
    expect(minimax?.content).toContain("depth = 7");
    expect(minimax?.role).toBe("changed");
  });

  it("persists markdown summary", async () => {
    const projectPath = await tempProject();
    const pack = emptyEvidencePack(projectPath, { taskId: "t2" });
    const { mdPath } = await saveEvidencePack(pack, "t2");
    const md = await fs.readFile(mdPath, "utf8");
    expect(md).toContain("Project Review Evidence Pack");
  });
});
