import { promises as fs } from "node:fs";
import path from "node:path";
import { ASSENTOR_DIR } from "../persistence/paths.js";

export type AuditEventType =
  | "provider.changed"
  | "model.changed"
  | "key.changed"
  | "key.checked"
  | "routing.decision"
  | "reviewer.decision"
  | "executor.changed"
  | "fallback"
  | "failure"
  | "retry"
  | "budget"
  | "agent.created"
  | "agent.updated";

export interface AuditEvent {
  type: AuditEventType;
  at: string;
  message: string;
  data?: Record<string, unknown>;
}

export class AuditLog {
  private readonly filePath: string;

  constructor(projectPath: string) {
    this.filePath = path.join(
      path.resolve(projectPath),
      ASSENTOR_DIR,
      "audit.jsonl",
    );
  }

  async append(
    type: AuditEventType,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const event: AuditEvent = {
      type,
      at: new Date().toISOString(),
      message,
      data,
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async list(limit = 200): Promise<AuditEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEvent)
        .slice(-limit);
    } catch {
      return [];
    }
  }
}
