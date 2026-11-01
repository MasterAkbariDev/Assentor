import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBudgets,
  createEmptyContract,
  createId,
  EventLog,
  readSessionEvents,
  PanelReviewer,
  ReviewStatus,
  SeatEventSink,
  seatStatusFromActivity,
  Supervisor,
  TaskState,
  trackReviewerSeat,
  type EngineEvent,
  type Executor,
  type Reviewer,
  type ReviewerTurnResult,
  type SupervisorEvent,
} from "../../packages/engine/src/index.js";
import { reduceSeatEvents } from "../../packages/ui-shared/src/status.js";

const tempDirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-seat-events-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** Legacy events without timestamps, for exact comparison between runs. */
function legacyPayloads(events: SupervisorEvent[]): Array<Omit<SupervisorEvent, "at">> {
  return events.map(({ at: _at, ...rest }) => rest);
}

function passingExecutor(): Executor {
  return {
    name: "mock-executor",
    capabilities: () => ({
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: true,
      supportsScreenshots: false,
    }),
    run: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
    continue: async () => ({ status: "completed", summary: "done", sessionId: "s-1" }),
    cancel: async () => undefined,
  };
}

function passingReviewer(name: string): Reviewer {
  const pass = (): ReviewerTurnResult => ({
    result: {
      status: ReviewStatus.Pass,
      confidence: 0.9,
      summary: `${name} ok`,
      issues: [],
      requiredChanges: [],
      optionalChanges: [],
      evidenceRequests: [],
    },
  });
  return { name, review: async () => pass(), continue: async () => pass() };
}

async function runWithSeats(options: {
  projectPath: string;
  sessionId: string;
  log?: EventLog;
  withSink?: boolean;
  onError?: (error: unknown, context: string) => void;
  /** Reviewer members; default two passing reviewers. */
  reviewers?: Reviewer[];
}): Promise<{ legacy: SupervisorEvent[]; engine: EngineEvent[]; status: TaskState }> {
  const legacy: SupervisorEvent[] = [];
  const engine: EngineEvent[] = [];
  const sink =
    options.withSink === false
      ? undefined
      : new SeatEventSink({
          sessionId: options.sessionId,
          log: options.log,
          onEvent: (event) => engine.push(event),
          ...(options.onError ? { onError: options.onError } : {}),
        });
  const members = (options.reviewers ?? ["Claude", "Gemini"].map(passingReviewer)).map(
    (member, index) => trackReviewerSeat(member, `reviewer-${index + 1}`, () => sink),
  );
  const single = members.length === 1;
  const supervisor = new Supervisor({
    projectPath: options.projectPath,
    contract: createEmptyContract("Implement average()"),
    executor: passingExecutor(),
    reviewer: single ? members[0]! : new PanelReviewer({ name: "panel", reviewers: members }),
    budgets: createBudgets({ maxRounds: 3, maxMessages: 20 }),
    taskId: options.sessionId,
    skipGates: true,
    onEvent: (event) => legacy.push(event),
    seatEvents: sink,
    seatScope: { executorSeatId: "executor", reviewerSeatId: single ? "reviewer-1" : "panel" },
    maxFailureRetries: 0,
  });
  const result = await supervisor.run();
  await sink?.close();
  return { legacy, engine, status: result.status };
}

describe("seatStatusFromActivity", () => {
  it("maps executor activities to seat statuses", () => {
    expect(seatStatusFromActivity("thinking")).toBe("thinking");
    expect(seatStatusFromActivity("Planning")).toBe("thinking");
    expect(seatStatusFromActivity("editing")).toBe("editing");
    expect(seatStatusFromActivity("reading")).toBe("tool");
    expect(seatStatusFromActivity("waiting")).toBe("waiting");
    expect(seatStatusFromActivity("warning")).toBeUndefined();
  });
});

