import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
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
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, command);
    try {
      accessSync(full, fsConstants.X_OK);
      return full;
    } catch {
      // continue
    }
  }
  return undefined;
}

export abstract class CliExecutorAdapter implements ExecutorAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly binaryNames: string[];

  capabilities(): ExecutorCapabilities {
    return {
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: false,
      supportsScreenshots: false,
    };
  }

  async detect(): Promise<DetectionResult> {
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
      error: `Not found on PATH (tried: ${this.binaryNames.join(", ")})`,
    };
  }

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    return this.execute(task);
  }

  async execute(task: ExecutorTask): Promise<ExecutorResult> {
    return this.runUnsupported(task.taskId);
  }

  async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
    return this.runUnsupported(input.taskId);
  }

  async cancel(_taskId: string): Promise<void> {
    // no-op by default
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
