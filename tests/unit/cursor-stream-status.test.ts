import { describe, expect, it } from "vitest";
import {
  CursorStreamStatusParser,
  isExecutorStreamBlob,
  parseStreamLine,
  resolveExecutorFailureMessage,
  summarizeExecutorStreamOutput,
  summarizeStreamJson,
} from "../../src/providers/executors/cursor/stream-status.js";

describe("Cursor stream-json status", () => {
  it("maps read/write/shell tool events", () => {
    const read = parseStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: { readToolCall: { args: { path: "src/app.js" } } },
        session_id: "s1",
      }),
    );
    expect(read).toMatchObject({
      activity: "reading",
      detail: "src/app.js",
      sessionId: "s1",
    });

    const write = parseStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: {
          writeToolCall: { args: { path: "/tmp/proj/index.html" } },
        },
      }),
    );
    expect(write?.activity).toBe("writing");
    expect(write?.detail).toContain("index.html");

    const shell = parseStreamLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: {
          shellToolCall: { args: { command: "node --test app.test.js" } },
        },
      }),
    );
    expect(shell).toMatchObject({
      activity: "running",
      detail: "node --test app.test.js",
    });
  });

  it("parses NDJSON chunks incrementally", () => {
    const parser = new CursorStreamStatusParser();
    const statuses: string[] = [];

    for (const update of parser.push(
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        model: "Composer",
        session_id: "abc",
      })}\n`,
    )) {
      statuses.push(`${update.activity}:${update.detail}`);
    }

    for (const update of parser.push(
      `${JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: { editToolCall: { args: { path: "app.js" } } },
        session_id: "abc",
      })}\n${JSON.stringify({
        type: "result",
        subtype: "success",
        result: "All good",
        session_id: "abc",
      })}\n`,
    )) {
      statuses.push(`${update.activity}:${update.detail}`);
    }

    expect(parser.getSessionId()).toBe("abc");
    expect(parser.getResultText()).toBe("All good");
    expect(parser.hasFinalResult()).toBe(true);
    expect(statuses[0]).toContain("starting");
    expect(statuses.some((s) => s.startsWith("editing:"))).toBe(true);
  });

  it("treats a result object without a trailing newline as final", () => {
    const parser = new CursorStreamStatusParser();
    const updates = parser.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "No newline",
        session_id: "nl",
      }),
    );
    expect(parser.hasFinalResult()).toBe(true);
    expect(parser.getResultText()).toBe("No newline");
    expect(updates[0]?.isFinal).toBe(true);
  });

  it("maps thinking events to a waiting-on-model detail", () => {
    const empty = parseStreamLine(JSON.stringify({ type: "thinking" }));
    expect(empty).toMatchObject({
      activity: "thinking",
      detail: "model thinking — this can take a few minutes",
    });

    const withText = parseStreamLine(
      JSON.stringify({ type: "thinking", text: "Considering the test layout" }),
    );
    expect(withText?.activity).toBe("thinking");
    expect(withText?.detail).toContain("Considering the test layout");
  });

  it("summarizes stream-json stdout", () => {
    const stdout = [
      JSON.stringify({ type: "system", session_id: "x1" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Verified todos work.",
        session_id: "x1",
      }),
    ].join("\n");

    expect(summarizeStreamJson(stdout)).toEqual({
      summary: "Verified todos work.",
      sessionId: "x1",
    });
  });

  it("maps Antigravity step_update tool events", () => {
    const active = parseStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-1",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "list_dir",
          tool_info: {
            name: "list_dir",
            parameters: { DirectoryPath: "/tmp/project/src/cli" },
          },
        },
      }),
    );
    expect(active).toMatchObject({
      activity: "exploring",
      detail: "#2 · list src/cli",
      sessionId: "agy-1",
    });

    const result = parseStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "agy-1",
          status: "SUCCESS",
          response: "Done",
        },
      }),
    );
    expect(result).toMatchObject({
      isFinal: true,
      resultText: "Done",
      sessionId: "agy-1",
    });
  });

  it("captures Antigravity ERROR result without dumping NDJSON", () => {
    const parser = new CursorStreamStatusParser();
    const stdout = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-timeout",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "I am checking the environment.",
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "agy-timeout",
          status: "ERROR",
          response: "",
          error: "timeout waiting for response",
        },
      }),
    ].join("\n");

    for (const line of stdout.split("\n")) {
      parser.push(`${line}\n`);
    }

    expect(parser.isResultError()).toBe(true);
    expect(parser.getResultError()).toBe("timeout waiting for response");

    const failure = resolveExecutorFailureMessage({
      executorName: "Antigravity",
      parser,
      stdout,
      stderr: "",
      exitCode: 0,
    });
    expect(failure.kind).toBe("timeout");
    expect(failure.error).toBe("Antigravity: timeout waiting for response");
    expect(failure.summary).toContain("timed out");
    expect(failure.summary).not.toContain('"event":"init"');
  });

  it("includes step index and completion details for Antigravity tools", () => {
    const done = parseStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-3",
          step_index: 5,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            duration_ms: 2400,
            output: "All tests passed\n",
            parameters: { CommandLine: "npm test" },
          },
        },
      }),
    );
    expect(done).toMatchObject({
      activity: "running",
      detail: "#5 · npm test · 2.4s · All tests passed · done",
    });
  });

  it("summarizes partial Antigravity stdout without dumping NDJSON", () => {
    const stdout = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-2",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "grep_search",
          tool_info: {
            name: "grep_search",
            parameters: {
              Query: "SELECTABLE_EXECUTOR_PROVIDERS",
              SearchPath: "src",
            },
          },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-2",
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "grep_search",
        },
      }),
    ].join("\n");

    expect(summarizeExecutorStreamOutput(stdout)).toBe(
      "Ran 2 tool step(s); last: #2 · SELECTABLE_EXECUTOR_PROVIDERS in src",
    );
    expect(isExecutorStreamBlob(stdout)).toBe(true);
  });
});