describe("SeatEventSink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("batches output per seat and flushes it before that seat's next event", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s", onEvent: (e) => events.push(e) });

    sink.output("a", "hel");
    sink.output("b", "x");
    sink.output("a", "lo");
    sink.done("a", true, "finished");
    await sink.flush();

    expect(events.map((e) => [e.type, e.seatId])).toEqual([
      ["seat.output.delta", "a"],
      ["seat.done", "a"],
      ["seat.output.delta", "b"],
    ]);
    expect(events[0]!.data).toMatchObject({ text: "hello" });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("turns tool-like activities into a status and a tool call", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s", onEvent: (e) => events.push(e) });

    sink.activity("executor", "reading", "src/a.ts");
    sink.activity("executor", "warning", "model flag unsupported");
    sink.activity("executor", "unknown-thing", "");
    await sink.flush();

    expect(events.map((e) => e.type)).toEqual([
      "seat.status",
      "seat.tool_call",
      "session.warning",
    ]);
    expect(events[1]!.data).toMatchObject({ name: "reading", summary: "src/a.ts" });
  });

  it("never throws when the listener or the log fails", async () => {
    const errors: string[] = [];
    const failingLog = {
      append: async () => {
        throw new Error("ENOSPC");
      },
    } as unknown as EventLog;
    const sink = new SeatEventSink({
      sessionId: "s",
      log: failingLog,
      onError: (_error, context) => errors.push(context),
    });
    sink.status("a", "thinking");
    sink.output("a", "text");
    await expect(sink.close()).resolves.toBeUndefined();
    expect(errors).toContain("event log write");

    const errors2: string[] = [];
    const sink2 = new SeatEventSink({
      sessionId: "s",
      onEvent: () => {
        throw new Error("listener boom");
      },
      onError: (_error, context) => errors2.push(context),
    });
    sink2.status("a", "thinking");
    await expect(sink2.close()).resolves.toBeUndefined();
    expect(errors2).toEqual(["event listener"]);
  });

  it("caps recorded output per seat and warns once", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({
      sessionId: "s",
      maxOutputCharsPerSeat: 5,
      onEvent: (e) => events.push(e),
    });

    sink.output("a", "abc");
    sink.output("a", "defgh");
    sink.output("a", "ijk");
    sink.output("b", "xy");
    await sink.close();

    const text = events
      .filter((e) => e.type === "seat.output.delta" && e.seatId === "a")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(text).toBe("abcde");
    const warnings = events.filter((e) => e.type === "session.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.data).toMatchObject({ kind: "output_truncated" });
    expect(events.some((e) => e.seatId === "b" && e.type === "seat.output.delta")).toBe(true);
  });

  it("warns when a chunk fills the cap exactly and the next one is dropped", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({
      sessionId: "s",
      maxOutputCharsPerSeat: 5,
      onEvent: (e) => events.push(e),
    });

    sink.output("a", "abcde");
    sink.output("a", "f");
    sink.output("a", "g");
    await sink.close();

    const warnings = events.filter((e) => e.type === "session.warning");
    expect(warnings).toHaveLength(1);
    const text = events
      .filter((e) => e.type === "seat.output.delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(text).toBe("abcde");
  });

  it("does not split a surrogate pair at the cap", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({
      sessionId: "s",
      maxOutputCharsPerSeat: 3,
      onEvent: (e) => events.push(e),
    });

    sink.output("a", "ab😀c");
    await sink.close();

    const text = events
      .filter((e) => e.type === "seat.output.delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(text).toBe("ab");
  });

  it("drops a repeated status and the tool call it would pair with", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s", onEvent: (e) => events.push(e) });

    // cursor reports a tool call as started and again as completed, identically.
    sink.activity("executor", "reading", "src/a.ts");
    sink.activity("executor", "reading", "src/a.ts");
    sink.activity("executor", "reading", "src/b.ts");
    sink.status("executor", "writing");
    sink.status("executor", "writing");
    sink.done("executor", true);
    // A new turn after done starts fresh, even with the same status.
    sink.status("executor", "writing");
    await sink.close();

    expect(events.map((e) => e.type)).toEqual([
      "seat.status",
      "seat.tool_call",
      "seat.status",
      "seat.tool_call",
      "seat.status",
      "seat.done",
      "seat.status",
    ]);
  });

  it("redacts secrets from event data unless disabled", async () => {
    const secret = `sk-${"a".repeat(24)}`;
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s", onEvent: (e) => events.push(e) });
    sink.output("a", `key is ${secret}\n`);
    sink.status("a", "tool", `curl -H "Authorization: Bearer ${secret}"`);
    await sink.close();

    const written = JSON.stringify(events);
    expect(written).not.toContain(secret);
    expect(written).toContain("[REDACTED]");

    const raw: EngineEvent[] = [];
    const plain = new SeatEventSink({
      sessionId: "s",
      redactSecrets: false,
      onEvent: (e) => raw.push(e),
    });
    plain.output("a", secret);
    await plain.close();
    expect(JSON.stringify(raw)).toContain(secret);
  });

  it("emits seat.tokens from a Claude Code stream-json result line, once per executor turn (TE-01)", async () => {
    // Shape of a real `claude -p --output-format stream-json --verbose` transcript (trimmed).
    const stream = [
      { type: "system", subtype: "init", session_id: "0b5c", model: "claude-sonnet-4-5", tools: ["Read", "Edit", "Bash"] },
      {
        type: "assistant",
        message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Fixing add()." }], usage: { input_tokens: 4, cache_read_input_tokens: 13000, output_tokens: 90 } },
        session_id: "0b5c",
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, session_id: "0b5c" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 18234,
        duration_api_ms: 17000,
        num_turns: 6,
        result: "add() now returns a + b.",
        session_id: "0b5c",
        total_cost_usd: 0.0412,
        usage: {
          input_tokens: 21,
          cache_creation_input_tokens: 2400,
          cache_read_input_tokens: 41000,
          output_tokens: 1300,
          server_tool_use: { web_search_requests: 0 },
          service_tier: "standard",
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s", onEvent: (e) => events.push(e) });
    const turn = (rawOutput: string) =>
      sink.supervisor(
        { type: "executor.completed", at: new Date().toISOString(), data: { summary: "done", rawOutput } },
        { executorSeatId: "executor", stageId: "build" },
      );
    turn(stream);
    turn("plain text output with no usage line\n");
    await sink.close();

    const tokens = events.filter((e) => e.type === "seat.tokens");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      seatId: "executor",
      stageId: "build",
      data: { tokensIn: 43421, tokensOut: 1300, cachedTokens: 41000, turns: 6, costUsd: 0.0412 },
    });
    // Right after the turn's own event, so the log reads in order.
    expect(events.map((e) => e.type).indexOf("seat.tokens")).toBe(1);
  });

  it("keeps only the length of a mirrored rawOutput", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s", onEvent: (e) => events.push(e) });
    sink.supervisor(
      {
        type: "executor.completed",
        at: new Date().toISOString(),
        data: { summary: "done", rawOutput: "x".repeat(1000) },
      },
      { executorSeatId: "executor" },
    );
    await sink.close();

    expect(events).toHaveLength(1);
    expect(events[0]!.data).not.toHaveProperty("rawOutput");
    expect(events[0]!.data).toMatchObject({
      summary: "done",
      rawOutputChars: 1000,
      legacyType: "executor.completed",
    });
  });

  it("ignores events after close", async () => {
    const events: EngineEvent[] = [];
    const sink = new SeatEventSink({ sessionId: "s", onEvent: (e) => events.push(e) });
    await sink.close();
    sink.status("a", "thinking");
    sink.output("a", "late");
    await sink.close();
    expect(events).toEqual([]);
  });
});

