import type { RunMode } from "../../core/run-mode.js";
import type { TaskContract } from "../../core/task-contract.js";
import type { ProtocolMessage } from "#assentor/protocol/messages.js";

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
  /** Start a new CLI session instead of resuming the executor's last one (e.g. after a failed resume). */
  newSession?: boolean;
}

export interface ExecutorContinuation {
  taskId: string;
  projectPath: string;
  contract: TaskContract;
  messages: ProtocolMessage[];
  sessionId?: string;
  /** Imperative next-phase order from the reviewer/supervisor. */
  nextPhaseDirective?: string;
  /** Supervised is the default; Autopilot wraps anti-stall / next-phase prompts. */
  mode?: RunMode;
}

export interface ExecutorResult {
  status: "completed" | "needs_input" | "failed" | "cancelled" | "timeout";
  summary: string;
  sessionId?: string;
  messages?: ProtocolMessage[];
  rawOutput?: string;
  error?: string;
  /** With `cancelled`: `interrupt()` stopped this turn; the caller may restart it. */
  interrupted?: boolean;
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
  /**
   * Model for the next invocation (`AUTO` = CLI default). A process already
   * running keeps its model. Absent when the adapter cannot switch models.
   */
  setModel?(model: string): void;
  /**
   * Stop only the turn in flight: kill this executor's process tree and resolve
   * that turn as `cancelled` with `interrupted: true`. Unlike `cancel`, later
   * turns still run. Returns false (and does nothing) when no turn is in flight
   * or it is already being stopped.
   */
  interrupt?(): boolean;
}
