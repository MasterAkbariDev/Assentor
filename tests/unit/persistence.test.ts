import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBudgets,
  createEmptyContract,
  createTaskId,
  loadTaskForResume,
  MockExecutor,
  MockReviewer,
  Supervisor,
  TaskState,
  TaskStore,
} from "../../src/index.js";

const TEMP_ROOT = path.join(process.cwd(), ".tmp", "persist-tests");
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

describe("TaskStore persistence", () => {
  it("creates layout and persists snapshot/events/history", async () => {
    const projectPath = await makeProject();
    const taskId = createTaskId();
    const contract = createEmptyContract("Persist me");
    const budgets = createBudgets({ maxRounds: 4, maxMessages: 20 });

    const store = await TaskStore.create({
      projectPath,
      taskId,
      conversationId: createTaskId(),
      contract,
      budgets,
      executor: "mock",
      reviewers: ["mock"],
    });

    expect(await fs.stat(store.paths.stateFile)).toBeTruthy();
    expect(await fs.stat(store.paths.taskMdFile)).toBeTruthy();

    await store.appendEvent({
      type: "round.started",
      at: new Date().toISOString(),
      data: { round: 1 },
    });

    const loaded = await TaskStore.open(projectPath, taskId);
    const snapshot = await loaded.loadSnapshot();
    expect(snapshot.taskId).toBe(taskId);
    expect(snapshot.contract.goal).toBe("Persist me");

    const events = await loaded.loadEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("round.started");
  });

  it("persists a supervisor run and supports resume lookup", async () => {
    const projectPath = await makeProject();
    const taskId = createTaskId();
    const contract = createEmptyContract("Ship average()");
    const budgets = createBudgets({ maxRounds: 5, maxMessages: 40 });

    const store = await TaskStore.create({
      projectPath,
      taskId,
      conversationId: createTaskId(),
      contract,
      budgets,
      executor: "mock",
      reviewers: ["mock"],
    });

    const result = await new Supervisor({
      projectPath,
      contract,
      taskId,
      conversationId: (await store.loadSnapshot()).conversationId,
      budgets,
      store,
      executor: new MockExecutor({
        steps: [
          { type: "complete", summary: "v1" },
          { type: "complete", summary: "v2" },
        ],
        autoRespondToEvidence: false,
      }),
      reviewer: new MockReviewer({
        steps: [
          {
            type: "needs_work",
            summary: "Add tests",
            requiredChanges: ["Add tests"],
            issueId: "T-1",
          },
          { type: "pass" },
        ],
      }),
    }).run();

    expect(result.status).toBe(TaskState.Done);

    const snapshot = await store.loadSnapshot();
    expect(snapshot.status).toBe(TaskState.Done);
    expect(snapshot.currentRound).toBe(2);

    const events = await store.loadEvents();
    expect(events.some((event) => event.type === "task.completed")).toBe(true);

    const history = await store.loadHistory();
    expect(history.length).toBeGreaterThan(0);

    const resume = await loadTaskForResume(projectPath, taskId);
    expect(resume.resumable).toBe(false);
    expect(resume.reason).toMatch(/cannot be resumed|DONE/);
  });

  it("can resume a non-terminal interrupted task", async () => {
    const projectPath = await makeProject();
    const taskId = createTaskId();
    const conversationId = createTaskId();
    const contract = createEmptyContract("Resume me");
    const budgets = createBudgets({ maxRounds: 5, maxMessages: 40 });

    const store = await TaskStore.create({
      projectPath,
      taskId,
      conversationId,
      contract,
      budgets,
      executor: "mock",
      reviewers: ["mock"],
    });

    // Simulate crash after first round requested changes.
    await store.saveSnapshot({
      taskId,
      conversationId,
      projectPath,
      status: TaskState.Executing,
      currentRound: 1,
      maxRounds: 5,
      executor: "mock",
      reviewers: ["mock"],
      contract,
      budgets: {
        limits: budgets.limits,
        usage: { rounds: 1, messages: 4, toolCalls: 0, runtimeMs: 0 },
      },
      executorSessionId: "sess-1",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      communicationCount: 4,
    });

    const resume = await loadTaskForResume(projectPath, taskId);
    expect(resume.resumable).toBe(true);

    const result = await new Supervisor({
      projectPath,
      contract,
      store,
      resumeFrom: resume.snapshot,
      executor: new MockExecutor({
        steps: [{ type: "complete", summary: "finished after resume" }],
        autoRespondToEvidence: false,
      }),
      reviewer: new MockReviewer({ steps: [{ type: "pass" }] }),
    }).run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBeGreaterThanOrEqual(2);

    const finalSnap = await store.loadSnapshot();
    expect(finalSnap.status).toBe(TaskState.Done);
  });

  it("can resume a timed-out or failed task", async () => {
    const projectPath = await makeProject();
    const taskId = createTaskId();
    const conversationId = createTaskId();
    const contract = createEmptyContract("Retry me");
    const budgets = createBudgets({ maxRounds: 5, maxMessages: 40 });

    const store = await TaskStore.create({
      projectPath,
      taskId,
      conversationId,
      contract,
      budgets,
      executor: "mock",
      reviewers: ["mock"],
    });

    await store.saveSnapshot({
      taskId,
      conversationId,
      projectPath,
      status: TaskState.Timeout,
      currentRound: 1,
      maxRounds: 5,
      executor: "mock",
      reviewers: ["mock"],
      contract,
      budgets: {
        limits: budgets.limits,
        usage: { rounds: 1, messages: 4, toolCalls: 0, runtimeMs: 0 },
      },
      executorSessionId: "sess-timeout",
      reason: "Executor timed out",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      communicationCount: 4,
    });

    const prefix = await loadTaskForResume(projectPath, taskId.slice(0, 8));
    expect(prefix.resumable).toBe(true);

    const result = await new Supervisor({
      projectPath,
      contract,
      store,
      resumeFrom: prefix.snapshot,
      executor: new MockExecutor({
        steps: [{ type: "complete", summary: "finished after timeout" }],
        autoRespondToEvidence: false,
      }),
      reviewer: new MockReviewer({ steps: [{ type: "pass" }] }),
    }).run();

    expect(result.status).toBe(TaskState.Done);
  });

  it("deletes a task directory", async () => {
    const projectPath = await makeProject();
    const taskId = createTaskId();
    const store = await TaskStore.create({
      projectPath,
      taskId,
      conversationId: createTaskId(),
      contract: createEmptyContract("Delete me"),
      budgets: createBudgets({ maxRounds: 2, maxMessages: 10 }),
      executor: "mock",
      reviewers: ["mock"],
    });
    expect(await fs.stat(store.paths.taskDir)).toBeTruthy();
    await TaskStore.remove(projectPath, taskId);
    await expect(fs.stat(store.paths.taskDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists EXECUTING before the executor returns", async () => {
    const projectPath = await makeProject();
    const taskId = createTaskId();
    const contract = createEmptyContract("Persist executing");
    const budgets = createBudgets({ maxRounds: 3, maxMessages: 20 });
    const store = await TaskStore.create({
      projectPath,
      taskId,
      conversationId: createTaskId(),
      contract,
      budgets,
      executor: "mock",
      reviewers: ["mock"],
    });
    expect((await store.loadSnapshot()).status).toBe(TaskState.Initializing);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const hanging = new Supervisor({
      projectPath,
      contract,
      taskId,
      conversationId: (await store.loadSnapshot()).conversationId,
      budgets,
      store,
      collectExecutorExplanation: false,
      executor: {
        name: "hang",
        capabilities: () => ({
          canEditFiles: true,
          canRunCommands: true,
          canContinueSession: true,
          supportsScreenshots: false,
        }),
        async run() {
          await gate;
          return { status: "completed", summary: "ok", sessionId: "s" };
        },
        async continue() {
          return { status: "completed", summary: "ok", sessionId: "s" };
        },
        async cancel() {},
      },
      reviewer: new MockReviewer({ steps: [{ type: "pass" }] }),
    });

    const pending = hanging.run();
    let seenExecuting = false;
    for (let i = 0; i < 80; i += 1) {
      const snapshot = await store.loadSnapshot();
      if (snapshot.status === TaskState.Executing) {
        seenExecuting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(seenExecuting).toBe(true);
    release();
    const result = await pending;
    expect(result.status).toBe(TaskState.Done);
  });
});
