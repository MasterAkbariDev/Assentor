import { isTerminalState, type TaskState } from "../orchestrator/state-machine.js";
import type { TaskSnapshot } from "./store.js";
import { TaskStore } from "./store.js";

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export interface ResumeInfo {
  store: TaskStore;
  snapshot: TaskSnapshot;
  resumable: boolean;
  reason?: string;
}

/**
 * Loads a persisted task for `assentor resume`.
 * Terminal tasks are reported as not resumable.
 */
export async function loadTaskForResume(
  projectPath: string,
  taskId: string,
): Promise<ResumeInfo> {
  const store = await TaskStore.open(projectPath, taskId);
  const snapshot = await store.loadSnapshot();
  const status = snapshot.status as TaskState;

  if (isTerminalState(status)) {
    return {
      store,
      snapshot,
      resumable: false,
      reason: `Task ${taskId} is already terminal (${status})`,
    };
  }

  return {
    store,
    snapshot,
    resumable: true,
  };
}

/**
 * Finds the most recently updated non-terminal task, if any.
 */
export async function findLatestResumableTask(
  projectPath: string,
): Promise<ResumeInfo | undefined> {
  const ids = await TaskStore.list(projectPath);
  let best: ResumeInfo | undefined;

  for (const taskId of ids) {
    const info = await loadTaskForResume(projectPath, taskId);
    if (!info.resumable) {
      continue;
    }
    if (
      !best ||
      Date.parse(info.snapshot.updatedAt) > Date.parse(best.snapshot.updatedAt)
    ) {
      best = info;
    }
  }

  return best;
}
