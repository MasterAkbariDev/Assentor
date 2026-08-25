import { createId } from "../../../core/ids.js";
import { MessageType, type ProtocolMessage } from "../../../protocol/messages.js";
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorContinuation,
  ExecutorResult,
  ExecutorTask,
} from "../types.js";

export type MockExecutorStep =
  | {
      type: "complete";
      summary?: string;
      rawOutput?: string;
      messages?: ProtocolMessage[];
    }
  | {
      type: "fail";
      error: string;
    }
  | {
      type: "timeout";
      error?: string;
    }
  | {
      type: "cancel";
    }
  | {
      type: "needs_input";
      summary?: string;
      messages?: ProtocolMessage[];
    };

export interface MockExecutorOptions {
  name?: string;
  /**
   * Scripted results consumed in order for run/continue calls.
   * When exhausted, defaults to a successful completion.
   */
  steps?: MockExecutorStep[];
  /**
   * If true, respond to EVIDENCE_REQUEST / INVESTIGATION_REQUEST with
   * a canned EVIDENCE_RESPONSE when no explicit step messages are provided.
   */
  autoRespondToEvidence?: boolean;
  delayMs?: number;
}

const DEFAULT_CAPABILITIES: ExecutorCapabilities = {
  canEditFiles: true,
  canRunCommands: true,
  canContinueSession: true,
  supportsScreenshots: false,
};

/**
 * Deterministic executor for orchestration tests (no real IDE/CLI).
 */
export class MockExecutor implements Executor {
  readonly name: string;
  private readonly steps: MockExecutorStep[];
  private stepIndex = 0;
  private readonly autoRespondToEvidence: boolean;
  private readonly delayMs: number;
  private readonly cancelled = new Set<string>();
  private sessionId = createId();
  callCount = 0;

  constructor(options: MockExecutorOptions = {}) {
    this.name = options.name ?? "mock";
    this.steps = [...(options.steps ?? [])];
    this.autoRespondToEvidence = options.autoRespondToEvidence ?? true;
    this.delayMs = options.delayMs ?? 0;
  }

  capabilities(): ExecutorCapabilities {
    return { ...DEFAULT_CAPABILITIES };
  }

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    return this.execute("run", task.taskId, task.messages ?? []);
  }

  async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
    if (input.sessionId) {
      this.sessionId = input.sessionId;
    }
    return this.execute("continue", input.taskId, input.messages);
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
  }

  remainingSteps(): number {
    return Math.max(0, this.steps.length - this.stepIndex);
  }

  private async execute(
    mode: "run" | "continue",
    taskId: string,
    messages: ProtocolMessage[],
  ): Promise<ExecutorResult> {
    this.callCount += 1;

    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    if (this.cancelled.has(taskId)) {
      return {
        status: "cancelled",
        summary: "Executor cancelled",
        sessionId: this.sessionId,
      };
    }

    const step = this.nextStep();
    if (step) {
      return this.fromStep(step, messages, mode);
    }

    return {
      status: "completed",
      summary:
        mode === "run"
          ? "Mock executor completed initial implementation"
          : "Mock executor applied follow-up changes",
      sessionId: this.sessionId,
      messages: this.autoRespondToEvidence
        ? this.maybeEvidenceResponse(messages)
        : undefined,
      rawOutput: `mock-executor:${mode}:default`,
    };
  }

  private nextStep(): MockExecutorStep | undefined {
    if (this.stepIndex >= this.steps.length) {
      return undefined;
    }
    const step = this.steps[this.stepIndex];
    this.stepIndex += 1;
    return step;
  }

  private fromStep(
    step: MockExecutorStep,
    inbound: ProtocolMessage[],
    mode: "run" | "continue",
  ): ExecutorResult {
    switch (step.type) {
      case "complete":
        return {
          status: "completed",
          summary:
            step.summary ??
            (mode === "run"
              ? "Mock executor completed initial implementation"
              : "Mock executor applied follow-up changes"),
          sessionId: this.sessionId,
          rawOutput: step.rawOutput ?? `mock-executor:${mode}:complete`,
          messages:
            step.messages ??
            (this.autoRespondToEvidence
              ? this.maybeEvidenceResponse(inbound)
              : undefined),
        };
      case "fail":
        return {
          status: "failed",
          summary: step.error,
          error: step.error,
          sessionId: this.sessionId,
        };
      case "timeout":
        return {
          status: "timeout",
          summary: step.error ?? "Mock executor timed out",
          error: step.error ?? "Mock executor timed out",
          sessionId: this.sessionId,
        };
      case "cancel":
        return {
          status: "cancelled",
          summary: "Mock executor cancelled",
          sessionId: this.sessionId,
        };
      case "needs_input":
        return {
          status: "needs_input",
          summary: step.summary ?? "Mock executor needs input",
          sessionId: this.sessionId,
          messages: step.messages,
        };
      default: {
        const _exhaustive: never = step;
        return _exhaustive;
      }
    }
  }

  private maybeEvidenceResponse(
    inbound: ProtocolMessage[],
  ): ProtocolMessage[] | undefined {
    const request = inbound.find(
      (message) =>
        message.type === MessageType.EvidenceRequest ||
        message.type === MessageType.InvestigationRequest ||
        message.type === MessageType.TestRequest ||
        message.type === MessageType.BuildRequest,
    );

    if (!request) {
      return undefined;
    }

    return [
      {
        messageId: createId(),
        conversationId: request.conversationId,
        round: request.round,
        from: "executor",
        to: "reviewer",
        type: MessageType.EvidenceResponse,
        requiresResponse: false,
        timestamp: new Date().toISOString(),
        content: {
          inReplyTo: request.messageId,
          notes: "Mock evidence response",
          artifacts: [
            {
              kind: "file",
              path: "src/mock.ts",
              content: "// mock evidence\nexport const ok = true;\n",
              description: "Synthetic evidence from MockExecutor",
            },
          ],
        },
      },
    ];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
