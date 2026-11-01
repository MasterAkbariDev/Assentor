import { createProtocolMessage, MessageType } from "#assentor/protocol/index.js";
import type { Executor, ExecutorResult, ExecutorTask } from "./types.js";

/**
 * A follow-up turn on the same seat (TE-05), e.g. a fix attempt after failed
 * checks. When the executor can continue its CLI session and the previous turn
 * completed in one, only `followUp` is sent into that session: it already holds
 * the task, and the provider serves that prefix from its cache. Otherwise a
 * fresh run with the full `task.prompt` (which must already contain the follow-up),
 * also once when the continue fails (e.g. the session expired) — in a new session.
 * The follow-up travels as quoted data (a warning), never as a supervisor directive.
 */
export async function runFollowUp(executor: Executor, task: ExecutorTask, previous: ExecutorResult | undefined, followUp: string): Promise<ExecutorResult> {
  if (previous?.status !== "completed" || !previous.sessionId || !executor.capabilities().canContinueSession) {
    return executor.run(task);
  }
  const continued = await executor.continue({
    taskId: task.taskId,
    projectPath: task.projectPath,
    contract: task.contract,
    sessionId: previous.sessionId,
    messages: [
      createProtocolMessage({
        conversationId: task.taskId,
        round: 1,
        from: "supervisor",
        to: "executor",
        type: MessageType.Warning,
        content: { message: followUp, code: "follow_up" },
      }),
    ],
  });
  if (continued.status !== "failed") return continued; // cancelled, timeout and interrupts end the turn as before
  return executor.run({ ...task, newSession: true });
}
