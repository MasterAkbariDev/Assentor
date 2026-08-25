import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBudgets,
  createEmptyContract,
  createTaskId,
  mergeAcceptanceCriteria,
  MockReviewer,
  ProjectMutatingExecutor,
  ReviewStatus,
  Severity,
  Supervisor,
  TaskState,
  TaskStore,
  writeProjectFiles,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);
const TEMP_ROOT = path.join(process.cwd(), ".tmp", "e2e-average");
const tempDirs: string[] = [];

const IMPLEMENTATION = `export function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}
`;

const TEST_FILE = `import assert from "node:assert/strict";
import { test } from "node:test";
import { average } from "./average.js";

test("average of positive numbers", () => {
  assert.equal(average([2, 4, 6]), 4);
});

test("average of a single value", () => {
  assert.equal(average([10]), 10);
});

test("average of an empty array is 0", () => {
  assert.equal(average([]), 0);
});
`;

async function seedAverageProject(): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
  tempDirs.push(dir);

  await writeProjectFiles(dir, {
    "package.json": JSON.stringify(
      {
        name: "average-e2e",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "src/average.js": `export function average(_values) {
  throw new Error("not implemented");
}
`,
    "src/average.test.js": TEST_FILE,
  });

  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("E2E average project", () => {
  it("orchestrates implement → review → fix → pass against a real project", async () => {
    const projectPath = await seedAverageProject();

    const before = await execFileAsync("node", ["--test"], {
      cwd: projectPath,
    }).catch((error: { code?: number }) => error);
    expect((before as { code?: number }).code).not.toBe(0);

    const executor = new ProjectMutatingExecutor({
      mutate: async ({ projectPath: cwd, call, messages }) => {
        if (call === 1) {
          // Incomplete first attempt: wrong empty-array behavior
          await writeProjectFiles(cwd, {
            "src/average.js": `export function average(values) {
  if (!values.length) throw new Error("empty");
  return values.reduce((a, b) => a + b, 0) / values.length;
}
`,
          });
          return { summary: "Implemented average without empty-array handling" };
        }

        const change = messages.find((message) => message.type === "CHANGE_REQUEST");
        expect(change).toBeTruthy();
        await writeProjectFiles(cwd, { "src/average.js": IMPLEMENTATION });
        const testResult = await execFileAsync("node", ["--test"], { cwd });
        return {
          summary: "Fixed empty-array behavior; tests pass",
          rawOutput: testResult.stdout,
        };
      },
    });

    const reviewer = new MockReviewer({
      steps: [
        {
          type: "custom",
          result: {
            status: ReviewStatus.NeedsWork,
            confidence: 0.9,
            summary: "Empty array handling is wrong",
            issues: [
              {
                id: "AVG-001",
                severity: Severity.Major,
                description: "average([]) should return 0",
                evidence: ["acceptance criteria"],
              },
            ],
            requiredChanges: [
              "Make average([]) return 0 and ensure node --test passes",
            ],
            optionalChanges: [],
            evidenceRequests: [],
          },
        },
        { type: "pass", summary: "Tests and acceptance criteria satisfied" },
      ],
    });

    const contract = mergeAcceptanceCriteria(
      createEmptyContract(
        "Implement average(numbers) that returns the arithmetic mean; empty array returns 0; tests pass.",
      ),
      [
        "average([2,4,6]) === 4",
        "average([]) === 0",
        "node --test passes",
      ],
    );

    const taskId = createTaskId();
    const store = await TaskStore.create({
      projectPath,
      taskId,
      conversationId: createTaskId(),
      contract,
      budgets: createBudgets({ maxRounds: 5, maxMessages: 40 }),
      executor: executor.name,
      reviewers: [reviewer.name],
    });

    const result = await new Supervisor({
      projectPath,
      contract,
      executor,
      reviewer,
      store,
      taskId,
      budgets: createBudgets({ maxRounds: 5, maxMessages: 40 }),
    }).run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBe(2);
    expect(executor.callCount).toBe(2);

    const impl = await fs.readFile(path.join(projectPath, "src/average.js"), "utf8");
    expect(impl).toContain("return 0");

    const testRun = await execFileAsync("node", ["--test"], { cwd: projectPath });
    expect(testRun.stdout).toMatch(/pass/i);

    const snapshot = await store.loadSnapshot();
    expect(snapshot.status).toBe(TaskState.Done);
    const events = await store.loadEvents();
    expect(events.some((event) => event.type === "task.completed")).toBe(true);
  }, 30_000);
});
