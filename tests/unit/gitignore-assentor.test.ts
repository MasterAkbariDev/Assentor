import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSENTOR_GITIGNORE_ENTRY,
  MockExecutor,
  ensureAssentorGitignored,
  withAssentorGitignore,
  createEmptyContract,
} from "../../src/index.js";

const TEMP_ROOT = path.join(process.cwd(), ".tmp", "gitignore-tests");
const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("ensureAssentorGitignored", () => {
  it("creates .gitignore with .assentor/ when missing", async () => {
    const projectPath = await makeProject();
    const updated = await ensureAssentorGitignored(projectPath);
    expect(updated).toBe(true);
    const body = await fs.readFile(path.join(projectPath, ".gitignore"), "utf8");
    expect(body).toContain(ASSENTOR_GITIGNORE_ENTRY);
  });

  it("is idempotent when .assentor/ already listed", async () => {
    const projectPath = await makeProject();
    await fs.writeFile(
      path.join(projectPath, ".gitignore"),
      "node_modules/\n.assentor/\n",
      "utf8",
    );
    const updated = await ensureAssentorGitignored(projectPath);
    expect(updated).toBe(false);
    const body = await fs.readFile(path.join(projectPath, ".gitignore"), "utf8");
    expect(body.match(/\.assentor/g)?.length).toBe(1);
  });

  it("appends when .gitignore exists without the entry", async () => {
    const projectPath = await makeProject();
    await fs.writeFile(
      path.join(projectPath, ".gitignore"),
      "node_modules/\n",
      "utf8",
    );
    const updated = await ensureAssentorGitignored(projectPath);
    expect(updated).toBe(true);
    const body = await fs.readFile(path.join(projectPath, ".gitignore"), "utf8");
    expect(body).toContain("node_modules/");
    expect(body).toContain(ASSENTOR_GITIGNORE_ENTRY);
  });

  it("runs via executor wrapper before mock run", async () => {
    const projectPath = await makeProject();
    const executor = withAssentorGitignore(new MockExecutor());
    await executor.run({
      taskId: "t1",
      projectPath,
      contract: createEmptyContract("ignore me"),
      prompt: "ignore me",
    });
    const body = await fs.readFile(path.join(projectPath, ".gitignore"), "utf8");
    expect(body).toContain(ASSENTOR_GITIGNORE_ENTRY);
  });
});
