import { readFileSync } from "node:fs";
import path from "node:path";
import { locateBinary, type BinaryTool } from "../executors/cli-locator.js";
import type { SeatCliProvider, SeatProvider } from "../core/seats.js";
import { userAssentorDir } from "../config/paths.js";
import { writeJsonAtomic } from "../persistence/paths.js";
import { runShellCommand } from "../process/run-shell.js";
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

/** Meaning: the CLI's own default model. Always the first entry for a provider. */
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
const DISCOVERY_TIMEOUT_MS = 15_000;

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

/** Split `id<TAB>label` or `id - label` at the first TAB, else the first " - ". */
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

type RunShell = (
  command: string,
  cwd: string,
  options: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface CliModelCatalogOptions {
  /** Defaults to `<userAssentorDir>/models-cache.json`. */
  cachePath?: string;
  /** Injectable shell runner; tests never spawn. */
  run?: RunShell;
  /** Injectable binary locator; defaults to `locateBinary`. */
  locate?: (tool: BinaryTool) => string | undefined;
}

interface CatalogCache {
  discovered: Partial<Record<SeatProvider, DiscoveredModel[]>>;
  user: Partial<Record<SeatProvider, DiscoveredModel[]>>;
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
  private readonly run: RunShell;
  private readonly locate: (tool: BinaryTool) => string | undefined;
  private state: CatalogCache;

  constructor(options: CliModelCatalogOptions = {}) {
    this.cachePath =
      options.cachePath ?? path.join(userAssentorDir(), "models-cache.json");
    this.run = options.run ?? runShellCommand;
    this.locate = options.locate ?? ((tool) => locateBinary(tool));
    this.state = readCache(this.cachePath);
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
    const tool = DISCOVERY_TOOL[provider];
    if (!tool) {
      return { entries: [], error: `${provider} has no model discovery command` };
    }
    const binary = this.locate(tool);
    if (!binary) {
      return { entries: [], error: `${provider} CLI not found; cannot discover models` };
    }

    const command = discoveryCommand(provider, binary);
    const result = await this.run(command, process.cwd(), {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
      return { entries: [], error: `${command} failed: ${detail}` };
    }

    const models = parseDiscoveryOutput(result.stdout);
    if (models.length === 0) {
      return { entries: [], error: `${command} produced no model ids` };
    }

    this.state = {
      ...this.state,
      discovered: { ...this.state.discovered, [provider]: models },
    };
    await writeJsonAtomic(this.cachePath, this.state);
    return {
      entries: models.map((model) => ({
        provider,
        id: model.id,
        label: model.label,
        source: "discovered" as const,
      })),
    };
  }

  /** Add or relabel a user model. Rejects invalid ids and `AUTO`. */
  async addUserModel(provider: SeatProvider, id: string, label?: string): Promise<void> {
    assertUserModelId(id);
    const current = this.state.user[provider] ?? [];
    const next = [
      ...current.filter((model) => model.id !== id),
      { id, label: label?.trim() || id },
    ];
    this.state = { ...this.state, user: { ...this.state.user, [provider]: next } };
    await writeJsonAtomic(this.cachePath, this.state);
  }

  async removeUserModel(provider: SeatProvider, id: string): Promise<void> {
    const current = this.state.user[provider] ?? [];
    const next = current.filter((model) => model.id !== id);
    this.state = { ...this.state, user: { ...this.state.user, [provider]: next } };
    await writeJsonAtomic(this.cachePath, this.state);
  }
}

function seedFor(provider: SeatProvider): DiscoveredModel[] {
  return (SEED_MODELS as Partial<Record<SeatProvider, DiscoveredModel[]>>)[provider] ?? [];
}

function discoveryCommand(provider: SeatProvider, binary: string): string {
  if (provider === "cursor") {
    return isCursorAppBinary(binary)
      ? `"${binary}" agent --list-models`
      : `"${binary}" --list-models`;
  }
  return `"${binary}" models`;
}

function assertUserModelId(id: string): void {
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid model id: ${id}`);
  }
  if (id.toUpperCase() === AUTO_MODEL_ID) {
    throw new Error(`"${AUTO_MODEL_ID}" is reserved for the CLI default`);
  }
}

function readCache(cachePath: string): CatalogCache {
  const empty: CatalogCache = { discovered: {}, user: {} };
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<CatalogCache>;
    return {
      discovered: parsed.discovered ?? {},
      user: parsed.user ?? {},
    };
  } catch {
    return empty;
  }
}
