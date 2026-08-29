import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import { Shell } from "../../src/tui/layout/shell.js";
import { createInkStdout } from "../../src/tui/stdout.js";

function createMockStdout(rows = 40): WriteStream {
  const stream = new PassThrough() as WriteStream & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stream.columns = 120;
  stream.rows = rows;
  stream.isTTY = true;
  return stream;
}

describe("createInkStdout", () => {
  it("reports one row so Ink clears the terminal each frame", () => {
    const base = createMockStdout(40);
    const inkStdout = createInkStdout(base);
    expect(inkStdout.rows).toBe(1);
    expect(inkStdout.columns).toBe(120);
  });

  it("uses full terminal clear on rerender instead of line erase", async () => {
    const frames: string[] = [];
    const base = createMockStdout(40);
    base.on("data", (chunk) => frames.push(chunk.toString()));

    const inkStdout = createInkStdout(base);
    const stdin = new PassThrough();

    const props = {
      version: "0.3.15",
      screen: "workspace" as const,
      focus: "main" as const,
      navIndex: 0,
      statusLabel: "Ready",
      statusTone: "ok" as const,
      footer: "test",
      statusBar: {
        projectLabel: "~/project",
        mode: "Supervised",
        executor: "cursor",
        reviewStrategy: "ADAPTIVE",
        model: "AUTO",
        keysHealthy: "1/1",
      },
    };

    const instance = render(
      React.createElement(Shell, props, null),
      { stdout: inkStdout, stdin: stdin as never, patchConsole: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 40));

    instance.rerender(
      React.createElement(Shell, { ...props, navIndex: 1 }, null),
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    instance.unmount();

    const combined = frames.join("");
    expect(combined).toContain("\u001B[2J");
    expect(combined).not.toMatch(/\u001B\[1A\u001B\[2K/);
  });
});
