import { promises as fs } from "node:fs";
import { z } from "zod";
import { TaskContractSchema, type TaskContract } from "../core/task-contract.js";
import type { Budgets } from "../core/types.js";
import type { GitCheckpoint } from "../git/types.js";
import { TaskState } from "../orchestrator/state-machine.js";
import type { SupervisorEvent } from "../orchestrator/supervisor.js";
import type { ProtocolMessage } from "../protocol/messages.js";
import {
  PhaseProgressSchema,
  type PhaseProgress,
  type ReviewResult,
} from "../protocol/review-result.js";
import {
  appendJsonl,
  ensureTaskLayout,
  listTaskIds,
  readJsonFile,
  readJsonl,
  taskPaths,
  writeJsonAtomic,
  removeTaskDir,
  type TaskPaths,
} from "./paths.js";

const TaskStateSchema = z.string().min(1);

export const PersistedBudgetsSchema = z.object({
  limits: z.object({
    maxRounds: z.number().int().positive(),
    maxMessages: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxRuntimeMs: z.number().int().positive(),
  }),
  usage: z.object({
    rounds: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    runtimeMs: z.number().int().nonnegative(),
  }),
});

export const GitCheckpointSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  statusPorcelain: z.string(),
  stashRef: z.string().optional(),
});

export const TaskSnapshotSchema = z.object({
  taskId: z.string().min(1),
  conversationId: z.string().min(1),
  projectPath: z.string().min(1),
  status: TaskStateSchema,
  /** Optional FSM schema version; unknown future states normalize on resume. */
  fsmVersion: z.number().int().positive().optional(),
  currentRound: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  executor: z.string().min(1),
  reviewers: z.array(z.string()),
  contract: TaskContractSchema,
  budgets: PersistedBudgetsSchema,
  executorSessionId: z.string().optional(),
  lastCheckpoint: GitCheckpointSchema.optional(),
  phaseProgress: PhaseProgressSchema.optional(),
  finalReview: z.unknown().optional(),
  reason: z.string().optional(),
  startedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  communicationCount: z.number().int().nonnegative().default(0),
});

export type TaskSnapshot = Omit<
  z.infer<typeof TaskSnapshotSchema>,
  "contract" | "budgets" | "finalReview" | "lastCheckpoint" | "phaseProgress"
> & {
  contract: TaskContract;
  budgets: Budgets;
  finalReview?: ReviewResult;
  lastCheckpoint?: GitCheckpoint;
  phaseProgress?: PhaseProgress;
};

export interface CreateTaskStoreInput {
  projectPath: string;
  taskId: string;
  conversationId: string;
  contract: TaskContract;
  budgets: Budgets;
  executor: string;
  reviewers: string[];
  startedAt?: string;
}

/**
 * Persists task state, events, and message history under `.assentor/tasks/<id>/`.
 */
export class TaskStore {
  readonly paths: TaskPaths;
  private startedAt: string;

  private constructor(
    readonly projectPath: string,
    readonly taskId: string,
    paths: TaskPaths,
    startedAt: string,
  ) {
    this.paths = paths;
    this.startedAt = startedAt;
  }

  static async create(input: CreateTaskStoreInput): Promise<TaskStore> {
    const paths = await ensureTaskLayout(input.projectPath, input.taskId);
    const startedAt = input.startedAt ?? new Date().toISOString();
    const store = new TaskStore(
      input.projectPath,
      input.taskId,
      paths,
      startedAt,
    );

    await writeJsonAtomic(paths.contractFile, input.contract);
    await fs.writeFile(
      paths.taskMdFile,
      `# Task ${input.taskId}\n\n${input.contract.goal}\n`,
      "utf8",
    );

    const snapshot: TaskSnapshot = {
      taskId: input.taskId,
      conversationId: input.conversationId,
      projectPath: input.projectPath,
      status: TaskState.Initializing,
      currentRound: 0,
      maxRounds: input.budgets.limits.maxRounds,
      executor: input.executor,
      reviewers: input.reviewers,
      contract: input.contract,
      budgets: input.budgets,
      startedAt,
      updatedAt: startedAt,
      communicationCount: 0,
    };
    await store.saveSnapshot(snapshot);
    return store;
  }

  static async open(projectPath: string, taskId: string): Promise<TaskStore> {
    const paths = taskPaths(projectPath, taskId);
    const snapshot = await readJsonFile(paths.stateFile, TaskSnapshotSchema);
    return new TaskStore(
      projectPath,
      taskId,
      paths,
      snapshot.startedAt,
    );
  }

  static async list(projectPath: string): Promise<string[]> {
    return listTaskIds(projectPath);
  }

  static async remove(projectPath: string, taskId: string): Promise<void> {
    await removeTaskDir(projectPath, taskId);
  }

  async saveSnapshot(snapshot: TaskSnapshot): Promise<void> {
    const updated: TaskSnapshot = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      startedAt: snapshot.startedAt || this.startedAt,
    };
    await writeJsonAtomic(this.paths.stateFile, updated);
  }

  async loadSnapshot(): Promise<TaskSnapshot> {
    return readJsonFile(this.paths.stateFile, TaskSnapshotSchema) as Promise<TaskSnapshot>;
  }

  async appendEvent(event: SupervisorEvent): Promise<void> {
    await appendJsonl(this.paths.eventsFile, event);
  }

  async loadEvents(): Promise<SupervisorEvent[]> {
    return readJsonl<SupervisorEvent>(this.paths.eventsFile);
  }

  async appendMessage(message: ProtocolMessage): Promise<void> {
    await appendJsonl(this.paths.historyFile, message);
  }

  async loadHistory(): Promise<ProtocolMessage[]> {
    return readJsonl<ProtocolMessage>(this.paths.historyFile);
  }

  async saveRoundHistory(
    round: number,
    messages: readonly ProtocolMessage[],
  ): Promise<void> {
    const file = `${this.paths.historyDir}/round-${String(round).padStart(3, "0")}.json`;
    await writeJsonAtomic(file, messages);
  }

  async saveCheckpoint(checkpoint: GitCheckpoint): Promise<void> {
    const file = `${this.paths.checkpointsDir}/${checkpoint.id}.json`;
    await writeJsonAtomic(file, checkpoint);
  }
}