describe("Supervisor with seat events", () => {
  it("mirrors every legacy event and reports per-seat activity", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    const { legacy, engine, status } = await runWithSeats({ projectPath, sessionId });

    expect(status).toBe(TaskState.Done);
    const mirrored = engine.filter((e) => "legacyType" in e.data);
    expect(mirrored.map((e) => (e.data as { legacyType: string }).legacyType)).toEqual(
      legacy.map((e) => e.type),
    );

    const seatIds = new Set(engine.map((e) => e.seatId).filter(Boolean));
    expect(seatIds).toEqual(new Set(["executor", "panel", "reviewer-1", "reviewer-2"]));
    for (const seat of ["reviewer-1", "reviewer-2"]) {
      const types = engine.filter((e) => e.seatId === seat).map((e) => e.type);
      expect(types).toEqual(["seat.status", "seat.done"]);
    }
    expect(engine.map((e) => e.seq)).toEqual(engine.map((_, i) => i + 1));
  });

  it("leaves legacy events identical with or without a sink", async () => {
    const projectPath = await tempProject();
    const withSink = await runWithSeats({ projectPath, sessionId: createId() });
    const without = await runWithSeats({
      projectPath,
      sessionId: createId(),
      withSink: false,
    });
    expect(legacyPayloads(withSink.legacy)).toEqual(legacyPayloads(without.legacy));
  });

  it("finishes the run unchanged when every event-log write fails", async () => {
    const projectPath = await tempProject();
    const failingLog = {
      append: async () => {
        throw new Error("ENOSPC");
      },
    } as unknown as EventLog;
    const errors: string[] = [];

    const failing = await runWithSeats({
      projectPath,
      sessionId: createId(),
      log: failingLog,
      onError: (_error, context) => errors.push(context),
    });
    const baseline = await runWithSeats({
      projectPath,
      sessionId: createId(),
      withSink: false,
    });

    expect(failing.status).toBe(TaskState.Done);
    expect(failing.engine).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(new Set(errors)).toEqual(new Set(["event log write"]));
    expect(legacyPayloads(failing.legacy)).toEqual(legacyPayloads(baseline.legacy));
  });

  it("persists to the session log and continues seq on resume", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();

    const firstLog = await EventLog.open(projectPath, sessionId);
    const first = await runWithSeats({ projectPath, sessionId, log: firstLog });
    await firstLog.close();
    const reopened = await EventLog.open(projectPath, sessionId);
    expect(reopened.lastSeq).toBe(first.engine.length);

    const second = await runWithSeats({ projectPath, sessionId, log: reopened });
    await reopened.close();
    expect(second.engine[0]!.seq).toBe(first.engine.length + 1);

    const all = await readSessionEvents(projectPath, sessionId);
    expect(all).toHaveLength(first.engine.length + second.engine.length);
  });
});

