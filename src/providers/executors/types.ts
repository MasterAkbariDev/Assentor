import type { TaskContract } from "../../core/task-contract.js";
import type { ProtocolMessage } from "../../protocol/messages.js";

export interface ExecutorCapabilities {
  canEditFiles: boolean;
  canRunCommands: boolean;
  canContinueSession: boolean;
  supportsScreenshots: boolean;
}

export interface ExecutorTask {
  taskId: string;
  projectPath: string;
  contract: TaskContract;
  prompt: string;
  messages?: ProtocolMessage[];
}

export interface ExecutorContinuation {
  taskId: string;
  projectPath: string;
  contract: TaskContract;
  messages: ProtocolMessage[];
  sessionId?: string;
}

export interface ExecutorResult {
  status: "completed" | "needs_input" | "failed" | "cancelled" | "timeout";
  summary: string;
  sessionId?: string;
  messages?: ProtocolMessage[];
  rawOutput?: string;
  error?: string;
}

/**
 * Provider-independent executor adapter.
 * Implementations live under src/providers/executors/<provider>/.
 */
export interface Executor {
  readonly name: string;
  capabilities(): ExecutorCapabilities;
  run(task: ExecutorTask): Promise<ExecutorResult>;
  continue(input: ExecutorContinuation): Promise<ExecutorResult>;
  cancel(taskId: string): Promise<void>;
}
