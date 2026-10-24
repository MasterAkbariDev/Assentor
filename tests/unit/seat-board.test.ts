import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { SEAT_STATUSES, type SeatStatus } from "../../src/core/seats.js";
import { parseEngineEvent, type EngineEvent } from "../../src/protocol/events.js";
import {
  LAST_LINE_CHARS,
  OUTPUT_TAIL_CHARS,
  reduceSeatEvents,
  seatLineModel,
  STATUS_META,
  type SeatState,
} from "../../src/ui-shared/status.js";
import { SeatBoard } from "../../src/tui/components/seat-board.js";

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

let seq = 0;
function ev(
  type: string,
  seatId: string | undefined,
  data: Record<string, unknown>,
  offsetMs = 0,
): EngineEvent {
  seq += 1;
  return parseEngineEvent({
    seq,
    sessionId: "s1",
    ...(seatId ? { seatId } : {}),
    type,
    data,
    at: at(offsetMs),
  });
}

const spawnData = {
  displayName: "Opus#1",
  provider: "claude-code",
  transport: "cli",
  model: "opus",
  role: "architecture",
  permissions: "read-only",
};

function reduceAll(events: EngineEvent[], start: Record<string, SeatState> = {}) {
  return events.reduce(reduceSeatEvents, start);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function seatFixture(overrides: Partial<SeatState> & { seatId: string }): SeatState {
  return {
    displayName: "Opus#1",
    model: "claude-opus-5-5",
    role: "architecture",
    status: "queued",
    outputTail: "",
    tokensIn: 0,
    tokensOut: 0,
    ...overrides,
  };
}

describe("reduceSeatEvents lifecycle", () => {
  it("spawn → starting → thinking → writing → tool → tokens → model → done", () => {
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData, 0),
      ev("seat.status", "s1", { status: "starting" }, 1_000),
      ev("seat.status", "s1", { status: "thinking" }, 2_000),
      ev("seat.output.delta", "s1", { text: "Plan\n" }, 2_100),
      ev("seat.output.delta", "s1", { text: "Writing the average" }, 2_200),
      ev("seat.status", "s1", { status: "writing" }, 2_300),
      ev("seat.tool_call", "s1", { name: "read_file", summary: "src/avg.ts" }, 2_400),
      ev("seat.tokens", "s1", { tokensIn: 100, tokensOut: 50 }, 2_500),
      ev("seat.tokens", "s1", { tokensIn: 20, tokensOut: 5 }, 2_600),
      ev("seat.model.changed", "s1", { to: "sonnet", pending: false }, 2_700),
      ev("seat.done", "s1", { ok: true, summary: "Average added" }, 30_000),
    ]);

    const seat = state.s1!;
    expect(seat).toMatchObject({
      displayName: "Opus#1",
      role: "architecture",
      model: "sonnet",
      status: "done",
      detail: "Average added",
      lastLine: "Writing the average",
      tokensIn: 120,
      tokensOut: 55,
      startedAt: at(1_000),
      endedAt: at(30_000),
    });
  });

  it("startedAt is kept across later status changes", () => {
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData, 0),
      ev("seat.status", "s1", { status: "starting" }, 1_000),
      ev("seat.status", "s1", { status: "thinking" }, 9_000),
    ]);
    expect(state.s1!.startedAt).toBe(at(1_000));
  });

  it("a tool call sets detail to its summary, or its name when there is none", () => {
    const withSummary = reduceAll([
      ev("seat.spawned", "s1", spawnData),
      ev("seat.tool_call", "s1", { name: "grep", summary: "TODO" }),
    ]);
    const withoutSummary = reduceAll([
      ev("seat.spawned", "s1", spawnData),
      ev("seat.tool_call", "s1", { name: "grep" }),
    ]);
    expect(withSummary.s1!.detail).toBe("TODO");
    expect(withoutSummary.s1!.detail).toBe("grep");
  });

  it("a failure sets failed, the message as detail, and endedAt", () => {
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData, 0),
      ev("seat.status", "s1", { status: "starting" }, 1_000),
      ev("seat.error", "s1", { message: "CLI exited 2" }, 5_000),
    ]);
    expect(state.s1).toMatchObject({
      status: "failed",
      detail: "CLI exited 2",
      endedAt: at(5_000),
    });
  });

  it("seat.done with ok false is failed", () => {
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData),
      ev("seat.done", "s1", { ok: false }),
    ]);
    expect(state.s1!.status).toBe("failed");
  });

  it("a retry shows retrying as the detail", () => {
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData),
      ev("seat.retry", "s1", { attempt: 2, maxAttempts: 3, delayMs: 1_000 }),
    ]);
    expect(state.s1!.detail).toBe("retrying");
  });

  it("a respawn (resume) keeps tokens and output, and clears endedAt", () => {
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData, 0),
      ev("seat.tokens", "s1", { tokensIn: 10, tokensOut: 4 }, 1_000),
      ev("seat.output.delta", "s1", { text: "old output" }, 1_100),
      ev("seat.done", "s1", { ok: true }, 2_000),
      ev("seat.spawned", "s1", spawnData, 3_000),
    ]);
    expect(state.s1).toMatchObject({
      status: "queued",
      tokensIn: 10,
      tokensOut: 4,
      lastLine: "old output",
      endedAt: undefined,
    });
  });

  it("an event without a seatId leaves the state as it is", () => {
    const before = reduceAll([ev("seat.spawned", "s1", spawnData)]);
    const after = reduceSeatEvents(before, ev("session.created", undefined, { title: "x" }));
    expect(after).toBe(before);
  });
});

