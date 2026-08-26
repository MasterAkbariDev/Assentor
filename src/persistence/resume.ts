import {
  isRetryableState,
  type TaskState,
} from "../orchestrator/state-machine.js";
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
 * Resolve a full or prefix task id under `.assentor/tasks/`.
 */
export async function resolveTaskId(
  projectPath: string,
  query: string,
): Promise<string> {
  const trimmed = query.trim();
  const ids = await TaskStore.list(projectPath);
  if (ids.includes(trimmed)) {
    return trimmed;
  }
  const matches = ids.filter(
    (id) => id.startsWith(trimmed) || id.replace(/-/g, "").startsWith(trimmed),
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new ResumeError(
      `Ambiguous task id "${trimmed}". Matches: ${matches.join(", ")}`,
    );
  }
  throw new ResumeError(`Task not found: ${trimmed}`);
}

/**
 * Loads a persisted task for `assentor resume`.
 * Successful/cancelled/budget tasks stay closed; timeout/auth/fail can retry.
 */
export async function loadTaskForResume(
  projectPath: string,
  taskId: string,
): Promise<ResumeInfo> {
  const resolved = await resolveTaskId(projectPath, taskId);
  const store = await TaskStore.open(projectPath, resolved);
  const snapshot = await store.loadSnapshot();
  const status = snapshot.status as TaskState;

  if (!isRetryableState(status)) {
    return {
      store,
      snapshot,
      resumable: false,
      reason: `Task ${resolved} cannot be resumed (${status}). Start a new task, or pick a failed/timed-out/in-progress id.`,
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
