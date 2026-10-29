import type { ChildProcess } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  locateBinary,
  spawnCliProcess,
  type BinaryTool,
} from "../executors/cli-locator.js";
import { SEAT_PROVIDERS, type SeatCliProvider, type SeatProvider } from "../core/seats.js";
import { userAssentorDir } from "../config/paths.js";
import { writeJsonAtomic } from "../persistence/paths.js";
import { killProcessTree } from "../process/kill-tree.js";
import { trackChildProcess, untrackChildProcess } from "../process/tracker.js";
import { isCursorAppBinary } from "../providers/executors/cursor/index.js";

export interface CatalogEntry {
  provider: SeatProvider;
  id: string;
  label: string;
  source: "seed" | "discovered" | "user";
}

export interface DiscoveredModel {
  id: string;
  label: string;
}

/** The CLI's own default model. Always the first entry for a provider. */
export const AUTO_MODEL_ID = "AUTO";
const AUTO_LABEL = "Auto (CLI default)";

/**
 * Seed models per CLI. Only documented, stable aliases belong here.
 * Do not invent model ids: every other CLI starts empty and relies on
 * discovery or user-added models.
 */
export const SEED_MODELS: Record<SeatCliProvider, DiscoveredModel[]> = {
  "claude-code": [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [],
  antigravity: [],
  cursor: [],
  qwen: [],
  opencode: [],
};

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;

/** A model id safe to pass as one CLI argument: starts alphanumeric, so never a flag. */
export function isModelId(id: string): boolean {
  return MODEL_ID_PATTERN.test(id);
}
const DISCOVERY_TIMEOUT_MS = 15_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
/** A binary path with any of these is refused before spawning. Paths with spaces are fine. */
const UNSAFE_PATH_CHARS = /["`$%^&|<>!\r\n]/;

/** Parse one model id per line from a discovery command's stdout. See T01-01. */
export function parseDiscoveryOutput(output: string): DiscoveredModel[] {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const anySeparator = lines.some((line) => line.includes("\t") || line.includes(" - "));
  const found: DiscoveredModel[] = [];

  for (const line of lines) {
    if (anySeparator) {
      const split = splitModelLine(line);
      if (split) {
        found.push(split);
      }
      continue;
    }
    // Plain one-id-per-line output: only when no line had a separator at all.
    if (MODEL_ID_PATTERN.test(line.trim())) {
      found.push({ id: line.trim(), label: line.trim() });
    }
  }

  const seen = new Set<string>();
  const result: DiscoveredModel[] = [];
  for (const model of found) {
    if (!MODEL_ID_PATTERN.test(model.id)) continue;
    if (model.id.toLowerCase() === AUTO_MODEL_ID.toLowerCase()) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

/** Split at the first TAB if the line has one, else at the first " - ". */
function splitModelLine(line: string): DiscoveredModel | undefined {
  const tab = line.indexOf("\t");
  let idPart: string;
  let labelPart: string;
  if (tab !== -1) {
    idPart = line.slice(0, tab);
    labelPart = line.slice(tab + 1);
  } else {
    const dash = line.indexOf(" - ");
    if (dash === -1) return undefined;
    idPart = line.slice(0, dash);
    labelPart = line.slice(dash + 3);
  }
  const id = idPart.trim();
  return { id, label: labelPart.trim() || id };
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed or failed to start. */
  code: number | null;
  timedOut: boolean;
}

/** Runs a CLI binary with an args array. Never goes through a shell. */
export type RunCli = (
  binary: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CliRunResult>;

/**
 * Spawn without a shell, collect output (each stream capped at 1 MB), and kill
 * the process tree on timeout.
 */
function defaultRunCli(
  binary: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // spawn can throw synchronously (e.g. a NUL byte in an argument); report it, don't reject.
    let child: ChildProcess;
    try {
      child = trackChildProcess(
        spawnCliProcess(binary, args, {
          cwd: options.cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
      );
    } catch (error) {
      resolve({ stdout: "", stderr: (error as Error).message, code: null, timedOut: false });
      return;
    }

    const finish = (code: number | null, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      untrackChildProcess(child);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr:
          extraStderr ?? Buffer.concat(stderrChunks).toString("utf8"),
        code,
        timedOut,
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      finish(null);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes < OUTPUT_CAP_BYTES) {
        const kept = chunk.subarray(0, OUTPUT_CAP_BYTES - stdoutBytes);
        stdoutChunks.push(kept);
        stdoutBytes += kept.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes < OUTPUT_CAP_BYTES) {
        const kept = chunk.subarray(0, OUTPUT_CAP_BYTES - stderrBytes);
        stderrChunks.push(kept);
        stderrBytes += kept.length;
      }
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

export interface CliModelCatalogOptions {
  /** Defaults to `<userAssentorDir>/models-cache.json`. */
  cachePath?: string;
  /** Injectable process runner; tests never spawn. */
  run?: RunCli;
  /** Injectable binary locator; defaults to `locateBinary`. */
  locate?: (tool: BinaryTool) => string | undefined;
  /**
   * Never writes: a corrupt cache is read as empty and left alone (no backup),
   * and every write method, including `discover`, throws "read-only catalog".
   */
  readOnly?: boolean;
}

type ModelRecord = Partial<Record<SeatProvider, DiscoveredModel[]>>;

interface CatalogCache {
  discovered: ModelRecord;
  user: ModelRecord;
}

const DISCOVERY_TOOL: Partial<Record<SeatProvider, BinaryTool>> = {
  antigravity: "agy",
  cursor: "cursor",
};

/**
 * Model choices per CLI provider: seed ∪ discovered ∪ user.
 * `discover` runs a read-only list command; failures keep the previous cache.
 */
export class CliModelCatalog {
  private readonly cachePath: string;
  private readonly run: RunCli;
  private readonly locate: (tool: BinaryTool) => string | undefined;
  private state: CatalogCache;
  /** False when a corrupt cache could not be backed up, so it must not be overwritten. */
  private readonly writable: boolean;
  private readonly readOnly: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: CliModelCatalogOptions = {}) {
    this.cachePath =
      options.cachePath ?? path.join(userAssentorDir(), "models-cache.json");
    this.run = options.run ?? defaultRunCli;
    this.locate = options.locate ?? ((tool) => locateBinary(tool));
    this.readOnly = options.readOnly ?? false;
    const loaded = loadCache(this.cachePath, this.readOnly);
    this.state = loaded.state;
    this.writable = loaded.writable;
  }

  /** Seed ∪ discovered ∪ user, de-duplicated by id. User beats discovered beats seed for the label. */
  list(provider: SeatProvider): CatalogEntry[] {
    const byId = new Map<string, CatalogEntry>();
    const add = (models: DiscoveredModel[] | undefined, source: CatalogEntry["source"]) => {
      for (const model of models ?? []) {
        byId.set(model.id, { provider, id: model.id, label: model.label, source });
      }
    };
    add(seedFor(provider), "seed");
    add(this.state.discovered[provider], "discovered");
    add(this.state.user[provider], "user");

    return [
      { provider, id: AUTO_MODEL_ID, label: AUTO_LABEL, source: "seed" },
      ...byId.values(),
    ];
  }

  /**
   * Run the CLI's list command and cache the result. On any failure returns an
   * `error` and leaves the cache as it was.
   */
  async discover(
    provider: SeatProvider,
  ): Promise<{ entries: CatalogEntry[]; error?: string }> {
    if (this.readOnly) {
      throw readOnlyError();
    }
    const tool = DISCOVERY_TOOL[provider];
    if (!tool) {
      return { entries: [], error: `${provider} has no model discovery command` };
    }
    const binary = this.locate(tool);
    if (!binary) {
      return { entries: [], error: `${provider} CLI not found; cannot discover models` };
    }
    if (UNSAFE_PATH_CHARS.test(binary)) {
      return { entries: [], error: "binary path contains unsafe characters" };
    }

    const args = discoveryArgs(provider, binary);
    const label = `${provider} model discovery`;
    const result = await this.run(binary, args, {
      cwd: process.cwd(),
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    if (result.timedOut) {
      return { entries: [], error: `${label} timed out after ${DISCOVERY_TIMEOUT_MS} ms` };
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
      return { entries: [], error: `${label} failed: ${detail}` };
    }

    const models = parseDiscoveryOutput(result.stdout);
    if (models.length === 0) {
      return { entries: [], error: `${label} produced no model ids` };
    }

    const entries = models.map((model) => ({
      provider,
      id: model.id,
      label: model.label,
      source: "discovered" as const,
    }));
    // A failed save keeps the models in memory and says so; nothing is rolled back here.
    return this.enqueue(async () => {
      this.state = {
        ...this.state,
        discovered: { ...this.state.discovered, [provider]: models },
      };
      try {
        await this.writeNow();
        return { entries };
      } catch (error) {
        return {
          entries,
          error: `${label} succeeded but the cache could not be saved: ${(error as Error).message}`,
        };
      }
    });
  }

  /** Add or relabel a user model. Rejects invalid ids and `AUTO`. A failed save changes nothing. */
  async addUserModel(provider: SeatProvider, id: string, label?: string): Promise<void> {
    assertUserModelId(id);
    return this.mutate((state) => {
      const current = state.user[provider] ?? [];
      const next = [
        ...current.filter((model) => model.id !== id),
        { id, label: label?.trim() || id },
      ];
      return { ...state, user: { ...state.user, [provider]: next } };
    });
  }

  /** Remove a user model. A failed save changes nothing. */
  async removeUserModel(provider: SeatProvider, id: string): Promise<void> {
    return this.mutate((state) => {
      const current = state.user[provider] ?? [];
      const next = current.filter((model) => model.id !== id);
      return { ...state, user: { ...state.user, [provider]: next } };
    });
  }

  /** Apply a change and save it. If the save fails, the in-memory state is restored and the error rethrown. */
  private mutate(change: (state: CatalogCache) => CatalogCache): Promise<void> {
    if (this.readOnly) {
      return Promise.reject(readOnlyError());
    }
    return this.enqueue(async () => {
      const previous = this.state;
      this.state = change(previous);
      try {
        await this.writeNow();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
  }

  /** Every state change and save runs one at a time, in call order. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Save the current state. Refuses when a corrupt cache could not be backed up. */
  private writeNow(): Promise<void> {
    if (this.readOnly) {
      return Promise.reject(readOnlyError());
    }
    if (!this.writable) {
      return Promise.reject(
        new Error(
          `refusing to overwrite ${this.cachePath}: the corrupt cache could not be backed up`,
        ),
      );
    }
    return writeJsonAtomic(this.cachePath, this.state);
  }
}

function seedFor(provider: SeatProvider): DiscoveredModel[] {
  return (SEED_MODELS as Partial<Record<SeatProvider, DiscoveredModel[]>>)[provider] ?? [];
}

/** Fixed argument lists per provider. No user text is ever placed in them. */
function discoveryArgs(provider: SeatProvider, binary: string): string[] {
  if (provider === "cursor") {
    return isCursorAppBinary(binary) ? ["agent", "--list-models"] : ["--list-models"];
  }
  return ["models"];
}

function assertUserModelId(id: string): void {
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid model id: ${id}`);
  }
  if (id.toUpperCase() === AUTO_MODEL_ID) {
    throw new Error(`"${AUTO_MODEL_ID}" is reserved for the CLI default`);
  }
}

function readOnlyError(): Error {
  return new Error("read-only catalog");
}

function emptyCache(): CatalogCache {
  return { discovered: {}, user: {} };
}

/**
 * Read the cache. A missing file is empty. A file that cannot be read or parsed,
 * or whose top-level shape is wrong, is backed up (best effort) and treated as
 * empty. Individual invalid entries are dropped.
 */
function loadCache(
  cachePath: string,
  readOnly: boolean,
): { state: CatalogCache; writable: boolean } {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: emptyCache(), writable: true };
    }
    return backupCorrupt(cachePath, readOnly);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return backupCorrupt(cachePath, readOnly);
  }
  if (!isPlainObject(parsed)) {
    return backupCorrupt(cachePath, readOnly);
  }
  if (
    (parsed.discovered !== undefined && !isPlainObject(parsed.discovered)) ||
    (parsed.user !== undefined && !isPlainObject(parsed.user))
  ) {
    return backupCorrupt(cachePath, readOnly);
  }
  return {
    state: {
      discovered: sanitizeRecord(parsed.discovered),
      user: sanitizeRecord(parsed.user),
    },
    writable: true,
  };
}

function backupCorrupt(
  cachePath: string,
  readOnly: boolean,
): { state: CatalogCache; writable: boolean } {
  if (readOnly) {
    // A read-only catalog never creates files, so the corrupt cache is only ignored.
    return { state: emptyCache(), writable: false };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    copyFileSync(cachePath, `${cachePath}.corrupt-${stamp}`);
    return { state: emptyCache(), writable: true };
  } catch {
    return { state: emptyCache(), writable: false };
  }
}

const KNOWN_PROVIDERS = new Set<string>(SEAT_PROVIDERS);

function sanitizeRecord(value: unknown): ModelRecord {
  const out: ModelRecord = {};
  if (!isPlainObject(value)) {
    return out;
  }
  for (const [provider, models] of Object.entries(value)) {
    if (!KNOWN_PROVIDERS.has(provider) || !Array.isArray(models)) {
      continue;
    }
    out[provider as SeatProvider] = models.filter(isModelEntry);
  }
  return out;
}

function isModelEntry(value: unknown): value is DiscoveredModel {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    MODEL_ID_PATTERN.test(value.id) &&
    value.id.toUpperCase() !== AUTO_MODEL_ID
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