describe("reduceSeatEvents placeholder for an unknown seat", () => {
  it("creates a queued placeholder named after the seat id", () => {
    const state = reduceAll([ev("seat.thinking", "ghost", {})]);
    expect(state.ghost).toEqual({
      seatId: "ghost",
      displayName: "ghost",
      model: "AUTO",
      role: "",
      status: "queued",
      outputTail: "",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  it("a status event for an unknown seat is not lost", () => {
    const state = reduceAll([ev("seat.status", "late", { status: "writing" })]);
    expect(state.late).toMatchObject({ displayName: "late", status: "writing" });
  });
});

describe("reduceSeatEvents immutability", () => {
  it("does not mutate the previous state or the events", () => {
    const first = deepFreeze(reduceAll([ev("seat.spawned", "s1", spawnData)]));
    const starting = deepFreeze(ev("seat.status", "s1", { status: "starting" }, 1_000));
    const output = deepFreeze(ev("seat.output.delta", "s1", { text: "hello" }, 2_000));

    const second = reduceSeatEvents(first, starting);
    const third = reduceSeatEvents(second, output);

    expect(first.s1!.status).toBe("queued");
    expect(first.s1!.startedAt).toBeUndefined();
    expect(second.s1!.status).toBe("starting");
    expect(second).not.toBe(first);
    expect(third.s1!.lastLine).toBe("hello");
    expect(second.s1!.lastLine).toBeUndefined();
  });
});

describe("output bounds", () => {
  it("outputTail keeps only the last OUTPUT_TAIL_CHARS after many deltas", () => {
    const chunks = Array.from({ length: 500 }, (_, i) => `chunk-${String(i).padStart(4, "0")}`);
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData),
      ...chunks.map((text, i) => ev("seat.output.delta", "s1", { text: `${text}\n` }, i)),
    ]);
    const seat = state.s1!;
    expect(seat.outputTail.length).toBe(OUTPUT_TAIL_CHARS);
    expect(seat.outputTail).toBe(`${chunks.join("\n")}\n`.slice(-OUTPUT_TAIL_CHARS));
    expect(seat.lastLine).toBe("chunk-0499");
  });

  it("lastLine is the last non-empty trimmed line, cut to LAST_LINE_CHARS", () => {
    const state = reduceAll([
      ev("seat.spawned", "s1", spawnData),
      ev("seat.output.delta", "s1", { text: "first\n\n   second line   \n\n" }),
    ]);
    expect(state.s1!.lastLine).toBe("second line");

    const long = "x".repeat(300);
    const longState = reduceAll([
      ev("seat.spawned", "s1", spawnData),
      ev("seat.output.delta", "s1", { text: `${long}\n` }),
    ]);
    expect(longState.s1!.lastLine).toBe("x".repeat(LAST_LINE_CHARS));
  });
});

describe("seatLineModel", () => {
  const started = seatFixture({
    seatId: "s1",
    status: "thinking",
    startedAt: at(0),
    detail: undefined,
    lastLine: "reading the spec",
  });

  it("formats elapsed as m:ss, using now while the seat is running", () => {
    expect(seatLineModel(started, T0 + 7_000).elapsed).toBe("0:07");
    expect(seatLineModel(started, T0 + 750_000).elapsed).toBe("12:30");
    expect(seatLineModel(started, T0 + 4_500_000).elapsed).toBe("75:00");
  });

  it("uses endedAt, not now, once the seat has ended", () => {
    const ended = { ...started, status: "done" as const, endedAt: at(65_000) };
    expect(seatLineModel(ended, T0 + 999_000).elapsed).toBe("1:05");
  });

  it("elapsed is empty when the seat has not started", () => {
    expect(seatLineModel(seatFixture({ seatId: "s1" }), T0 + 5_000).elapsed).toBe("");
  });

  it("detail is detail, else lastLine, else empty", () => {
    expect(seatLineModel({ ...started, detail: "tool x" }, T0).detail).toBe("tool x");
    expect(seatLineModel(started, T0).detail).toBe("reading the spec");
    expect(seatLineModel(seatFixture({ seatId: "s1" }), T0).detail).toBe("");
  });

  it("picks the unicode or ascii icon", () => {
    expect(seatLineModel(started, T0).icon).toBe(STATUS_META.thinking.icon);
    expect(seatLineModel(started, T0, true).icon).toBe(STATUS_META.thinking.asciiIcon);
  });
});

describe("STATUS_META", () => {
  it("has an entry for every seat status", () => {
    expect(Object.keys(STATUS_META).sort()).toEqual([...SEAT_STATUSES].sort());
  });

  it("ascii icons are plain ASCII, and labels are plain words", () => {
    for (const meta of Object.values(STATUS_META)) {
      expect(meta.asciiIcon).toMatch(/^[\x20-\x7e]+$/);
      expect(meta.label).toMatch(/^[a-z ]+$/);
    }
  });
});

// Same render approach as tests/unit/tui-render.test.ts.
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\([a-zA-Z]/g, "");
}

