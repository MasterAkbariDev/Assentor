import { accessSync, constants as fsConstants } from "node:fs";
import {
  findOnPath as findOnPathSmart,
  locateBinary,
  type BinaryTool,
} from "./cli-locator.js";
import { PrintCliExecutor } from "../providers/executors/cli-print/index.js";
import { PRINT_CLI_RECIPES } from "../providers/executors/cli-print/recipes.js";
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorContinuation,
  ExecutorResult,
  ExecutorTask,
} from "../providers/executors/types.js";

export interface DetectionResult {
  installed: boolean;
  available: boolean;
  path?: string;
  version?: string;
  authenticated?: boolean;
  error?: string;
  capabilities?: ExecutorCapabilities;
}

export interface InstallPlan {
  application: string;
  command: string;
  source: string;
  notes?: string;
  automatic: boolean;
}

export interface ExecutorAdapter extends Executor {
  readonly id: string;
  detect(): Promise<DetectionResult>;
  installPlan?(): InstallPlan;
  verify?(): Promise<DetectionResult>;
}

export class ExecutorRegistry {
  private readonly adapters = new Map<string, ExecutorAdapter>();

  register(adapter: ExecutorAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ExecutorAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ExecutorAdapter[] {
    return [...this.adapters.values()];
  }

  async detectAll(): Promise<Array<{ id: string; name: string; detection: DetectionResult }>> {
    const results = [];
    for (const adapter of this.adapters.values()) {
      results.push({
        id: adapter.id,
        name: adapter.name,
        detection: await adapter.detect(),
      });
    }
    return results;
  }
}

export function findOnPath(command: string): string | undefined {
  return findOnPathSmart(command);
}

export interface CliExecutorOptions {
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  onStatus?: (status: { activity: string; detail: string }) => void;
  timeoutMs?: number;
}

export abstract class CliExecutorAdapter implements ExecutorAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly binaryNames: string[];
  /** When set, detection uses PATH + well-known install locations. */
  readonly binaryTool?: BinaryTool;
  private inner?: PrintCliExecutor;

  constructor(protected readonly options: CliExecutorOptions = {}) {}

  capabilities(): ExecutorCapabilities {
    return {
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: Boolean(PRINT_CLI_RECIPES[this.id]?.resumeFlag),
      supportsScreenshots: false,
    };
  }

  async detect(): Promise<DetectionResult> {
    if (this.binaryTool) {
      const resolved = locateBinary(this.binaryTool);
      if (resolved) {
        return {
          installed: true,
          available: true,
          path: resolved,
          version: "cli",
          capabilities: this.capabilities(),
        };
      }
    }
    for (const bin of this.binaryNames) {
      const resolved =
        bin.includes("/") || bin.includes("\\")
          ? (tryAccess(bin) ? bin : undefined)
          : findOnPath(bin);
      if (resolved) {
        return {
          installed: true,
          available: true,
          path: resolved,
          version: "unknown",
          capabilities: this.capabilities(),
        };
      }
    }
    return {
      installed: false,
      available: false,
      error: `Not found on PATH or default install locations (tried: ${this.binaryNames.join(", ")})`,
    };
  }

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    return this.execute(task);
  }

  async execute(task: ExecutorTask): Promise<ExecutorResult> {
    const inner = this.getInner();
    if (!inner) {
      return this.runUnsupported(task.taskId);
    }
    return inner.run(task);
  }

  async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
    const inner = this.getInner();
    if (!inner) {
      return this.runUnsupported(input.taskId);
    }
    return inner.continue(input);
  }

  async cancel(taskId: string): Promise<void> {
    await this.inner?.cancel(taskId);
  }

  private getInner(): PrintCliExecutor | undefined {
    if (this.inner) {
      return this.inner;
    }
    const recipe = PRINT_CLI_RECIPES[this.id];
    if (!recipe) {
      return undefined;
    }
    this.inner = new PrintCliExecutor({
      recipe,
      timeoutMs: this.options.timeoutMs,
      onOutput: this.options.onOutput,
      onStatus: this.options.onStatus,
    });
    return this.inner;
  }

  protected runUnsupported(taskId: string): ExecutorResult {
    return {
      status: "failed",
      summary: `${this.name} adapter detected but headless execute is not fully wired yet`,
      error: `${this.id} execute not implemented for task ${taskId}`,
    };
  }
}

function tryAccess(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
