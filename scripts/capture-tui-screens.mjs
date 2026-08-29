import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";

import { Shell } from "../dist/tui/layout/shell.js";
import { HelpScreen } from "../dist/tui/screens/help.js";
import { ConfigurationScreen } from "../dist/tui/screens/configuration.js";
import { WorkspaceScreen } from "../dist/tui/screens/workspace.js";
import { parseAssentorConfig } from "../dist/config/load.js";

function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const whichPath = execSync("which google-chrome || which chromium || which chromium-browser", {
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (whichPath) return whichPath;
  } catch {
    // fallback
  }
  return candidates[0];
}

const CHROME_PATH = findChromePath();
const SCREENSHOT_DIR = path.resolve("./artifacts/screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function ansiToHtml(ansiStr) {
  // Simple robust ANSI to HTML converter
  const colorMap = {
    30: "#484f58", // black / gray
    31: "#ff7b72", // red
    32: "#3fb950", // green
    33: "#d29922", // yellow
    34: "#58a6ff", // blue
    35: "#bc8cff", // magenta / purple
    36: "#39c5cf", // cyan
    37: "#f0f6fc", // white
    90: "#8b949e", // bright black / dim
    91: "#ffa198", // bright red
    92: "#56d364", // bright green
    93: "#e3b341", // bright yellow
    94: "#79c0ff", // bright blue
    95: "#d2a8ff", // bright magenta
    96: "#56d4dd", // bright cyan
    97: "#ffffff", // bright white
  };

  let html = "";
  let openSpan = false;
  let currentColor = null;
  let isBold = false;
  let isDim = false;

  // Split by ANSI escape sequences \x1b[...]
  const tokens = ansiStr.split(/(\x1b\[[0-9;]*[a-zA-Z])/g);

  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith("\x1b[")) {
      const match = token.match(/\x1b\[([0-9;]*)m/);
      if (match) {
        const codes = match[1] ? match[1].split(";").map(Number) : [0];
        for (const code of codes) {
          if (code === 0) {
            // Reset
            if (openSpan) {
              html += "</span>";
              openSpan = false;
            }
            currentColor = null;
            isBold = false;
            isDim = false;
          } else if (code === 1) {
            isBold = true;
          } else if (code === 2) {
            isDim = true;
          } else if (code === 22) {
            isBold = false;
            isDim = false;
          } else if (colorMap[code]) {
            currentColor = colorMap[code];
          }
        }
      }
      continue;
    }

    // Escape HTML
    const escaped = token
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const styleParts = [];
    if (currentColor) styleParts.push(`color: ${currentColor}`);
    if (isBold) styleParts.push("font-weight: 700");
    if (isDim) styleParts.push("opacity: 0.65");

    if (styleParts.length > 0) {
      if (openSpan) html += "</span>";
      html += `<span style="${styleParts.join("; ")}">${escaped}</span>`;
      openSpan = false;
    } else {
      if (openSpan) {
        html += "</span>";
        openSpan = false;
      }
      html += escaped;
    }
  }

  if (openSpan) html += "</span>";
  return html;
}

function renderTerminalWindowHtml({ title, ansiOutput }) {
  const bodyHtml = ansiToHtml(ansiOutput.trim());
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0d1117;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 24px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }
  .terminal-window {
    width: 820px;
    background: #161b22;
    border-radius: 12px;
    border: 1px solid #30363d;
    box-shadow: 0 20px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05);
    overflow: hidden;
  }
  .title-bar {
    background: #21262d;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid #30363d;
  }
  .traffic-lights {
    display: flex;
    gap: 8px;
    margin-right: 16px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .dot.red { background: #ff5f56; border: 1px solid #e0443e; }
  .dot.yellow { background: #ffbd2e; border: 1px solid #dea123; }
  .dot.green { background: #27c93f; border: 1px solid #1aab29; }
  .window-title {
    color: #8b949e;
    font-size: 13px;
    font-weight: 500;
    flex-grow: 1;
    text-align: center;
    margin-right: 48px;
  }
  .terminal-body {
    padding: 14px 18px;
    color: #c9d1d9;
    font-size: 12.5px;
    line-height: 1.35;
    white-space: pre;
    overflow-x: hidden;
  }
</style>
</head>
<body>
<div class="terminal-window">
  <div class="title-bar">
    <div class="traffic-lights">
      <span class="dot red"></span>
      <span class="dot yellow"></span>
      <span class="dot green"></span>
    </div>
    <div class="window-title">${title} — 80×24 Authentic Ink Render</div>
  </div>
  <div class="terminal-body">${bodyHtml}</div>
</div>
</body>
</html>`;
}

async function captureInkScreen(element) {
  return new Promise((resolve) => {
    const stream = new PassThrough();
    stream.columns = 80;
    stream.rows = 24;

    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const instance = render(element, {
      stdout: stream,
      stdin: new PassThrough(),
      patchConsole: false,
    });

    setTimeout(() => {
      try {
        instance.unmount();
      } catch {
        // ignore
      }
      resolve(output);
    }, 120);
  });
}

async function main() {
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
    taskLabel: "Check tests",
  };

  const screensToCapture = [
    {
      filename: "help-80col.png",
      title: "Assentor TUI — Help Screen (80-col Narrow-Safe)",
      element: React.createElement(
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
        React.createElement(HelpScreen)
      ),
    },
    {
      filename: "configuration-ai-80col.png",
      title: "Assentor TUI — AI Defaults (CycleSelector)",
      element: React.createElement(
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
          executorRows: [
            { id: "cursor", name: "Cursor CLI", detection: { installed: true, path: "/usr/local/bin/cursor" } },
            { id: "antigravity", name: "Antigravity", detection: { installed: true, path: "/usr/local/bin/agy" } },
          ],
          installedIds: new Set(["cursor", "antigravity"]),
        })
      ),
    },
    {
      filename: "workspace-80col.png",
      title: "Assentor TUI — Workspace Command Center",
      element: React.createElement(
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
          services: { projectPath: "/Users/scalesops/Developer/valorant-coach" },
          config,
          selected: 0,
          tasks: [
            {
              taskId: "task-98a72b",
              status: "DONE",
              currentRound: 1,
              maxRounds: 8,
              executor: "cursor",
              contract: { goal: "Check if project has tests or write them" },
            },
          ],
          updateInfo: null,
          keyHealthy: 2,
          keyTotal: 2,
        })
      ),
    },
  ];

  for (const item of screensToCapture) {
    console.log(`Rendering authentic Ink output for ${item.filename}...`);
    const ansiOutput = await captureInkScreen(item.element);
    const html = renderTerminalWindowHtml({
      title: item.title,
      ansiOutput,
    });

    const htmlPath = path.join("/tmp", `${item.filename}.html`);
    const pngPath = path.join(SCREENSHOT_DIR, item.filename);
    fs.writeFileSync(htmlPath, html);

    console.log(`Capturing screenshot with Chrome headless: ${pngPath}`);
    execSync(
      `"${CHROME_PATH}" --headless --disable-gpu --window-size=920,660 --screenshot="${pngPath}" "${htmlPath}"`,
      { stdio: "pipe" }
    );
    console.log(`✓ Saved authentic screenshot: ${pngPath}`);
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
