import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createId, EventLog,
  readSessionEvents, type EngineEvent } from "../../packages/engine/src/index.js";
import {
  executorEmitsPlainText,
  resumeAssentorTask,
  RunSeatEvents,
  runAssentorTask,
} from "../../packages/cli/src/cli/commands.js";

describe("assentor run writes a seat event log", () => {
  let projectDir: string;
  let userDir: string;
  const savedUserDir = process.env.ASSENTOR_USER_DIR;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-seat-events-"));
    userDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-seat-events-user-"));
    process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
    await fs.mkdir(path.join(projectDir, ".assentor"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".assentor", "config.yaml"),
      "git:\n  checkpoints: false\nexecutor:\n  provider: mock\nreviewers:\n  - provider: mock\n",
      "utf8",
    );
  });

  afterEach(async () => {
    if (savedUserDir === undefined) {
      delete process.env.ASSENTOR_USER_DIR;
    } else {
      process.env.ASSENTOR_USER_DIR = savedUserDir;
    }
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(userDir, { recursive: true, force: true });
  });

  async function readSession(taskId: string): Promise<EngineEvent[]> {
    return readSessionEvents(projectDir, taskId);
  }

  it("records the session, both seats and every supervisor event", async () => {
    const { result } = await runAssentorTask({
      projectPath: projectDir,
      prompt: "Implement average()",
      skipPreflight: true,
      skipGates: true,
    });

    const events = await readSession(result.taskId);
    expect(events[0]).toMatchObject({ type: "session.created", data: { title: "Implement average()" } });
    const spawned = events.filter((e) => e.type === "seat.spawned");
    expect(spawned.map((e) => e.seatId)).toEqual(["executor", "reviewer-1"]);
    expect(spawned[0]!.data).toMatchObject({ provider: "mock", permissions: "edit" });
    expect(spawned[1]!.data).toMatchObject({ provider: "mock", permissions: "read-only" });

    const legacyTypes = events
      .map((e) => (e.data as { legacyType?: string }).legacyType)
      .filter(Boolean);
    expect(legacyTypes).toEqual(result.events.map((e) => e.type));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.some((e) => e.seatId === "reviewer-1" && e.type === "seat.done")).toBe(true);
  });

  it("spawns a panel seat for several reviewers and every seat before it is used", async () => {
    await fs.writeFile(
      path.join(projectDir, ".assentor", "config.yaml"),
      "git:\n  checkpoints: false\nexecutor:\n  provider: mock\nreviewers:\n  - provider: mock\n  - provider: mock\n",
      "utf8",
    );
    const live: EngineEvent[] = [];
    const { result } = await runAssentorTask({
      projectPath: projectDir,
      prompt: "Implement average()",
      skipPreflight: true,
      skipGates: true,
      onEngineEvent: (event) => live.push(event),
    });

    const events = await readSession(result.taskId);
    expect(live).toEqual(events);
    const spawned = new Set<string>();
    for (const event of events) {
      if (event.type === "seat.spawned") {
        spawned.add(event.seatId!);
      } else if (event.seatId) {
        expect(spawned, `${event.type} on ${event.seatId}`).toContain(event.seatId);
      }
    }
    expect([...spawned]).toEqual(["executor", "panel", "reviewer-1", "reviewer-2"]);
  });

  it("leaves the log untouched when a resume is rejected", async () => {
    const { result } = await runAssentorTask({
      projectPath: projectDir,
      prompt: "goal",
      skipPreflight: true,
      skipGates: true,
    });
    const before = await readSession(result.taskId);

    // A task that passed review is not resumable, so resume throws before any seat work.
    await expect(
      resumeAssentorTask({ projectPath: projectDir, taskId: result.taskId }),
    ).rejects.toThrow();

    expect(await readSession(result.taskId)).toEqual(before);
  });
});

describe("RunSeatEvents with a plain-text executor", () => {
  it("batches output and reports one writing status instead of a tool call per line", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-seat-events-text-"));
    try {
      const taskId = createId();
      const events: EngineEvent[] = [];
      const seats = new RunSeatEvents((event) => events.push(event));
      seats.setExecutorProvider("codex");
      await seats.open({
        projectPath: projectDir,
        taskId,
        title: "goal",
        executor: { name: "codex", provider: "codex" },
        reviewers: [],
        redactSecrets: true,
      });
      for (let i = 0; i < 50; i += 1) {
        seats.executorOutput(`line ${i}\n`, "stdout");
        seats.executorStatus({ activity: "running", detail: `line ${i}` });
      }
      seats.executorOutput("ignored", "stderr");
      await seats.close();

      const executorEvents = events.filter((e) => e.seatId === "executor");
      expect(executorEvents.map((e) => e.type)).toEqual([
        "seat.spawned",
        "seat.output.delta",
        "seat.status",
        "seat.output.delta",
      ]);
      expect(executorEvents[2]!.data).toEqual({ status: "writing" });
      const text = executorEvents
        .filter((e) => e.type === "seat.output.delta")
        .map((e) => (e.data as { text: string }).text)
        .join("");
      expect(text).toBe(Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join(""));
      expect(await readSessionEvents(projectDir, taskId)).toEqual(events);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("executorEmitsPlainText", () => {
  const savedFormat = process.env.ASSENTOR_CURSOR_OUTPUT_FORMAT;
  afterEach(() => {
    if (savedFormat === undefined) {
      delete process.env.ASSENTOR_CURSOR_OUTPUT_FORMAT;
    } else {
      process.env.ASSENTOR_CURSOR_OUTPUT_FORMAT = savedFormat;
    }
  });

  it("forwards raw output only for plain-text executors", () => {
    delete process.env.ASSENTOR_CURSOR_OUTPUT_FORMAT;
    expect(executorEmitsPlainText("codex")).toBe(true);
    expect(executorEmitsPlainText("opencode")).toBe(true);
    expect(executorEmitsPlainText("claude-code")).toBe(false);
    expect(executorEmitsPlainText("antigravity")).toBe(false);
    expect(executorEmitsPlainText("cursor")).toBe(false);
    expect(executorEmitsPlainText("mock")).toBe(false);
    process.env.ASSENTOR_CURSOR_OUTPUT_FORMAT = "text";
    expect(executorEmitsPlainText("cursor")).toBe(true);
  });
});
