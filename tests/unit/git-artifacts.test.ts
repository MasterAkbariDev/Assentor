import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactCollector,
  ArtifactType,
  EvidenceKind,
  fulfillEvidenceRequests,
  GitError,
  LocalGitService,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);
const TEMP_ROOT = path.join(process.cwd(), ".tmp", "git-tests");

async function makeTempRepo(): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "repo-"));
  await execFileAsync("git", ["-c", "init.templateDir=", "init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "assentor@test"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "Assentor Test"], {
    cwd: dir,
  });
  await fs.writeFile(path.join(dir, "README.md"), "# temp\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("LocalGitService", () => {
  it("reports status, diff, changed files, and checkpoints", async () => {
    const dir = await makeTempRepo();
    tempDirs.push(dir);

    const git = new LocalGitService({ cwd: dir });
    expect(await git.isRepo()).toBe(true);

    await fs.writeFile(path.join(dir, "hello.txt"), "hello\n");
    const status = await git.status();
    expect(status.dirty).toBe(true);
    expect(status.untracked).toContain("hello.txt");

    const files = await git.changedFiles();
    expect(files).toContain("hello.txt");

    const checkpoint = await git.createCheckpoint("before");
    expect(checkpoint.head).toBeTruthy();
    expect(checkpoint.dirty).toBe(true);

    await execFileAsync("git", ["add", "hello.txt"], { cwd: dir });
    const diff = await git.diff({ staged: true });
    expect(diff).toContain("hello");
  });

  it("refuses destructive rollback without explicit permission", async () => {
    const dir = await makeTempRepo();
    tempDirs.push(dir);
    const git = new LocalGitService({ cwd: dir });
    const checkpoint = await git.createCheckpoint();

    await expect(git.rollback(checkpoint)).rejects.toBeInstanceOf(GitError);
  });

  it("changesSince includes files committed after the baseline", async () => {
    const dir = await makeTempRepo();
    tempDirs.push(dir);
    const git = new LocalGitService({ cwd: dir });
    const before = await git.createCheckpoint("start");

    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "main.js"), "export const n = 1;\n");
    await execFileAsync("git", ["add", "src/main.js"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "speed up ai"], { cwd: dir });

    expect(await git.changedFiles()).toEqual([]);
    const since = await git.changesSince(before.head);
    expect(since.files).toContain("src/main.js");
    expect(since.diff).toContain("export const n = 1");
  });
});

describe("artifacts + evidence", () => {
  it("collects artifacts and fulfills safe file evidence", async () => {
    const dir = await makeTempRepo();
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src", "avg.ts"),
      "export const API_KEY=super-secret-value-123\nexport const avg = () => 1\n",
    );

    const collector = new ArtifactCollector();
    const git = new LocalGitService({ cwd: dir });

    collector.addGitStatus((await git.status()).porcelain);
    collector.addChangedFiles(await git.changedFiles());

    const fulfillment = await fulfillEvidenceRequests(
      [
        { kind: EvidenceKind.File, path: "src/avg.ts" },
        { kind: EvidenceKind.GitDiff },
        { kind: EvidenceKind.ProjectStructure, path: "src" },
      ],
      { projectPath: dir, collector, git },
    );

    expect(fulfillment.fulfilled).toBe(3);
    expect(fulfillment.errors).toEqual([]);

    const fileArtifact = collector.list({ type: ArtifactType.File })[0];
    expect(fileArtifact?.content).toContain("[REDACTED]");
    expect(fileArtifact?.redacted).toBe(true);
    expect(fileArtifact?.content).not.toContain("super-secret-value-123");
  });

  it("skips path traversal evidence requests with errors", async () => {
    const dir = await makeTempRepo();
    tempDirs.push(dir);
    const collector = new ArtifactCollector();

    const fulfillment = await fulfillEvidenceRequests(
      [{ kind: EvidenceKind.File, path: "../outside.ts" }],
      { projectPath: dir, collector },
    );

    expect(fulfillment.fulfilled).toBe(0);
    expect(fulfillment.skipped).toBe(1);
    expect(fulfillment.errors[0]).toContain("escapes project root");
  });
});
