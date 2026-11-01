import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FU-13: a prompt must never reach the cmd.exe command line of a `.cmd` shim.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const {
  cliPromptInvocation,
  spawnCliProcess,
} = await import("../../packages/engine/src/executors/cli-locator.js");
const {
  buildPrintCliArgs,
  createEmptyContract,
  CursorExecutor,
  PRINT_CLI_RECIPES,
  PrintCliExecutor,
  ProcessCliTransport,
} = await import("../../packages/engine/src/index.js");

const PROMPT = 'Fix %PATH% and !X! then a ^ b & c | d\nsecond line\r\nthird "q"';
const FRAGMENTS = ["%PATH%", "!X!", "^", "&", "\n", "second line"];
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value });

beforeEach(() => setPlatform("win32"));
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  spawnMock.mockReset();
});

function expectNoPrompt(args: string[]) {
  for (const arg of args) {
    for (const fragment of FRAGMENTS) {
      expect(arg).not.toContain(fragment);
    }
  }
}

/** The temp file a `file`-mode invocation points at. */
function promptFile(args: string[]): string {
  const hit = args.map((a) => /file (\S+prompt\.md)/.exec(a)?.[1]).find(Boolean);
  expect(hit).toBeTruthy();
  return hit!;
}

describe("cliPromptInvocation", () => {
  it("leaves POSIX and non-.cmd argv untouched", () => {
    const args = buildPrintCliArgs(PRINT_CLI_RECIPES["claude-code"]!, PROMPT);
    setPlatform("darwin");
    expect(cliPromptInvocation("claude", "/usr/local/bin/claude.cmd", args, PROMPT)).toMatchObject({ args });
    setPlatform("win32");
    const inv = cliPromptInvocation("claude", "C:\\bin\\claude.exe", args, PROMPT);
    expect(inv.args).toBe(args);
    expect(inv.stdin).toBeUndefined();
  });

  it("claude.cmd: prompt on stdin, no prompt argument", () => {
    const args = buildPrintCliArgs(PRINT_CLI_RECIPES["claude-code"]!, PROMPT);
    const inv = cliPromptInvocation("claude", "C:\\npm\\claude.cmd", args, PROMPT);
    expect(inv.args).toEqual(args.slice(0, -1));
    expect(inv.stdin).toBe(PROMPT);
  });

  it("codex.cmd: `-` prompt and stdin", () => {
    const args = buildPrintCliArgs(PRINT_CLI_RECIPES.codex!, PROMPT, { model: "gpt-5" });
    const inv = cliPromptInvocation("codex", "C:\\npm\\codex.CMD", args, PROMPT);
    expect(inv.args).toEqual([...args.slice(0, -1), "-"]);
    expect(inv.stdin).toBe(PROMPT);
  });

  it("agy.cmd (attached -p=): private temp file, readable dir added, removed by cleanup", () => {
    const args = buildPrintCliArgs(PRINT_CLI_RECIPES.antigravity!, PROMPT);
    const inv = cliPromptInvocation("agy", "C:\\npm\\agy.bat", args, PROMPT);
    expectNoPrompt(inv.args);
    expect(inv.stdin).toBeUndefined();
    const file = promptFile(inv.args);
    expect(readFileSync(file, "utf8")).toBe(PROMPT);
    if (realPlatform.value !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    expect(inv.args.slice(-3, -1)).toEqual(["--add-dir", path.dirname(file)]);
    expect(inv.args.at(-1)!.startsWith("-p=")).toBe(true);
    inv.cleanup();
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it("refuses when the prompt is not the last argument", () => {
    expect(() => cliPromptInvocation("claude", "C:\\npm\\claude.cmd", ["-p", PROMPT, "--x"], PROMPT)).toThrow(/last CLI argument/);
  });
});

describe("spawnCliProcess for .cmd shims", () => {
  function fakeChild() {
    const written: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: (data: string) => written.push(data) }),
    });
    spawnMock.mockReturnValue(child);
    return written;
  }

  it("spawns cmd.exe verbatim with one quoted line, no delayed expansion, prompt on stdin", () => {
    const written = fakeChild();
    spawnCliProcess("C:\\npm\\claude.cmd", ["-p", "--model", "opus"], { stdio: ["ignore", "pipe", "pipe"] }, PROMPT);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, argv, opts] = spawnMock.mock.calls[0]!;
    expect(command).toMatch(/cmd\.exe$/i);
    expect(argv).toEqual(["/d", "/v:off", "/s", "/c", '"C:\\npm\\claude.cmd -p --model opus"']);
    expect(opts).toEqual({ stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true });
    expectNoPrompt(argv);
    expect(written).toEqual([PROMPT]);
  });

  /**
   * Model of how the line is read (cmd.exe and MSVCRT rules):
   * 1. `cmd /s /c "<line>"`: /s removes the first and the last `"` after /c.
   * 2. cmd scans the rest; each `"` toggles quote mode, and outside quotes
   *    `& | < > ( ) ^` are operators or the escape char (collected as `bare`).
   * 3. The shim's `%*` reaches node.exe, whose CRT splits on spaces/tabs
   *    outside quotes and drops the quote characters (args hold no `"`).
   */
  function cmdParse(line: string): { argv: string[]; bare: string[] } {
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    const argv: string[] = [];
    const bare: string[] = [];
    let cur = "";
    let inQuotes = false;
    let started = false;
    for (const ch of line.slice(1, -1)) {
      if (ch === '"') {
        inQuotes = !inQuotes;
        started = true;
      } else if (!inQuotes && /[ \t]/.test(ch)) {
        if (started) argv.push(cur);
        cur = "";
        started = false;
      } else {
        if (!inQuotes && /[&|<>()^]/.test(ch)) bare.push(ch);
        cur += ch;
        started = true;
      }
    }
    if (started) argv.push(cur);
    return { argv, bare };
  }

  it("R&D paths, ^ and parens survive cmd /s /c parsing intact", () => {
    fakeChild();
    const command = "C:\\Program Files\\R&D (x)\\agent.cmd";
    const args = [
      "-p",
      "--workspace",
      "C:\\work\\R&D\\a^b (1)|c<d>",
      "--model",
      "claude-opus-4[effort=high,fast=false]",
      "--add-dir",
      "C:\\Users\\A B\\Temp\\assentor-prompt-x1",
      "-p=Your full task is in the file C:\\Users\\A B\\Temp\\assentor-prompt-x1\\prompt.md - read it",
      "",
    ];
    spawnCliProcess(command, args, {});
    const argv = spawnMock.mock.calls[0]![1] as string[];
    expect(argv).toHaveLength(5);
    expect(cmdParse(argv[4]!)).toEqual({ argv: [command, ...args], bare: [] });
  });

  it.each(["%PATH%", "C:\\w\\100%", "a\nb", "a\rb", 'say "hi"', "C:\\w\\"])("refuses a non-prompt arg %j", (bad) => {
    fakeChild();
    expect(() => spawnCliProcess("C:\\npm\\agent.cmd", ["--workspace", bad], {})).toThrow(
      /cmd\.exe would expand, split or truncate it/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps POSIX spawn byte-identical", () => {
    fakeChild();
    setPlatform("linux");
    spawnCliProcess("/bin/claude.cmd", ["-p", "%PATH%"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(spawnMock).toHaveBeenCalledWith("/bin/claude.cmd", ["-p", "%PATH%"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  });
});

describe("executors and reviewers route through the helper", () => {
  const task = (prompt: string) => ({
    taskId: "t1",
    projectPath: process.cwd(),
    contract: createEmptyContract("goal"),
    prompt,
  });

  it("PrintCliExecutor claude.cmd: stdin, argv clean", async () => {
    const seen: Array<{ args: string[]; stdin?: string }> = [];
    const executor = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES["claude-code"]!,
      binary: "C:\\npm\\claude.cmd",
      spawnFn: async (req) => {
        seen.push({ args: req.args, stdin: req.stdin });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await executor.run(task(PROMPT));
    expectNoPrompt(seen[0]!.args);
    expect(seen[0]!.stdin).toBe(PROMPT);
  });

  it.each([
    ["success", 0],
    ["failure", 1],
  ])("PrintCliExecutor agy.cmd: temp file intact during run, removed after %s", async (_label, code) => {
    let file = "";
    const executor = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES.antigravity!,
      binary: "C:\\npm\\agy.cmd",
      spawnFn: async (req) => {
        expectNoPrompt(req.args);
        file = promptFile(req.args);
        expect(readFileSync(file, "utf8")).toBe(PROMPT);
        return { code, stdout: "", stderr: "boom" };
      },
    });
    await executor.run(task(PROMPT));
    expect(file).not.toBe("");
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it.each([
    ["qwen", "C:\\npm\\qwen.cmd"],
    ["opencode", "C:\\npm\\opencode.cmd"],
  ] as const)("%s via .cmd fails closed", async (id, binary) => {
    const spawnFn = vi.fn();
    const executor = new PrintCliExecutor({ recipe: PRINT_CLI_RECIPES[id]!, binary, spawnFn });
    const result = await executor.run(task(PROMPT));
    expect(result.status).toBe("failed");
    expect(result.error).toBe(`prompt transport unverified for ${id} via .cmd shim; use the native binary or WSL`);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("PrintCliExecutor: temp file removed on spawn throw and on cancel", async () => {
    let file = "";
    const throwing = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES.antigravity!,
      binary: "C:\\npm\\agy.cmd",
      spawnFn: async (req) => {
        file = promptFile(req.args);
        throw new Error("spawn EINVAL");
      },
    });
    expect((await throwing.run(task(PROMPT))).status).toBe("failed");
    expect(existsSync(path.dirname(file))).toBe(false);

    let started!: () => void;
    const spawned = new Promise<void>((resolve) => (started = resolve));
    const hanging = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES.antigravity!,
      binary: "C:\\npm\\agy.cmd",
      spawnFn: (req) => {
        file = promptFile(req.args);
        req.onSpawn?.({ kill: () => true });
        started();
        return new Promise(() => {}); // never exits on its own
      },
    });
    const run = hanging.run(task(PROMPT));
    await spawned;
    expect(existsSync(file)).toBe(true);
    await hanging.cancel("t1");
    expect((await run).status).toBe("cancelled");
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it("CursorExecutor agent.cmd: prompt in temp file, removed after", async () => {
    let file = "";
    const executor = new CursorExecutor({
      binary: "C:\\cursor-agent\\agent.cmd",
      spawnFn: async (req) => {
        expectNoPrompt(req.args);
        file = promptFile(req.args);
        expect(readFileSync(file, "utf8")).toBe(PROMPT);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await executor.run(task(PROMPT));
    expect(executor.lastCommand?.args).toContain("--add-dir");
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it("reviewer codex.cmd uses `-` + stdin; cursor reviewer cleans its file even when spawn throws", async () => {
    const codex = new ProcessCliTransport({
      adapter: "codex",
      binary: "C:\\npm\\codex.cmd",
      spawnFn: async (req) => {
        expect(req.args.at(-1)).toBe("-");
        expectNoPrompt(req.args);
        expect(req.stdin).toBe(PROMPT);
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    await codex.run({ prompt: PROMPT, cwd: process.cwd(), timeoutMs: 1000 });

    let file = "";
    const cursor = new ProcessCliTransport({
      adapter: "cursor",
      binary: "C:\\cursor-agent\\agent.cmd",
      spawnFn: async (req) => {
        file = promptFile(req.args);
        expect(readFileSync(file, "utf8")).toBe(PROMPT);
        throw new Error("aborted");
      },
    });
    await expect(cursor.run({ prompt: PROMPT, cwd: process.cwd(), timeoutMs: 1000 })).rejects.toThrow("aborted");
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it("POSIX executor argv is unchanged", async () => {
    setPlatform("linux");
    const seen: string[][] = [];
    const executor = new PrintCliExecutor({
      recipe: PRINT_CLI_RECIPES.antigravity!,
      binary: "/usr/bin/agy",
      spawnFn: async (req) => {
        seen.push(req.args);
        expect(req.stdin).toBeUndefined();
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await executor.run(task(PROMPT));
    expect(seen[0]).toEqual(buildPrintCliArgs(PRINT_CLI_RECIPES.antigravity!, PROMPT));
  });
});
