import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  readFileSync,
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

  const cached = readCachedBinaries()[tool];
  if (cached && fileLooksRunnable(cached, h)) {
    return cached;
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
    const raw = readFileSync(cachePath, "utf8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const binaries = {
    ...((current.binaries as Record<string, unknown> | undefined) ?? {}),
    [tool]: filePath,
  };
  current.binaries = binaries;
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, stringifyYaml(current, { lineWidth: 100 }), "utf8");
}

function binaryCachePath(): string {
  return process.env.ASSENTOR_BINARY_CACHE_PATH || userConfigPath();
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Spawn a CLI on Windows even when the file is `agent.cmd` (Node cannot exec .cmd without cmd.exe).
 */
export function spawnCliProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  const winScript =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  if (winScript) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(
      comspec,
      ["/d", "/s", "/c", quoteCmdArg(command), ...args.map(quoteCmdArg)],
      { ...options, windowsHide: true },
    );
  }
  return spawn(command, args, { ...options, windowsHide: true });
}
