import type {
  Executor,
  ExecutorCapabilities,
  ExecutorContinuation,
  ExecutorResult,
  ExecutorTask,
} from "./types.js";
import { ensureAssentorGitignored } from "../../persistence/paths.js";

/**
 * Wrap any executor so the project `.gitignore` ignores `.assentor/`
 * before run/continue. Failures to update gitignore never block execution.
 */
export function withAssentorGitignore(executor: Executor): Executor {
  return {
    get name() {
      return executor.name;
    },
    capabilities(): ExecutorCapabilities {
      return executor.capabilities();
    },
    async run(task: ExecutorTask): Promise<ExecutorResult> {
      await ensureAssentorGitignored(task.projectPath);
      return executor.run(task);
    },
    async continue(input: ExecutorContinuation): Promise<ExecutorResult> {
      await ensureAssentorGitignored(input.projectPath);
      return executor.continue(input);
    },
    cancel(taskId: string): Promise<void> {
      return executor.cancel(taskId);
    },
  };
}
