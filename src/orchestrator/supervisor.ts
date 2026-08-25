import {
  canSpend,
  createBudgets,
  spend,
} from "../core/budgets.js";
import { createConversationId, createTaskId } from "../core/ids.js";
import type { TaskContract } from "../core/task-contract.js";
import { BudgetKind, ReviewStatus, type Budgets } from "../core/types.js";
import {
  createProtocolMessage,
  MessageType,
  ProtocolBus,
  type ProtocolMessage,
} from "../protocol/index.js";
import type { ReviewResult } from "../protocol/review-result.js";
import type { Executor, ExecutorResult } from "../providers/executors/types.js";
import type {
  ReviewArtifactRef,
  Reviewer,
  ReviewerTurnResult,
} from "../providers/reviewers/types.js";
import type { TaskSnapshot, TaskStore } from "../persistence/store.js";
import { LoopDetector } from "./loop-detector.js";
import {
  canTransition,
  isTerminalState,
  TaskState,
  transition,
} from "./state-machine.js";

export type SupervisorEventType =
  | "state.changed"
  | "round.started"
  | "round.completed"
  | "executor.started"
  | "executor.completed"
  | "executor.failed"
  | "review.started"
  | "review.completed"
  | "evidence.requested"
  | "change.requested"
  | "loop.detected"
  | "budget.exceeded"
  | "task.completed"
  | "task.blocked"
  | "task.failed";

export interface SupervisorEvent {
  type: SupervisorEventType;
  at: string;
  data?: Record<string, unknown>;
}

export interface SupervisorConfig {
  projectPath: string;
  contract: TaskContract;
  executor: Executor;
  reviewer: Reviewer;
  budgets?: Budgets;
  taskId?: string;
  conversationId?: string;
  /** Optional persistence backend (`.assentor/tasks/<id>`). */
  store?: TaskStore;
  /** Resume from a previously persisted snapshot. */
  resumeFrom?: TaskSnapshot;
  /** Called for observability; must not throw. */
  onEvent?: (event: SupervisorEvent) => void;
}

export interface SupervisorResult {
  taskId: string;
  status: TaskState;
  round: number;
  budgets: Budgets;
  finalReview?: ReviewResult;
  events: SupervisorEvent[];
  history: readonly ProtocolMessage[];
  reason?: string;
}

const EXECUTOR_ID = "executor";
const REVIEWER_ID = "reviewer";
const SUPERVISOR_ID = "supervisor";

type ReviewOutcome =
  | { kind: "pass"; review: ReviewResult }
  | { kind: "needs_work"; review: ReviewResult }
  | { kind: "blocked"; review: ReviewResult }
  | { kind: "failed"; review: ReviewResult }
  | { kind: "communicating"; messages: ProtocolMessage[] };

/**
 * Coordinates executor and reviewer through the protocol bus and FSM.
 * Provider-agnostic: only depends on Executor/Reviewer interfaces.
 */
export class Supervisor {
  private state: TaskState = TaskState.Initializing;
  private round = 0;
  private budgets: Budgets;
  private readonly events: SupervisorEvent[] = [];
  private readonly bus = new ProtocolBus();
  private readonly loopDetector = new LoopDetector();
  private readonly artifacts: ReviewArtifactRef[] = [];
  private sessionId?: string;
  private finalReview?: ReviewResult;
  private cancelRequested = false;
  private lastReason?: string;
  private taskStarted = false;
  private taskId: string;
  private conversationId: string;
  private startedAt: string;

  constructor(private readonly config: SupervisorConfig) {
    this.budgets = config.budgets ?? createBudgets();
    this.taskId = config.taskId ?? config.resumeFrom?.taskId ?? createTaskId();
    this.conversationId =
      config.conversationId ??
      config.resumeFrom?.conversationId ??
      createConversationId();
    this.startedAt =
      config.resumeFrom?.startedAt ?? new Date().toISOString();

    if (config.resumeFrom) {
      this.restoreFromSnapshot(config.resumeFrom);
    }
  }

  getState(): TaskState {
    return this.state;
  }

  getTaskId(): string {
    return this.taskId;
  }

  requestCancel(): void {
    this.cancelRequested = true;
  }