async function renderToLines(element: React.ReactElement, columns: number): Promise<string[]> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    const stream = new PassThrough();
    (stream as any).columns = columns;
    (stream as any).rows = 24;
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

/**
 * Columns a line occupies. Matches Ink's string-width for the icons in
 * STATUS_META: 🛠 (U+1F6E0), ⏳ (U+23F3) and ⏸ (U+23F8) are two columns wide.
 */
function displayWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    const wide = cp >= 0x1f000 || (cp >= 0x23e9 && cp <= 0x23fa);
    width += wide ? 2 : 1;
  }
  return width;
}

const NOW = T0 + 125_000;
const board: Record<string, SeatState> = {
  exec: seatFixture({
    seatId: "exec",
    displayName: "Opus#1",
    model: "claude-opus-5-5",
    role: "engineer",
    status: "tool",
    startedAt: at(0),
    detail: "grep: a-very-long-search-pattern-that-will-not-fit-in-the-row across src/**/*.ts",
  }),
  rev: seatFixture({
    seatId: "rev",
    displayName: "Gemini#1",
    model: "gemini-2.5-pro-preview-the-long-one",
    role: "security-reviewer",
    status: "rate_limited",
    startedAt: at(20_000),
    lastLine: "waiting for quota reset in 42s before retrying the review",
  }),
  queued: seatFixture({ seatId: "queued", displayName: "Qwen#1", model: "AUTO", role: "" }),
  bad: seatFixture({
    seatId: "bad",
    displayName: "Codex#1",
    status: "failed",
    startedAt: at(10_000),
    endedAt: at(40_000),
    detail: "CLI exited with code 2 after a very long error message",
  }),
};

describe("SeatBoard render", () => {
  for (const width of [80, 40]) {
    it(`no rendered line exceeds ${width} columns`, async () => {
      const lines = await renderToLines(
        React.createElement(SeatBoard, { seats: board, width, now: NOW }),
        width,
      );
      const rows = lines.filter((line) => line.trim().length > 0);
      expect(rows.length).toBeGreaterThanOrEqual(Object.keys(board).length);
      for (const line of rows) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    });
  }

  it("each seat row shows its status icon and label together", async () => {
    const lines = await renderToLines(
      React.createElement(SeatBoard, { seats: board, width: 80, now: NOW }),
      80,
    );
    for (const seat of Object.values(board)) {
      const meta = STATUS_META[seat.status as SeatStatus];
      const row = lines.find((line) => line.includes(meta.icon));
      expect(row, `row for ${seat.seatId}`).toBeDefined();
      expect(row!.indexOf(meta.label)).toBeGreaterThan(row!.indexOf(meta.icon));
    }
  });

  it("shows elapsed time on a finished seat", async () => {
    const lines = await renderToLines(
      React.createElement(SeatBoard, { seats: { bad: board.bad! }, width: 80, now: NOW }),
      80,
    );
    expect(lines.join("\n")).toContain("0:30");
  });

  it("ascii mode draws only ascii icons", async () => {
    const lines = await renderToLines(
      React.createElement(SeatBoard, { seats: board, width: 80, ascii: true, now: NOW }),
      80,
    );
    const output = lines.join("\n");
    for (const meta of Object.values(STATUS_META)) {
      expect(output).not.toContain(meta.icon);
    }
    expect(output).toContain(STATUS_META.rate_limited.label);
    expect(output).toContain(STATUS_META.tool.asciiIcon);
  });
});
