import { promises as fs } from "node:fs";
import path from "node:path";
import { createId } from "../../../core/ids.js";
import type { ProtocolMessage } from "../../../protocol/messages.js";
import { MessageType } from "../../../protocol/messages.js";
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorContinuation,
  ExecutorResult,
  ExecutorTask,
} from "../types.js";

export type ProjectMutationFn = (input: {
  projectPath: string;
  mode: "run" | "continue";
  messages: ProtocolMessage[];
  call: number;
}) => Promise<{ summary: string; rawOutput?: string }>;

export interface ProjectMutatingExecutorOptions {
  name?: string;
  mutate: ProjectMutationFn;
}

/**
 * Test/E2E executor that mutates a real project directory with a provided callback.
 * Not a production coding agent — used to validate Assentor orchestration end-to-end.
 */
export class ProjectMutatingExecutor implements Executor {
  readonly name: string;
  private readonly mutate: ProjectMutationFn;
  private sessionId = createId();
  callCount = 0;

  constructor(options: ProjectMutatingExecutorOptions) {
    this.name = options.name ?? "project-mutating";
    this.mutate = options.mutate;
  }

  capabilities(): ExecutorCapabilities {
    return {
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: true,
      supportsScreenshots: false,
    };
  }

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    return this.execute("run", task.projectPath, task.messages ?? []);
  }

  async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
    if (input.sessionId) {
      this.sessionId = input.sessionId;
    }
    return this.execute("continue", input.projectPath, input.messages);
  }

  async cancel(): Promise<void> {}

  private async execute(
    mode: "run" | "continue",
    projectPath: string,
    messages: ProtocolMessage[],
  ): Promise<ExecutorResult> {
    this.callCount += 1;
    try {
      const result = await this.mutate({
        projectPath,
        mode,
        messages,
        call: this.callCount,
      });

      const evidenceRequest = messages.find(
        (message) =>
          message.type === MessageType.EvidenceRequest ||
          message.type === MessageType.InvestigationRequest,
      );

      return {
        status: "completed",
        summary: result.summary,
        rawOutput: result.rawOutput,
        sessionId: this.sessionId,
        messages: evidenceRequest
          ? [
              {
                messageId: createId(),
                conversationId: evidenceRequest.conversationId,
                round: evidenceRequest.round,
                from: "executor",
                to: "reviewer",
                type: MessageType.EvidenceResponse,
                requiresResponse: false,
                timestamp: new Date().toISOString(),
                content: {
                  inReplyTo: evidenceRequest.messageId,
                  notes: "Project files updated; see artifacts.",
                  artifacts: [
                    {
                      kind: "file",
                      path: "src/average.ts",
                      description: "Updated implementation",
                    },
                  ],
                },
              },
            ]
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        summary: message,
        error: message,
        sessionId: this.sessionId,
      };
    }
  }
}

export async function writeProjectFiles(
  projectPath: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(projectPath, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}
