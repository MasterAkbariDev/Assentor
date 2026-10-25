import type { ChildProcess, SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SEAT_ROLE_PATTERN } from "../core/seats.js";
import { spawnCliProcess } from "../executors/cli-locator.js";
import {
  PROMPT_ROLES,
  PromptLibrary,
  promptLayerDirs,
  type PromptDefinition,
  type PromptLayer,
  type PromptLibraryLoadOptions,
} from "../prompts/index.js";

/**
 * `assentor prompts` commands (task T03-05). Each command is an exported
 * function that takes its project, layer directories, and output sinks, and
 * returns the exit code. `src/cli/index.ts` only wires them to commander.
 */

export interface PromptCommandOptions {
  /** Project whose `.assentor/prompts` is the project layer. */
  projectPath: string;
  /** Overrides the user layer directory (tests). Default `~/.assentor/prompts`. */
  userDir?: string;
  /** Overrides the built-in layer directory (tests). */
  builtinDir?: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export type EditorSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function loadOptions(options: PromptCommandOptions): PromptLibraryLoadOptions {
  return {
    projectPath: options.projectPath,
    userDir: options.userDir,
    builtinDir: options.builtinDir,
  };
}

function loadLibrary(options: PromptCommandOptions): Promise<PromptLibrary> {
  return PromptLibrary.load(loadOptions(options));
}

/** Left-aligned columns, two spaces apart. */
function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

export async function listPrompts(
  options: PromptCommandOptions & { role?: string },
): Promise<number> {
  if (options.role !== undefined && !(PROMPT_ROLES as readonly string[]).includes(options.role)) {
    options.err(`--role must be one of ${PROMPT_ROLES.join(", ")}, got "${options.role}"`);
    return 1;
  }
  const library = await loadLibrary(options);
  const prompts = library.list(options.role as PromptDefinition["role"] | undefined);

  if (prompts.length === 0) {
    options.out(options.role ? `No ${options.role} prompts` : "No prompts");
  } else {
    const rows = prompts.map((prompt) => [
      prompt.id,
      prompt.title,
      prompt.role,
      prompt.layer,
      prompt.overrides ?? "-",
    ]);
    for (const line of table(["ID", "TITLE", "ROLE", "LAYER", "OVERRIDES"], rows)) {
      options.out(line);
    }
  }

  if (library.errors.length > 0) {
    options.out(
      `${library.errors.length} prompt file(s) failed to load; run "assentor prompts validate"`,
    );
  }
  return 0;
}

export async function showPrompt(options: PromptCommandOptions & { id: string }): Promise<number> {
  const library = await loadLibrary(options);
  const prompt = library.get(options.id);
  if (!prompt) {
    options.err(`Unknown prompt "${options.id}"`);
    return 1;
  }
  const summary: Array<[string, string]> = [
    ["id", prompt.id],
    ["role", prompt.role],
    ["title", prompt.title],
    ["permissions", prompt.permissions],
    ["output", prompt.output],
    ["variables", prompt.variables.length > 0 ? prompt.variables.join(", ") : "none"],
    ["version", String(prompt.version)],
    ["extends", prompt.extends ?? "-"],
    ["layer", prompt.layer],
    ["file", prompt.file],
    ["overrides", prompt.overrides ?? "-"],
  ];
  for (const [key, value] of summary) {
    options.out(`${key}: ${value}`);
  }
  options.out("");
  options.out(prompt.body);
  return 0;
}

/**
 * Replace the `id:` line inside the front-matter block. Returns `undefined` when
 * the file has no front-matter or no `id:` line.
 */
function renameId(text: string, newId: string): string | undefined {
  const match = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  if (!match) {
    return undefined;
  }
  const [whole, open, body, close] = match;
  if (!/^id:/m.test(body!)) {
    return undefined;
  }
  const renamed = body!.replace(/^id:[^\r\n]*/m, `id: ${newId}`);
  return open + renamed + close + text.slice(whole!.length);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export async function forkPrompt(
  options: PromptCommandOptions & { id: string; to?: string; as?: string },
): Promise<number> {
  const to = options.to ?? "user";
  if (to !== "user" && to !== "project") {
    options.err(`--to must be "user" or "project", got "${to}"`);
    return 1;
  }

  const library = await loadLibrary(options);
  const source = library.get(options.id);
  if (!source) {
    options.err(`Unknown prompt "${options.id}"`);
    return 1;
  }

  const newId = options.as ?? options.id;
  if (options.as !== undefined && options.as === options.id) {
    options.err(`--as must differ from "${options.id}"`);
    return 1;
  }
  if (!SEAT_ROLE_PATTERN.test(newId)) {
    options.err(`Prompt id "${newId}" must be kebab-case (e.g. security-reviewer)`);
    return 1;
  }

  const layerDir = promptLayerDirs(loadOptions(options)).find((dir) => dir.layer === to)!.dir;
  const target = path.join(layerDir, `${newId}.md`);

  const sourceText = await fs.readFile(source.file, "utf8");
  const text = options.as === undefined ? sourceText : renameId(sourceText, newId);
  if (text === undefined) {
    options.err(`Cannot rename "${options.id}": ${source.file} has no id: line in its front-matter`);
    return 1;
  }

  await fs.mkdir(layerDir, { recursive: true });
  try {
    // `wx` never replaces a file: an existing copy is kept as it is.
    await fs.writeFile(target, text, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      options.err(`Prompt "${newId}" already exists at ${target}`);
      return 1;
    }
    throw error;
  }

  // Reload, so a fork that cannot load is reported now. The file is kept either way.
  const reloaded = await loadLibrary(options);
  const failures = reloaded.errors.filter((error) => samePath(error.file, target));
  if (failures.length > 0) {
    for (const failure of failures) {
      options.err(`${failure.layer} ${failure.file}: ${failure.message}`);
    }
    options.err(`The forked prompt does not load. The file was kept at ${target} so you can fix it.`);
    return 1;
  }

  options.out(`Forked "${options.id}" to the ${to} layer as "${newId}": ${target}`);
  return 0;
}

/**
 * The editor for `prompts edit`: `VISUAL`, then `EDITOR`, then `notepad` on
 * Windows or `vi` elsewhere. The value is split on whitespace. Quotes are not
 * supported, so a path with spaces needs a wrapper script on the PATH.
 */
export function resolveEditor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const configured = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  if (configured) {
    const [command, ...args] = configured.split(/\s+/);
    return { command: command!, args };
  }
  return { command: platform === "win32" ? "notepad" : "vi", args: [] };
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Which copy `edit` opens: the project copy, else the user copy. Shared with the TUI. */
export type EditTarget =
  | { kind: "copy"; file: string; layer: PromptLayer }
  | { kind: "builtin-only" }
  | { kind: "missing" };

export function findEditTarget(library: PromptLibrary, id: string): EditTarget {
  const versions = library.versions(id);
  if (versions.length === 0) {
    return { kind: "missing" };
  }
  const copy =
    versions.find((version) => version.layer === "project") ??
    versions.find((version) => version.layer === "user");
  if (!copy) {
    return { kind: "builtin-only" };
  }
  return { kind: "copy", file: copy.file, layer: copy.layer };
}

/**
 * Open `file` in the configured editor and wait for it to exit, resolving with
 * its exit code. No shell: the editor and its arguments are passed as they are.
 * Rejects when the editor cannot start.
 */
export async function launchEditor(
  file: string,
  options: { spawn?: EditorSpawn; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<number> {
  const editor = resolveEditor(options.env ?? process.env, options.platform ?? process.platform);
  const spawn = options.spawn ?? spawnCliProcess;
  return waitForExit(spawn(editor.command, [...editor.args, file], { stdio: "inherit" }));
}

export async function editPrompt(
  options: PromptCommandOptions & {
    id: string;
    spawn?: EditorSpawn;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): Promise<number> {
  const library = await loadLibrary(options);
  const target = findEditTarget(library, options.id);
  if (target.kind === "missing") {
    options.err(`Unknown prompt "${options.id}"`);
    return 1;
  }
  if (target.kind === "builtin-only") {
    options.err(
      `Only the built-in prompt "${options.id}" exists. Run "assentor prompts fork ${options.id}" first, then edit the copy.`,
    );
    return 1;
  }

  try {
    return await launchEditor(target.file, {
      spawn: options.spawn,
      env: options.env,
      platform: options.platform,
    });
  } catch (error) {
    const editor = resolveEditor(options.env ?? process.env, options.platform ?? process.platform);
    options.err(
      `Could not start editor "${editor.command}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

export async function validatePrompts(options: PromptCommandOptions): Promise<number> {
  const library = await loadLibrary(options);
  if (library.errors.length === 0) {
    options.out(`All prompts valid (${library.list().length} loaded)`);
    return 0;
  }
  for (const error of library.errors) {
    options.out(`${error.layer} ${error.file}: ${error.message}`);
  }
  return 1;
}
