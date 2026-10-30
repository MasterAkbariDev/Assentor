import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { parseEngineEvent, type EngineEvent } from "../../src/protocol/events.js";
import { LeadBoard } from "../../src/tui/components/lead-board.js";
import {
  emptyLeadBoardView,
  reduceLeadEvents,
  type LeadBoardView,
} from "../../src/ui-shared/lead.js";

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
let seq = 0;
function ev(type: string, data: Record<string, unknown>, seatId?: string): EngineEvent {
  seq += 1;
  return parseEngineEvent({
    seq,
    sessionId: "s1",
    ...(seatId ? { seatId } : {}),
    type,
    data,
    at: new Date(T0 + seq * 1000).toISOString(),
  });
}

function boardFrom(events: EngineEvent[]): LeadBoardView {
  return events.reduce(reduceLeadEvents, emptyLeadBoardView());
}

const board = boardFrom([
  ev("seat.spawned", { displayName: "Opus#1", provider: "claude-code", transport: "cli", model: "opus", role: "engineer", permissions: "edit" }, "seat-1"),
  ev("lead.turn", { turn: 4 }),
  ev("task.created", { taskId: "T1", title: "Login form with validation and a long description that must be cut" }),
  ev("task.created", { taskId: "T2", title: "Login API" }),
  ev("task.created", { taskId: "T3", title: "Docs" }),
  ev("task.assigned", { taskId: "T1", seatId: "seat-1" }),
  ev("task.status", { taskId: "T1", status: "in_review" }),
  ev("task.assigned", { taskId: "T2", seatId: "seat-1" }),
  ev("task.rejected", { taskId: "T2", reason: "no tests" }),
  ev("task.accepted", { taskId: "T3" }),
  ev("lead.action", { action: "accept", accepted: true, reason: "T3 accepted" }),
  ev("lead.action", { action: "reject", accepted: false, reason: "T2 has no tests in the diff" }),
]);

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function displayWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    width += cp >= 0x1f000 || (cp >= 0x23e9 && cp <= 0x23fa) ? 2 : 1;
  }
  return width;
}

// Same render approach as tests/unit/seat-board.test.ts.
async function renderToLines(element: React.ReactElement, columns: number): Promise<string[]> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    const stream = new PassThrough();
    (stream as any).columns = columns;
    (stream as any).rows = 40;
    stream.on("data", (chunk) => frames.push(chunk.toString()));
    const instance = render(element, {
      stdout: stream as any,
      stdin: new PassThrough() as any,
      patchConsole: false,
      debug: true,
    });
    setTimeout(() => {
      const meaningful = frames.filter((frame) => frame.trim().length > 0);
      const lastFrame = meaningful[meaningful.length - 1] ?? "";
      try {
        instance.unmount();
      } catch {
        // ignore
      }
      resolve(stripAnsi(lastFrame).split("\n"));
    }, 60);
  });
}

describe("LeadBoard render", () => {
  for (const width of [80, 40]) {
    it(`no rendered line exceeds ${width} columns, and every column is labelled`, async () => {
      const lines = await renderToLines(React.createElement(LeadBoard, { view: board, width }), width);
      const rows = lines.filter((line) => line.trim().length > 0);
      for (const line of rows) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
      const text = rows.join("\n");
      // Narrow columns truncate the labels, so only the full-width render checks the counts.
      expect(text).toContain("Backlog");
      expect(text).toContain("Lead log");
      if (width === 80) {
        expect(text).toContain("Backlog (1)");
        expect(text).toContain("In progress (0)");
        expect(text).toContain("In review (1)");
        expect(text).toContain("Done (1)");
      }
    });
  }

  it("shows task id, owner, and the last lead actions with check and cross marks", async () => {
    const lines = await renderToLines(React.createElement(LeadBoard, { view: board, width: 80 }), 80);
    const text = lines.join("\n");
    expect(text).toContain("T1 Login form");
    expect(text).toContain("Opus#1");
    expect(text).toContain("✗ T2 Login API");
    expect(text).toContain("✓ accept: T3 accepted");
    expect(text).toContain("✗ reject: T2 has no tests in the diff");
    expect(text).toContain("turn 4");
  });

  it("ascii mode draws only ascii marks", async () => {
    const lines = await renderToLines(React.createElement(LeadBoard, { view: board, width: 80, ascii: true }), 80);
    const text = lines.join("\n");
    expect(text).not.toContain("✓");
    expect(text).not.toContain("✗");
    expect(text).toContain("x T2 Login API");
    expect(text).toContain("OK accept: T3 accepted");
    expect(text).toContain("X reject:");
  });

  it("shows +N more when a column has more rows than fit", async () => {
    const many = boardFrom(
      Array.from({ length: 8 }, (_, i) => ev("task.created", { taskId: `B${i}`, title: `task ${i}` })),
    );
    const lines = await renderToLines(React.createElement(LeadBoard, { view: many, width: 80, maxRows: 6 }), 80);
    expect(lines.join("\n")).toContain("+2 more");
  });

  it("shows plain text: model escape codes never reach the screen", async () => {
    const hostile = boardFrom([ev("task.created", { taskId: "T9", title: "\x1b[31mEVIL\x1b[0m\x1b]0;title\x07" })]);
    const lines = await renderToLines(React.createElement(LeadBoard, { view: hostile, width: 80 }), 80);
    const text = lines.join("\n");
    expect(text).toContain("T9 EVIL");
    expect(text).not.toContain("]0;");
    expect(text).not.toContain("[31m");
  });

  it("an empty board says so", async () => {
    const lines = await renderToLines(React.createElement(LeadBoard, { view: emptyLeadBoardView(), width: 80 }), 80);
    expect(lines.join("\n")).toContain("No tasks yet");
  });
});
