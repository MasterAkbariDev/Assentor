import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { Shell } from "../../src/tui/layout/shell.js";
import { HelpScreen } from "../../src/tui/screens/help.js";
import { ConfigurationScreen } from "../../src/tui/screens/configuration.js";
import { WorkspaceScreen } from "../../src/tui/screens/workspace.js";
import { parseAssentorConfig } from "../../src/config/load.js";

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\([a-zA-Z]/g, "");
}

async function renderInkToString(
  element: React.ReactElement,
  columns = 80,
  rows = 24,
): Promise<string> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    const stream = new PassThrough();
    (stream as any).columns = columns;
    (stream as any).rows = rows;

    stream.on("data", (chunk) => {
      frames.push(chunk.toString());
    });

    const instance = render(element, {
      stdout: stream as any,
      stdin: new PassThrough() as any,
      patchConsole: false,
      debug: true,
    });

    setTimeout(() => {
      const meaningful = frames.filter((f) => f.trim().length > 0);
      const lastFrame = meaningful[meaningful.length - 1] ?? "";
      try {
        instance.unmount();
      } catch {
        // ignore
      }
      resolve(lastFrame);
    }, 60);
  });
}

describe("TUI Narrow 80-Column Layout Renders", () => {
  const config = parseAssentorConfig({
    run: { mode: "supervised" },
    executor: { provider: "cursor" },
    reviewers: [
      { provider: "gemini", transport: "api", role: "security" },
      { provider: "claude", transport: "cli", role: "architecture" },
    ],
  });

  const statusBar = {
    projectLabel: "~/valorant-coach",
    mode: "Supervised",
    executor: "cursor",
    reviewStrategy: "ADAPTIVE",
    model: "gemini-2.5",
    keysHealthy: "2/2",
  };

  it("renders Help screen without line overflow on 80x24 terminal", async () => {
    const output = await renderInkToString(
      React.createElement(
        Shell,
        {
          version: "0.3.15",
          screen: "help",
          focus: "main",
          navIndex: 6,
          statusLabel: "Ready",
          statusTone: "ok",
          footer: "/ Commands · Esc Nav · q Quit from nav",
          statusBar,
        },
        React.createElement(HelpScreen),
      ),
      80,
      24,
    );

    // Verify key sections and legible shortcut lines are present
    expect(output).toContain("ASSENTOR");
    expect(output).toContain("Navigation Controls");
    expect(output).toContain("Action Shortcuts");
    expect(output).toContain("CLI Companion Commands");
    expect(output).toContain("Direct Jump");
    expect(output).toContain("Switch Pane");
    expect(output).toContain("assentor run");
    expect(output).toContain("assentor resume");

    // Guard: ensure no rendered line exceeds 80 columns
    const cleanLines = output
      .split("\n")
      .map(stripAnsi)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    expect(cleanLines.length).toBeGreaterThan(0);
    for (const line of cleanLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("renders Configuration AI defaults with CycleSelector on 80-column terminal", async () => {
    const output = await renderInkToString(
      React.createElement(
        Shell,
        {
          version: "0.3.15",
          screen: "configuration",
          focus: "main",
          navIndex: 4,
          statusLabel: "Ready",
          statusTone: "ok",
          footer: "↑↓ Field · ←→ Cycle · s Save · Esc Back",
          statusBar,
        },
        React.createElement(ConfigurationScreen, {
          section: "ai",
          selected: 0,
          focused: true,
          config,
          keys: [],
          executorRows: [],
          installedIds: new Set(["cursor"]),
        }),
      ),
      80,
      24,
    );

    expect(output).toContain("Execution Mode");
    expect(output).toContain("◄");
    expect(output).toContain("►");
    expect(output).toContain("Supervised");
    expect(output).toContain("Executor halts at verification gates");

    const cleanLines = output
      .split("\n")
      .map(stripAnsi)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    expect(cleanLines.length).toBeGreaterThan(0);
    for (const line of cleanLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("renders Workspace Command Center with stacked metrics on 80-column terminal", async () => {
    const output = await renderInkToString(
      React.createElement(
        Shell,
        {
          version: "0.3.15",
          screen: "workspace",
          focus: "main",
          navIndex: 0,
          statusLabel: "Ready",
          statusTone: "ok",
          footer: "↑↓ Actions · ↵ Select · n New task · m Mode",
          statusBar,
        },
        React.createElement(WorkspaceScreen, {
          services: { projectPath: "/Users/scalesops/Developer/valorant-coach" } as any,
          config,
          selected: 0,
          tasks: [],
          updateInfo: null,
          keyHealthy: 2,
          keyTotal: 2,
        }),
      ),
      80,
      24,
    );

    expect(output).toContain("Quick Actions");
    expect(output).toContain("Start a new task");
    expect(output).toContain("Mode:");
    expect(output).toContain("Exec:");
    expect(output).toContain("Reviewers:");
    expect(output).toContain("Keys:");

    const cleanLines = output
      .split("\n")
      .map(stripAnsi)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    expect(cleanLines.length).toBeGreaterThan(0);
    for (const line of cleanLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});
