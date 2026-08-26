import { describe, expect, it } from "vitest";
import {
  CursorStreamStatusParser,
  parseStreamLine,
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
    expect(statuses[0]).toContain("starting");
    expect(statuses.some((s) => s.startsWith("editing:"))).toBe(true);
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
});