describe("seat turns always end", () => {
  function finalSeats(engine: EngineEvent[]) {
    return engine.reduce(reduceSeatEvents, {} as ReturnType<typeof reduceSeatEvents>);
  }

  it("ends the review panel seat after its verdict", async () => {
    const projectPath = await tempProject();
    const { engine, status } = await runWithSeats({ projectPath, sessionId: createId() });

    expect(status).toBe(TaskState.Done);
    const panel = engine.filter((e) => e.seatId === "panel");
    const verdictAt = panel.findIndex((e) => e.type === "review.verdict");
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    expect(panel[verdictAt + 1]).toMatchObject({
      type: "seat.done",
      data: { ok: true, summary: "verdict: PASS" },
    });
    for (const seat of Object.values(finalSeats(engine))) {
      expect(["done", "failed"]).toContain(seat.status);
    }
  });

  it("does not end a single reviewer twice", async () => {
    const projectPath = await tempProject();
    const { engine } = await runWithSeats({
      projectPath,
      sessionId: createId(),
      reviewers: [passingReviewer("Claude")],
    });

    const done = engine.filter((e) => e.seatId === "reviewer-1" && e.type === "seat.done");
    expect(done).toHaveLength(1);
  });

  it("closes every open turn when the session fails", async () => {
    const projectPath = await tempProject();
    const broken: Reviewer = {
      name: "Broken",
      review: async () => {
        throw new Error("reviewer crashed");
      },
      continue: async () => {
        throw new Error("reviewer crashed");
      },
    };
    const { engine, status } = await runWithSeats({
      projectPath,
      sessionId: createId(),
      reviewers: [broken, broken],
    });

    expect(status).not.toBe(TaskState.Done);
    for (const [seatId, seat] of Object.entries(finalSeats(engine))) {
      expect({ seatId, ended: ["done", "failed"].includes(seat.status) }).toEqual({
        seatId,
        ended: true,
      });
    }
    const panelEnd = engine.find((e) => e.seatId === "panel" && e.type === "seat.done");
    expect(panelEnd?.data).toMatchObject({ ok: false });
  });
});
