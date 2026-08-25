import { spawn } from "node:child_process";
import path from "node:path";
import {
  isCursorAppBinary,
  resolveCursorBinary,
} from "../providers/executors/cursor/index.js";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

/**
 * Fail-fast environment checks before starting an Assentor run.
 */
export async function runPreflight(input: {
  executor: string;
  reviewer: string;
  /** Target project directory for Cursor workspace trust / probe cwd. */
  projectPath?: string;
}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const projectPath = path.resolve(input.projectPath ?? process.cwd());

  checks.push({
    name: "node",
    ok: true,
    detail: process.version,
  });

  if (input.executor === "cursor") {
    checks.push(await checkCursor(projectPath));
  } else if (input.executor === "mock") {
    checks.push({
      name: "executor:mock",
      ok: true,
      detail: "mock executor (no network)",
    });
  }

  if (input.reviewer === "gemini") {
    const key =
      process.env.ASSENTOR_GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;
    checks.push({
      name: "reviewer:gemini",
      ok: Boolean(key),
      detail: key
        ? "API key present"
        : "missing GEMINI_API_KEY / ASSENTOR_GEMINI_API_KEY / GOOGLE_API_KEY",
    });
  } else if (input.reviewer === "openai") {
    const key = process.env.ASSENTOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    checks.push({
      name: "reviewer:openai",
      ok: Boolean(key),
      detail: key
        ? "API key present"
        : "missing OPENAI_API_KEY / ASSENTOR_OPENAI_API_KEY",
    });
  } else if (input.reviewer === "mock") {
    checks.push({
      name: "reviewer:mock",
      ok: true,
      detail: "mock reviewer (no network)",
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function checkCursor(projectPath: string): Promise<PreflightCheck> {
  const binary = resolveCursorBinary();
  // Match the real executor flags: non-interactive + trust the target project.
  const baseArgs = [
    "-p",
    "--print",
    "--force",
    "--trust",
    "--workspace",
    projectPath,
    "--output-format",
    "text",
    "Reply with exactly: PONG",
  ];
  const args = isCursorAppBinary(binary) ? ["agent", ...baseArgs] : baseArgs;

  try {
    const result = await spawnCapture(binary, args, 45_000, projectPath);
    const combined = `${result.stdout}\n${result.stderr}`;

    if (/Authentication required/i.test(combined)) {
      return {
        name: "executor:cursor",
        ok: false,
        detail:
          `found ${binary}, but headless auth failed. Run: agent login\n` +
          `  or set CURSOR_API_KEY. (Note: "status" can say logged in while -p still fails.)`,
      };
    }

    if (/Workspace Trust Required/i.test(combined)) {
      return {
        name: "executor:cursor",
        ok: false,
        detail:
          `workspace trust blocked for ${projectPath}. Assentor should pass --trust; if this persists, run once:\n` +
          `  agent -p --trust --force --workspace "${projectPath}" "PONG"`,
      };
    }

    if (result.timedOut) {
      return {
        name: "executor:cursor",
        ok: false,
        detail: `cursor probe timed out using ${binary} in ${projectPath}`,
      };
    }

    if (result.code !== 0 && !result.stdout.trim()) {
      return {
        name: "executor:cursor",
        ok: false,
        detail: `cursor probe failed (${result.code}): ${result.stderr.trim() || "no output"}`,
      };
    }

    return {
      name: "executor:cursor",
      ok: true,
      detail: `ok via ${isCursorAppBinary(binary) ? `${binary} agent` : binary} (workspace ${projectPath})`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "executor:cursor",
      ok: false,
      detail: message,
    };
  }
}

function spawnCapture(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    const finish = (result: {
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut?: boolean;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

export function printPreflight(result: PreflightResult): void {
  const dim = "\x1b[2m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const reset = "\x1b[0m";
  console.log(`${dim}── Preflight ──────────────────────────────────${reset}`);
  for (const check of result.checks) {
    const mark = check.ok ? `${green}✓${reset}` : `${red}✗${reset}`;
    console.log(`${mark} ${check.name}: ${check.detail}`);
  }
  console.log(`${dim}──────────────────────────────────────────────${reset}`);
}