  async run(): Promise<SupervisorResult> {
    const taskId = this.taskId;
    const conversationId = this.conversationId;

    try {
      if (this.state === TaskState.Initializing) {
        this.moveTo(TaskState.CheckingProject);
        this.moveTo(TaskState.CreatingCheckpoint);
        this.moveTo(TaskState.Contracting);
        this.moveTo(TaskState.Executing);
      } else if (
        this.state === TaskState.CollectingEvidence ||
        this.state === TaskState.Communicating ||
        this.state === TaskState.CheckingProject ||
        this.state === TaskState.CreatingCheckpoint ||
        this.state === TaskState.Contracting
      ) {
        // Normalize interrupted mid-bootstrap / mid-cycle states.
        this.state = TaskState.Executing;
        await this.persistSnapshot();
      }

      while (!isTerminalState(this.state)) {
        if (this.cancelRequested) {
          this.tryMove(TaskState.Cancelled);
          break;
        }

        if (this.state === TaskState.Executing) {
          if (!this.beginRound()) {
            break;
          }

          const execResult = await this.runExecutor(taskId, conversationId);
          if (isTerminalState(this.state)) {
            break;
          }
          if (this.handleExecutorTerminal(execResult)) {
            break;
          }

          this.moveTo(TaskState.CollectingEvidence);
          await this.collectBasicArtifacts(execResult);
          this.moveTo(TaskState.Reviewing);
        }

        if (this.state === TaskState.Reviewing) {
          const outcome = await this.runReviewer(taskId, conversationId);
          if (isTerminalState(this.state)) {
            break;
          }

          const done = await this.applyReviewOutcome(
            taskId,
            conversationId,
            outcome,
          );
          if (done) {
            break;
          }
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.tryMove(TaskState.Failed, reason);
      this.emit("task.failed", { reason });
    }

    await this.persistSnapshot();
    await this.persistRoundHistory();

    return {
      taskId,
      status: this.state,
      round: this.round,
      budgets: this.budgets,
      finalReview: this.finalReview,
      events: [...this.events],
      history: this.bus.getHistory(),
      reason: this.lastReason,
    };
  }

  private restoreFromSnapshot(snapshot: TaskSnapshot): void {
    this.state = snapshot.status as TaskState;
    this.round = snapshot.currentRound;
    this.budgets = snapshot.budgets;
    this.sessionId = snapshot.executorSessionId;
    this.finalReview = snapshot.finalReview;
    this.lastReason = snapshot.reason;
    this.taskStarted =
      Boolean(snapshot.executorSessionId) || snapshot.currentRound > 0;
  }

  private beginRound(): boolean {
    if (!canSpend(this.budgets, BudgetKind.Round)) {
      this.tryMove(TaskState.BudgetExceeded, "Budget exceeded: round");
      this.emit("budget.exceeded", {
        kind: BudgetKind.Round,
        usage: this.budgets.usage,
        limits: this.budgets.limits,
      });
      return false;
    }

    this.round += 1;
    this.budgets = spend(this.budgets, BudgetKind.Round);
    this.emit("round.started", { round: this.round });
    return true;
  }

  private handleExecutorTerminal(result: ExecutorResult): boolean {
    if (result.status === "failed") {
      this.moveTo(TaskState.Failed, result.error ?? result.summary);
      return true;
    }
    if (result.status === "timeout") {
      this.moveTo(TaskState.Timeout, result.error ?? "Executor timed out");
      return true;
    }
    if (result.status === "cancelled") {
      this.moveTo(TaskState.Cancelled);
      return true;
    }
    return false;
  }

  private async applyReviewOutcome(
    taskId: string,
    conversationId: string,
    outcome: ReviewOutcome,
  ): Promise<boolean> {
    if (outcome.kind === "pass") {
      this.finalReview = outcome.review;
      this.moveTo(TaskState.Done);
      this.emit("round.completed", { round: this.round, state: this.state });
      this.emit("task.completed", { round: this.round });
      return true;
    }

    if (outcome.kind === "blocked") {
      this.finalReview = outcome.review;
      this.moveTo(TaskState.HumanRequired, outcome.review.summary);
      this.emit("task.blocked", { summary: outcome.review.summary });
      return true;
    }

    if (outcome.kind === "failed") {
      this.finalReview = outcome.review;
      this.moveTo(TaskState.Failed, outcome.review.summary);
      this.emit("task.failed", { summary: outcome.review.summary });
      return true;
    }

    if (outcome.kind === "needs_work") {
      this.finalReview = outcome.review;
      if (this.noteLoop(outcome.review)) {
        this.moveTo(
          TaskState.HumanRequired,
          "Repeated identical change requests detected",
        );
        this.emit("task.blocked", { reason: "loop_detected" });
        return true;
      }

      await this.publishChangeRequest(conversationId, outcome.review);
      this.emit("round.completed", { round: this.round, state: this.state });
      await this.persistSnapshot();
      await this.persistRoundHistory();
      this.moveTo(TaskState.Executing);
      return false;
    }

    // communicating: evidence / questions within the same round
    this.moveTo(TaskState.Communicating);
    const resolved = await this.handleCommunication(taskId, conversationId);
    if (!resolved || isTerminalState(this.state)) {
      return true;
    }
    this.moveTo(TaskState.Reviewing);
    return false;
  }

  private moveTo(next: TaskState, reason?: string): void {
    const previous = this.state;
    this.state = transition(previous, next);
    if (reason) {
      this.lastReason = reason;
    }
    this.emit("state.changed", { from: previous, to: next, reason });
  }

  private tryMove(next: TaskState, reason?: string): void {
    if (this.state === next) {
      if (reason) {
        this.lastReason = reason;
      }
      return;
    }
    if (canTransition(this.state, next)) {
      this.moveTo(next, reason);
    } else if (reason) {
      this.lastReason = reason;
    }
  }

  private async spendMessage(): Promise<boolean> {
    if (!canSpend(this.budgets, BudgetKind.Message)) {
      this.tryMove(TaskState.BudgetExceeded, "Budget exceeded: message");
      this.emit("budget.exceeded", {
        kind: BudgetKind.Message,
        usage: this.budgets.usage,
        limits: this.budgets.limits,
      });
      return false;
    }
    this.budgets = spend(this.budgets, BudgetKind.Message);
    return true;
  }

  private async runExecutor(
    taskId: string,
    conversationId: string,
  ): Promise<ExecutorResult> {
    this.emit("executor.started", { round: this.round });

    const inbound = this.bus.receive(EXECUTOR_ID);

    let result: ExecutorResult;
    try {
      if (this.taskStarted) {
        result = await this.config.executor.continue({
          taskId,
          projectPath: this.config.projectPath,
          contract: this.config.contract,
          messages: inbound,
          sessionId: this.sessionId,
        });
      } else {
        const taskMessage = createProtocolMessage({
          conversationId,
          round: this.round,
          from: SUPERVISOR_ID,
          to: EXECUTOR_ID,
          type: MessageType.Task,
          content: {
            goal: this.config.contract.goal,
            contract: this.config.contract as unknown as Record<string, unknown>,
          },
        });
        if (!(await this.spendMessage())) {
          return {
            status: "failed",
            summary: "Message budget exceeded before executor start",
          };
        }
        await this.publishMessage(taskMessage);
        // Already delivered via publish; avoid double-delivery by not also
        // passing the same message if it was queued to executor.
        const queued = this.bus.receive(EXECUTOR_ID);

        result = await this.config.executor.run({
          taskId,
          projectPath: this.config.projectPath,
          contract: this.config.contract,
          prompt: this.config.contract.goal,
          messages: queued,
        });
        this.taskStarted = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("executor.failed", { error: message });
      return { status: "failed", summary: message, error: message };
    }

    if (result.sessionId) {
      this.sessionId = result.sessionId;
    }

    if (result.messages) {
      for (const message of result.messages) {
        if (!(await this.spendMessage())) {
          break;
        }
        await this.publishMessage(message);
      }
    }

    this.emit("executor.completed", {
      status: result.status,
      summary: result.summary,
    });
    return result;
  }

  private async collectBasicArtifacts(result: ExecutorResult): Promise<void> {
    // Keep prior executor summaries; refresh file evidence each round.
    const kept = this.artifacts.filter(
      (artifact) => artifact.type === "executor_summary",
    );
    this.artifacts.length = 0;
    this.artifacts.push(...kept);

    this.artifacts.push({
      id: `executor-summary-round-${this.round}`,
      type: "executor_summary",
      description: "Executor summary for this round",
      content: result.rawOutput ?? result.summary,
    });

    const projectFiles = await this.collectProjectFileEvidence();
    this.emit("evidence.requested", {
      count: this.artifacts.length,
      files: projectFiles,
    });
  }

  /**
   * Prefer real source file contents over noisy git status of `.assentor/`.
   */
  private async collectProjectFileEvidence(): Promise<string[]> {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const { LocalGitService } = await import("../git/local.js");

    const root = this.config.projectPath;
    const candidates = new Set<string>();

    const textBlobs = [
      this.config.contract.goal,
      ...this.config.contract.requirements,
      ...this.config.contract.acceptanceCriteria,
      ...this.config.contract.verificationPlan,
    ];
    for (const text of textBlobs) {
      const matches = text.match(
        /([A-Za-z0-9_./-]+\.(?:html|css|js|ts|tsx|jsx|json|md|py|go|rs|java))/g,
      );
      for (const match of matches ?? []) {
        candidates.add(match.replace(/^\.\//, ""));
      }
    }

    for (const name of [
      "index.html",
      "styles.css",
      "style.css",
      "app.js",
      "main.js",
      "package.json",
      "README.md",
    ]) {
      candidates.add(name);
    }

    try {
      const git = new LocalGitService({ cwd: root });
      if (await git.isRepo()) {
        const changed = (await git.changedFiles()).filter(
          (file) => !isNoisePath(file),
        );
        for (const file of changed) {
          candidates.add(file);
        }

        this.artifacts.push({
          id: `git-changed-round-${this.round}`,
          type: "changed_files",
          description: "Changed project files (excluding .assentor/)",
          content: changed.length > 0 ? changed.join("\n") : "(none)",
        });
      }
    } catch {
      // Git optional — still try reading candidate files.
    }

    const included: string[] = [];
    for (const relative of [...candidates].sort()) {
      if (isNoisePath(relative)) {
        continue;
      }
      const absolute = path.join(root, relative);
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > 200_000) {
          continue;
        }
        const content = await fs.readFile(absolute, "utf8");
        this.artifacts.push({
          id: `file-round-${this.round}-${relative.replace(/[^\w.-]+/g, "_")}`,
          type: "file",
          path: relative,
          description: `Full contents of ${relative}`,
          content: content.slice(0, 100_000),
        });
        included.push(relative);
      } catch {
        // File may not exist yet.
      }
    }

    return included;
  }

  private async runReviewer(
    taskId: string,
    _conversationId: string,
  ): Promise<ReviewOutcome> {
    this.emit("review.started", { round: this.round });

    const inbound = this.bus.receive(REVIEWER_ID);
    let turn: ReviewerTurnResult;

    try {
      turn = await this.config.reviewer.review({
        taskId,
        projectPath: this.config.projectPath,
        contract: this.config.contract,
        round: this.round,
        artifacts: [...this.artifacts],
        messages: inbound,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "failed",
        review: {
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: message,
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        },
      };
    }

    const messages = turn.messages ?? [];
    for (const message of messages) {
      if (!(await this.spendMessage())) {
        break;
      }
      await this.publishMessage(message);
    }

    const communication = messages.filter(
      (message) =>
        message.type === MessageType.EvidenceRequest ||
        message.type === MessageType.Question ||
        message.type === MessageType.InvestigationRequest ||
        message.type === MessageType.TestRequest ||
        message.type === MessageType.BuildRequest ||
        message.type === MessageType.ClarificationRequest,
    );

    if (communication.length > 0 && !turn.result) {
      this.emit("evidence.requested", { count: communication.length });
      return { kind: "communicating", messages: communication };
    }

    if (!turn.result) {
      return {
        kind: "failed",
        review: {
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: turn.error ?? "Reviewer returned no structured result",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        },
      };
    }

    this.emit("review.completed", {
      status: turn.result.status,
      summary: turn.result.summary,
      confidence: turn.result.confidence,
      issues: turn.result.issues,
      requiredChanges: turn.result.requiredChanges,
      optionalChanges: turn.result.optionalChanges,
      evidenceRequests: turn.result.evidenceRequests,
    });

    if (
      turn.result.evidenceRequests.length > 0 &&
      turn.result.status === ReviewStatus.NeedsWork
    ) {
      const evidenceMessage = createProtocolMessage({
        conversationId: _conversationId,
        round: this.round,
        from: REVIEWER_ID,
        to: EXECUTOR_ID,
        type: MessageType.EvidenceRequest,
        content: {
          requests: turn.result.evidenceRequests,
          reason: turn.result.summary,
        },
      });
      if (await this.spendMessage()) {
        await this.publishMessage(evidenceMessage);
      }
      this.emit("evidence.requested", {
        count: turn.result.evidenceRequests.length,
      });
      return { kind: "communicating", messages: [evidenceMessage] };
    }

    switch (turn.result.status) {
      case ReviewStatus.Pass:
        return { kind: "pass", review: turn.result };
      case ReviewStatus.NeedsWork:
        return { kind: "needs_work", review: turn.result };
      case ReviewStatus.Blocked:
        return { kind: "blocked", review: turn.result };
      case ReviewStatus.Failed:
        return { kind: "failed", review: turn.result };
      default: {
        const _exhaustive: never = turn.result.status;
        return _exhaustive;
      }
    }
  }

  private noteLoop(review: ReviewResult): boolean {
    const { signal, looping } = this.loopDetector.check(this.round, {
      requiredChanges: review.requiredChanges,
      issueIds: review.issues.map((issue) => issue.id),
      summary: review.summary,
    });

    if (looping) {
      this.emit("loop.detected", {
        fingerprint: signal.fingerprint,
        count: signal.count,
        rounds: signal.rounds,
      });
    }

    return looping;
  }

  private async publishChangeRequest(
    conversationId: string,
    review: ReviewResult,
  ): Promise<void> {
    const message = createProtocolMessage({
      conversationId,
      round: this.round,
      from: REVIEWER_ID,
      to: EXECUTOR_ID,
      type: MessageType.ChangeRequest,
      content: {
        summary: review.summary,
        requiredChanges: review.requiredChanges,
        optionalChanges: review.optionalChanges,
        issueIds: review.issues.map((issue) => issue.id),
      },
    });

    if (await this.spendMessage()) {
      await this.publishMessage(message);
      this.emit("change.requested", {
        requiredChanges: review.requiredChanges,
      });
    }
  }

  /**
   * Ask the executor to satisfy evidence/questions, then prepare for re-review.
   * @returns false if the task became terminal
   */
  private async handleCommunication(
    taskId: string,
    conversationId: string,
  ): Promise<boolean> {
    this.moveTo(TaskState.Executing);

    const execResult = await this.runExecutor(taskId, conversationId);
    if (this.handleExecutorTerminal(execResult)) {
      return false;
    }

    this.moveTo(TaskState.CollectingEvidence);
    await this.collectBasicArtifacts(execResult);
    return true;
  }

  private async publishMessage(message: ProtocolMessage): Promise<void> {
    await this.bus.publish(message);
    try {
      await this.config.store?.appendMessage(message);
    } catch {
      // Persistence failures must not crash the supervisor loop.
    }
  }

  private async persistSnapshot(): Promise<void> {
    const store = this.config.store;
    if (!store) {
      return;
    }

    try {
      await store.saveSnapshot({
        taskId: this.taskId,
        conversationId: this.conversationId,
        projectPath: this.config.projectPath,
        status: this.state,
        currentRound: this.round,
        maxRounds: this.budgets.limits.maxRounds,
        executor: this.config.executor.name,
        reviewers: [this.config.reviewer.name],
        contract: this.config.contract,
        budgets: this.budgets,
        executorSessionId: this.sessionId,
        finalReview: this.finalReview,
        reason: this.lastReason,
        startedAt: this.startedAt,
        updatedAt: new Date().toISOString(),
        communicationCount: this.budgets.usage.messages,
      });
    } catch {
      // Persistence failures must not crash the supervisor loop.
    }
  }

  private async persistRoundHistory(): Promise<void> {
    const store = this.config.store;
    if (!store || this.round <= 0) {
      return;
    }
    try {
      await store.saveRoundHistory(
        this.round,
        this.bus.getHistory({ round: this.round }),
      );
    } catch {
      // ignore
    }
  }

  private emit(
    type: SupervisorEventType,
    data?: Record<string, unknown>,
  ): void {
    const event: SupervisorEvent = {
      type,
      at: new Date().toISOString(),
      data,
    };
    this.events.push(event);
    try {
      this.config.onEvent?.(event);
    } catch {
      // Observability must never break the supervisor.
    }
    void this.config.store?.appendEvent(event).catch(() => undefined);
  }
}

function isNoisePath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  return (
    normalized === ".assentor" ||
    normalized.startsWith(".assentor/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".git/") ||
    normalized.endsWith(".map")
  );
}
