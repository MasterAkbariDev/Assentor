import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { userConfigPath } from "../config/paths.js";

export type BinaryTool =
  | "cursor"
  | "claude"
  | "agy"
  | "codex"
  | "qwen"
  | "opencode";

export interface HostEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

function host(overrides?: Partial<HostEnv>): HostEnv {
  return {
    platform: overrides?.platform ?? process.platform,
    env: overrides?.env ?? process.env,
    homedir: overrides?.homedir ?? os.homedir(),
  };
}

function homeDirs(h: HostEnv) {
  const home = h.env.USERPROFILE || h.env.HOME || h.homedir;
  const localAppData =
    h.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appData = h.env.APPDATA || path.join(home, "AppData", "Roaming");
  return {
    home,
    localAppData,
    appData,
    localBin: path.join(home, ".local", "bin"),
  };
}

function pathExtensions(h: HostEnv): string[] {
  if (h.platform !== "win32") {
    return [""];
  }
  const raw = h.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS";
  const exts = raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return ["", ...exts];
}

export function fileLooksRunnable(
  filePath: string,
  h: HostEnv = host(),
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (h.platform === "win32") {
      return true;
    }
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandInDir(dir: string, name: string, h: HostEnv): string[] {
  if (!dir || !name) {
    return [];
  }
  if (path.extname(name) || name.includes("/") || name.includes("\\")) {
    return [path.join(dir, name)];
  }
  return pathExtensions(h).map((ext) => path.join(dir, `${name}${ext}`));
}

/**
 * Resolve a command on PATH, honoring Windows PATHEXT (`.cmd`, `.exe`, …).
 */
export function findOnPath(
  command: string,
  h: HostEnv = host(),
): string | undefined {
  const pathEnv = h.env.PATH ?? h.env.Path ?? "";
  const dirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    ...extraPathDirs(h),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    for (const candidate of expandInDir(dir, command, h)) {
      if (fileLooksRunnable(candidate, h)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function extraPathDirs(h: HostEnv): string[] {
  const { home, appData, localBin } = homeDirs(h);
  if (h.platform === "win32") {
    return [
      path.join(appData, "npm"),
      path.join(home, "AppData", "Roaming", "npm"),
    ];
  }
  return [
    localBin,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(home, ".npm-global", "bin"),
  ];
}

function findNamedUnder(
  root: string,
  names: string[],
  maxDepth: number,
  h: HostEnv,
): string | undefined {
  if (maxDepth < 0 || !existsSync(root)) {
    return undefined;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const direct = path.join(root, name);
    if (fileLooksRunnable(direct, h)) {
      return direct;
    }
  }
  if (maxDepth === 0) {
    return undefined;
  }
  for (const entry of entries) {
    const child = path.join(root, entry);
    try {
      if (!statSync(child).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const hit = findNamedUnder(child, names, maxDepth - 1, h);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** Default install locations when the CLI is not on PATH. */
export function wellKnownBinaryPaths(
  tool: BinaryTool,
  h: HostEnv = host(),
): string[] {
  const { home, localAppData, appData, localBin } = homeDirs(h);
  const npm = path.join(appData, "npm");

  if (tool === "cursor") {
    if (h.platform === "win32") {
      return [
        path.join(localAppData, "cursor-agent", "agent.cmd"),
        path.join(localAppData, "cursor-agent", "agent.exe"),
        path.join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
        path.join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.exe"),
        path.join(localAppData, "Programs", "Cursor", "resources", "app", "bin", "cursor.cmd"),
        path.join(localAppData, "Programs", "Cursor", "resources", "app", "bin", "cursor.exe"),
        path.join(localBin, "agent.cmd"),
        path.join(localBin, "cursor-agent.cmd"),
        path.join(npm, "agent.cmd"),
        path.join(npm, "cursor.cmd"),
      ];
    }
    if (h.platform === "darwin") {
      return [
        path.join(localBin, "agent"),
        path.join(localBin, "cursor-agent"),
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        "/Applications/Cursor.app/Contents/Resources/app/bin/agent",
      ];
    }
    return [
      path.join(localBin, "agent"),
      path.join(localBin, "cursor-agent"),
      "/opt/Cursor/resources/app/bin/cursor",
      "/usr/share/cursor/resources/app/bin/cursor",
    ];
  }

  if (tool === "agy") {
    if (h.platform === "win32") {
      return [
        path.join(localAppData, "agy", "bin", "agy.exe"),
        path.join(localAppData, "agy", "bin", "agy.cmd"),
        path.join(npm, "agy.cmd"),
        path.join(npm, "agy.exe"),
        path.join(localBin, "agy.cmd"),
      ];
    }
    return [
      path.join(localBin, "agy"),
      "/usr/local/bin/agy",
      "/opt/homebrew/bin/agy",
    ];
  }

  const unixBins = (name: string) => [
    path.join(localBin, name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ];
  const winNpm = (name: string) => [
    path.join(npm, `${name}.cmd`),
    path.join(npm, `${name}.exe`),
    path.join(localBin, `${name}.cmd`),
  ];

  const names: Record<Exclude<BinaryTool, "cursor" | "agy">, string> = {
    claude: "claude",
    codex: "codex",
    qwen: "qwen",
    opencode: "opencode",
  };
  const name = names[tool];
  if (h.platform === "win32") {
    return winNpm(name);
  }
  return unixBins(name);
}

const TOOL_NAMES: Record<BinaryTool, string[]> = {
  cursor: ["agent", "cursor-agent", "cursor"],
  claude: ["claude"],
  agy: ["agy", "antigravity"],
  codex: ["codex"],
  qwen: ["qwen", "qwen-code"],
  opencode: ["opencode"],
};

const TOOL_ENV: Record<BinaryTool, string[]> = {
  cursor: ["ASSENTOR_CURSOR_BINARY"],
  claude: ["ASSENTOR_CLAUDE_BINARY"],
  agy: ["ASSENTOR_AGY_BINARY", "ASSENTOR_ANTIGRAVITY_BINARY"],
  codex: ["ASSENTOR_CODEX_BINARY"],
  qwen: ["ASSENTOR_QWEN_BINARY"],
  opencode: ["ASSENTOR_OPENCODE_BINARY"],
};

export function locateBinary(
  tool: BinaryTool,
  options: { persist?: boolean; host?: Partial<HostEnv> } = {},
): string | undefined {
  const h = host(options.host);
  for (const envName of TOOL_ENV[tool]) {
    const override = h.env[envName]?.trim();
    if (override && fileLooksRunnable(override, h)) {
      return override;
    }
  }

  if (!options.host || process.env.ASSENTOR_BINARY_CACHE_PATH) {
    const cached = readCachedBinaries()[tool];
    if (cached && fileLooksRunnable(cached, h)) {
      return cached;
    }
  }

  for (const name of TOOL_NAMES[tool]) {
    const fromPath = findOnPath(name, h);
    if (fromPath) {
      if (options.persist !== false) {
        rememberBinary(tool, fromPath);
      }
      return fromPath;
    }
  }

  for (const candidate of wellKnownBinaryPaths(tool, h)) {
    if (fileLooksRunnable(candidate, h)) {
      if (options.persist !== false) {
        rememberBinary(tool, candidate);
      }
      return candidate;
    }
  }

  if (tool === "cursor" && h.platform === "win32") {
    const scanned = findNamedUnder(
      path.join(homeDirs(h).localAppData, "cursor-agent"),
      ["agent.cmd", "agent.exe", "agent.bat"],
      2,
      h,
    );
    if (scanned) {
      if (options.persist !== false) {
        rememberBinary(tool, scanned);
      }
      return scanned;
    }
  }

  return undefined;
}

export function readCachedBinaries(): Partial<Record<BinaryTool, string>> {
  try {
    const raw = readFileSync(binaryCachePath(), "utf8");
    const parsed = parseYaml(raw) as { binaries?: Record<string, unknown> } | null;
    const binaries = parsed?.binaries ?? {};
    const out: Partial<Record<BinaryTool, string>> = {};
    for (const key of Object.keys(TOOL_NAMES) as BinaryTool[]) {
      const value = binaries[key];
      if (typeof value === "string" && value.trim()) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberBinary(tool: BinaryTool, filePath: string): void {
  if (process.env.VITEST && !process.env.ASSENTOR_BINARY_CACHE_PATH) {
    return;
  }
  const cachePath = binaryCachePath();
  let current: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(readFileSync(cachePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    } else if (parsed != null) {
      return; // valid YAML but not a mapping: not ours to overwrite
    }
  } catch (error) {
    // Only a missing file may start from {}. Unreadable or corrupt config is
    // left untouched: losing the user's config is worse than not caching.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return;
    }
  }
  current.binaries = {
    ...((current.binaries as Record<string, unknown> | undefined) ?? {}),
    [tool]: filePath,
  };
  // Write through a symlinked config (dotfile managers) instead of replacing the link.
  const target = existsSync(cachePath) ? realpathSync(cachePath) : cachePath;
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, stringifyYaml(current, { lineWidth: 100 }), "utf8");
    renameSync(tmp, target);
  } catch {
    // Best-effort cache: do not fail when user config dir is read-only or restricted
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing more to clean up
    }
  }
}

function binaryCachePath(): string {
  return process.env.ASSENTOR_BINARY_CACHE_PATH || userConfigPath();
}

/**
 * Quote one argument for `cmd.exe /d /v:off /s /c`. Inside double quotes cmd
 * treats `& | < > ^ ( )` as text, so any argument with whitespace, a quote or
 * one of those is quoted. `%VAR%` is still expanded inside quotes and a newline
 * ends the command, so `spawnCliProcess` refuses both and prompts never reach
 * the command line (`cliPromptInvocation`). Exported for tests.
 */
export function quoteCmdArg(value: string): string {
  if (value.length > 0 && !/[\s"&|<>^()!,;=]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** True when `command` must run through cmd.exe (a `.cmd`/`.bat` shim on Windows). */
export function isWindowsCmdShim(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * Throws for an argument cmd.exe would alter (`%VAR%` expansion), cut short
 * (newline), or that would re-split argv once the shim's `%*` reaches node.exe
 * (a `"`, or a trailing `\` that turns the closing quote into `\"`).
 */
export function assertCmdSafeArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (/[%"\r\n]/.test(arg) || arg.endsWith("\\")) {
      throw new Error(
        `Refusing to run a .cmd/.bat CLI with an argument containing "%", a double quote, a newline or a trailing backslash (cmd.exe would expand, split or truncate it): ${JSON.stringify(arg.slice(0, 120))}`,
      );
    }
  }
}

/**
 * How each CLI takes its prompt off the cmd.exe command line. `stdin`: the CLI
 * reads the prompt from stdin when none is given (claude -p). `stdin-dash`: a
 * `-` prompt reads stdin (codex exec). `file`: no confirmed stdin support, so
 * the prompt goes in a private temp file and the CLI is told to read it;
 * `addDir` makes that file's directory readable to the agent. `refuse`: no
 * transport verified, so the run fails closed.
 */
const CMD_PROMPT: Record<BinaryTool, { mode: "stdin" | "stdin-dash" | "file" | "refuse"; addDir?: string }> = {
  claude: { mode: "stdin" },
  codex: { mode: "stdin-dash" },
  cursor: { mode: "file", addDir: "--add-dir" },
  agy: { mode: "file", addDir: "--add-dir" },
  qwen: { mode: "refuse" },
  opencode: { mode: "refuse" },
};

/** Prompt temp dirs still on disk; removed on process exit if a run never reached its `finally`. */
const pendingPromptDirs = new Set<string>();
let promptDirExitHook = false;

function removePromptDir(dir: string): void {
  pendingPromptDirs.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the file briefly after a kill; the OS temp cleaner gets it.
  }
}

export interface CliPromptInvocation {
  args: string[];
  /** Prompt text for the child's stdin (pass as `spawnCliProcess`'s `input`). */
  stdin?: string;
  /** Removes the prompt temp dir, if any. Call in `finally` once the child is done. */
  cleanup: () => void;
}

/**
 * Final argv for a CLI whose `args` end with the prompt (`prompt` or
 * `-p=<prompt>`). Unchanged unless `command` is a Windows `.cmd`/`.bat` shim:
 * cmd.exe expands `%VAR%` and stops at newlines even inside quotes, so the
 * prompt then moves to stdin or a private temp file.
 */
export function cliPromptInvocation(
  tool: BinaryTool,
  command: string,
  args: string[],
  prompt: string,
): CliPromptInvocation {
  const noop = () => {};
  if (!isWindowsCmdShim(command)) {
    return { args, cleanup: noop };
  }
  const last = args[args.length - 1];
  const attached = last === `-p=${prompt}`;
  if (!attached && last !== prompt) {
    throw new Error("cliPromptInvocation: the prompt must be the last CLI argument");
  }
  const base = args.slice(0, -1);
  const how = CMD_PROMPT[tool];
  if (how.mode === "refuse") {
    throw new Error(`prompt transport unverified for ${tool} via .cmd shim; use the native binary or WSL`);
  }
  if (how.mode === "stdin") {
    return { args: base, stdin: prompt, cleanup: noop };
  }
  if (how.mode === "stdin-dash") {
    return { args: [...base, "-"], stdin: prompt, cleanup: noop };
  }
  // mkdtemp makes a fresh 0700 dir per run; the file itself is 0600.
  const dir = mkdtempSync(path.join(os.tmpdir(), "assentor-prompt-"));
  pendingPromptDirs.add(dir);
  if (!promptDirExitHook) {
    promptDirExitHook = true;
    process.once("exit", () => [...pendingPromptDirs].forEach(removePromptDir));
  }
  const cleanup = () => removePromptDir(dir);
  const file = path.join(dir, "prompt.md");
  try {
    writeFileSync(file, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    cleanup();
    throw error;
  }
  const pointer = `Your full task is in the file ${file} - read that whole file first and follow its instructions exactly.`;
  return {
    args: [...base, ...(how.addDir ? [how.addDir, dir] : []), attached ? `-p=${pointer}` : pointer],
    cleanup,
  };
}

/**
 * Spawn a CLI on Windows even when the file is `agent.cmd` (Node cannot exec .cmd without cmd.exe).
 * `input`, when set, is written to the child's stdin (which is then a pipe).
 */
export function spawnCliProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  input?: string,
): ChildProcess {
  const opts: SpawnOptions =
    input === undefined
      ? { ...options, windowsHide: true }
      : { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  let child: ChildProcess;
  if (isWindowsCmdShim(command)) {
    assertCmdSafeArgs([command, ...args]);
    const comspec = process.env.ComSpec || "cmd.exe";
    // /v:off: no `!VAR!` delayed expansion even if the registry turns it on.
    // Verbatim: libuv would otherwise re-escape each quoted arg as `"\"x\""`,
    // which cmd ignores, letting `&` etc. escape. /s strips the outer quotes.
    const line = `"${[command, ...args].map(quoteCmdArg).join(" ")}"`;
    child = spawn(comspec, ["/d", "/v:off", "/s", "/c", line], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(command, args, opts);
  }
  if (input !== undefined) {
    child.stdin?.on("error", () => {}); // EPIPE when the CLI exits without reading
    child.stdin?.end(input);
  }
  return child;
}
