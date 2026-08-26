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
import { makeReviewResult } from "../protocol/review-result.js";
import type { EvidenceRequestItem } from "../protocol/messages.js";
import type { Executor, ExecutorResult } from "../providers/executors/types.js";
import type {
  ReviewArtifactRef,
  Reviewer,
  ReviewerTurnResult,
} from "../providers/reviewers/types.js";
import type { TaskSnapshot, TaskStore } from "../persistence/store.js";
import type { GitCheckpoint } from "../git/types.js";
import { LocalGitService } from "../git/local.js";
import {
  EvidencePackBuilder,
  parseArchitectureSummary,
  parseExecutorExplanation,
  type ProjectReviewEvidencePack,
} from "../review/index.js";
import { LoopDetector } from "./loop-detector.js";
import {
  canTransition,
  isTerminalState,
  normalizeTaskState,
  FSM_VERSION,
  TaskState,
  transition,
} from "./state-machine.js";

const MAX_EVIDENCE_ITERATIONS = 3;

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
  | "evidence.fulfilled"
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
  /** Evidence pack depth. Default STANDARD. */
  evidenceDepth?: ProjectReviewEvidencePack["depth"];
  /** Cap evidence-request loops within a round. Default 3. */
  maxEvidenceIterations?: number;
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
  private persistQueue: Promise<void> = Promise.resolve();
  private lastReason?: string;
  private taskStarted = false;
  private taskId: string;
  private conversationId: string;
  private startedAt: string;
  private lastCheckpoint?: GitCheckpoint;
  private evidencePack?: ProjectReviewEvidencePack;
  private evidenceIterations = 0;
  private readonly maxEvidenceIterations: number;

  constructor(private readonly config: SupervisorConfig) {
    this.budgets = config.budgets ?? createBudgets();
    this.taskId = config.taskId ?? config.resumeFrom?.taskId ?? createTaskId();
    this.conversationId =
      config.conversationId ??
      config.resumeFrom?.conversationId ??
      createConversationId();
    this.startedAt =
      config.resumeFrom?.startedAt ?? new Date().toISOString();
    this.maxEvidenceIterations =
      config.maxEvidenceIterations ?? MAX_EVIDENCE_ITERATIONS;

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
        await this.captureGitCheckpoint();
        this.moveTo(TaskState.Contracting);
        this.moveTo(TaskState.Executing);
        await this.flushPersist();
      } else if (
        this.state === TaskState.CollectingEvidence ||
        this.state === TaskState.Communicating ||
        this.state === TaskState.CheckingProject ||
        this.state === TaskState.CreatingCheckpoint ||
        this.state === TaskState.Contracting
      ) {
        // Normalize interrupted mid-bootstrap / mid-cycle states.
        this.state = TaskState.Executing;
        await this.flushPersist();
      }

      while (!isTerminalState(this.state)) {
        if (this.cancelRequested) {
          this.tryMove(
            TaskState.Failed,
            "Interrupted (Ctrl+C). Resume with: assentor resume",
          );
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

    await this.flushPersist();
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
    let state = normalizeTaskState(snapshot.status);
    // Retryable failures (timeout / auth / blocked) pick up in EXECUTING.
    if (
      state === TaskState.Failed ||
      state === TaskState.Timeout ||
      state === TaskState.HumanRequired
    ) {
      state = TaskState.Executing;
    }
    this.state = state;
    this.round = snapshot.currentRound;
    this.budgets = snapshot.budgets;
    this.sessionId = snapshot.executorSessionId;
    this.finalReview = snapshot.finalReview;
    this.lastReason = snapshot.reason;
    this.taskStarted =
      Boolean(snapshot.executorSessionId) || snapshot.currentRound > 0;
    this.lastCheckpoint = snapshot.lastCheckpoint;
  }

  private async captureGitCheckpoint(): Promise<void> {
    if (this.lastCheckpoint?.head) {
      return;
    }
    try {
      const git = new LocalGitService({ cwd: this.config.projectPath });
      if (!(await git.isRepo())) {
        return;
      }
      this.lastCheckpoint = await git.createCheckpoint("task-start");
    } catch {
      // Git is optional; review still has executor-named files as a fallback.
    }
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
    this.evidenceIterations = 0;
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
      this.moveTo(
        TaskState.Failed,
        result.error ?? "Interrupted (Ctrl+C). Resume with: assentor resume",
      );
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
      await this.flushPersist();
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
    this.enqueuePersist();
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
      rawOutput: result.rawOutput,
    });
    return result;
  }

  private async collectBasicArtifacts(result: ExecutorResult): Promise<void> {
    const executorText = result.rawOutput ?? result.summary ?? "";
    const explanation = parseExecutorExplanation(executorText);
    const architectureSummary = parseArchitectureSummary(executorText);

    const builder = new EvidencePackBuilder({
      projectPath: this.config.projectPath,
      taskId: this.taskId,
      round: this.round,
      depth: this.config.evidenceDepth ?? "STANDARD",
      contract: this.config.contract,
      runCommands: false,
      gitBaselineHead: this.lastCheckpoint?.head,
    });

    const architecture = architectureSummary
      ? {
          summary: architectureSummary,
          modules: [] as string[],
          boundaries: [] as string[],
          abstractions: [] as string[],
          source: "executor" as const,
        }
      : undefined;

    this.evidencePack = await builder.build({
      executorResult: result,
      executorExplanation: explanation,
      architecture,
    });

    try {
      await builder.persist(this.evidencePack, this.taskId);
    } catch {
      // Persistence optional for pack
    }

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
    this.artifacts.push(...builder.getCollector().toReviewRefs());

    this.emit("evidence.fulfilled", {
      count: this.artifacts.length,
      files: this.evidencePack.relevantFiles.map((f) => f.path),
      packRound: this.round,
    });
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
        evidencePack: this.evidencePack,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "failed",
        review: makeReviewResult({
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: message,
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
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
        review: makeReviewResult({
          status: ReviewStatus.Failed,
          confidence: 1,
          summary: turn.error ?? "Reviewer returned no structured result",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
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
      (turn.result.evidenceRequests?.length ?? 0) > 0 &&
      turn.result.status === ReviewStatus.NeedsWork
    ) {
      const evidenceMessage = createProtocolMessage({
        conversationId: _conversationId,
        round: this.round,
        from: REVIEWER_ID,
        to: EXECUTOR_ID,
        type: MessageType.EvidenceRequest,
        content: {
          requests: turn.result.evidenceRequests ?? [],
          reason: turn.result.summary,
        },
      });
      if (await this.spendMessage()) {
        await this.publishMessage(evidenceMessage);
      }
      this.emit("evidence.requested", {
        count: turn.result.evidenceRequests?.length ?? 0,
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
      issueIds: (review.issues ?? []).map((issue) => issue.id),
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
        requiredChanges: review.requiredChanges ?? [],
        optionalChanges: review.optionalChanges ?? [],
        issueIds: (review.issues ?? []).map((issue) => issue.id),
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
   * Fulfill reviewer evidence requests locally. Never re-invokes the executor.
   * @returns false if the task became terminal
   */
  private async handleCommunication(
    taskId: string,
    conversationId: string,
  ): Promise<boolean> {
    this.evidenceIterations += 1;
    if (this.evidenceIterations > this.maxEvidenceIterations) {
      this.finalReview = makeReviewResult({
        status: ReviewStatus.Blocked,
        confidence: 1,
        summary: `Stuck requesting evidence after ${this.maxEvidenceIterations} iterations`,
        issues: [],
        requiredChanges: [],
        optionalChanges: [],
        evidenceRequests: [],
      });
      this.moveTo(
        TaskState.HumanRequired,
        "Evidence request loop exceeded cap",
      );
      this.emit("task.blocked", { reason: "evidence_iteration_cap" });
      return false;
    }

    const pending = this.extractPendingEvidenceRequests();
    if (pending.length > 0) {
      if (!this.evidencePack) {
        const bootstrap = new EvidencePackBuilder({
          projectPath: this.config.projectPath,
          taskId: this.taskId,
          round: this.round,
          depth: this.config.evidenceDepth ?? "STANDARD",
          contract: this.config.contract,
          runCommands: false,
          gitBaselineHead: this.lastCheckpoint?.head,
        });
        this.evidencePack = await bootstrap.build({});
      }

      const builder = new EvidencePackBuilder({
        projectPath: this.config.projectPath,
        taskId: this.taskId,
        round: this.round,
        depth: this.config.evidenceDepth ?? "STANDARD",
        contract: this.config.contract,
        runCommands: true,
        gitBaselineHead: this.lastCheckpoint?.head,
      });
      const merged = await builder.mergeRequests(this.evidencePack, pending);
      this.evidencePack = merged.pack;
      try {
        await builder.persist(this.evidencePack, this.taskId);
      } catch {
        // ignore
      }

      for (const ref of builder.getCollector().toReviewRefs()) {
        if (!this.artifacts.some((a) => a.id === ref.id && a.type === ref.type)) {
          this.artifacts.push(ref);
        }
      }

      this.emit("evidence.fulfilled", {
        fulfilled: merged.fulfilled,
        skipped: merged.skipped,
        errors: merged.errors,
        unfulfilled: merged.unfulfilled.length,
      });

      if (await this.spendMessage()) {
        const responseArtifacts = builder
          .getCollector()
          .toReviewRefs()
          .filter((ref) => ref.content || ref.path)
          .slice(0, 20)
          .map((ref) => ({
            kind: "file" as const,
            path: ref.path ?? ref.id,
            content: ref.content?.slice(0, 8_000),
            description: ref.description,
          }));
        const notes = [
          merged.errors.length > 0 ? merged.errors.join("; ") : "",
          merged.unfulfilled.length > 0
            ? `${merged.unfulfilled.length} request(s) could not be fulfilled locally`
            : "",
          `fulfilled=${merged.fulfilled} skipped=${merged.skipped}`,
        ]
          .filter(Boolean)
          .join("; ");
        await this.publishMessage(
          createProtocolMessage({
            conversationId,
            round: this.round,
            from: SUPERVISOR_ID,
            to: REVIEWER_ID,
            type: MessageType.EvidenceResponse,
            content: {
              artifacts:
                responseArtifacts.length > 0
                  ? responseArtifacts
                  : [
                      {
                        kind: "file" as const,
                        path: "evidence/fulfilled",
                        content: notes || "Assentor local evidence fulfillment",
                        description: "Assentor local evidence fulfillment",
                      },
                    ],
              notes,
            },
          }),
        );
      }

      return true;
    }

    this.moveTo(TaskState.Executing);
    const execResult = await this.runExecutor(taskId, conversationId);
    if (this.handleExecutorTerminal(execResult)) {
      return false;
    }

    this.moveTo(TaskState.CollectingEvidence);
    await this.collectBasicArtifacts(execResult);
    return true;
  }

  private extractPendingEvidenceRequests(): EvidenceRequestItem[] {
    const history = this.bus.getHistory({ round: this.round });
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message?.type !== MessageType.EvidenceRequest) continue;
      const content = message.content as { requests?: EvidenceRequestItem[] };
      if (Array.isArray(content.requests)) {
        return content.requests;
      }
    }
    return this.finalReview?.evidenceRequests ?? [];
  }

  private async publishMessage(message: ProtocolMessage): Promise<void> {
    await this.bus.publish(message);
    try {
      await this.config.store?.appendMessage(message);
    } catch {
      // Persistence failures must not crash the supervisor loop.
    }
  }

  private enqueuePersist(): void {
    this.persistQueue = this.persistQueue.then(
      () => this.persistSnapshot(),
      () => this.persistSnapshot(),
    );
  }

  private async flushPersist(): Promise<void> {
    this.enqueuePersist();
    await this.persistQueue;
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
        fsmVersion: FSM_VERSION,
        currentRound: this.round,
        maxRounds: this.budgets.limits.maxRounds,
        executor: this.config.executor.name,
        reviewers: [this.config.reviewer.name],
        contract: this.config.contract,
        budgets: this.budgets,
        executorSessionId: this.sessionId,
        lastCheckpoint: this.lastCheckpoint,
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
