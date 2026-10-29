export {
  TaskState,
  FSM_VERSION,
  TRANSITIONS,
  isTerminalState,
  isRetryableState,
  isFailedResumeStatus,
  canTransition,
  transition,
  allowedTransitions,
  normalizeTaskState,
} from "./state-machine.js";

export {
  LoopDetector,
  fingerprintChangeRequest,
  type LoopSignal,
  type LoopDetectorOptions,
} from "./loop-detector.js";

export {
  isStalledWaitingForConfirmation,
  remainingPhases,
  areAllPhasesComplete,
  buildNextPhaseDirective,
  mergeContractPhases,
  applyPhaseProgressToContract,
  generateDirectiveForRemaining,
  downgradePassIfPhasesRemain,
  buildSupervisedContinuationPrompt,
  buildAutonomousTaskPrompt,
  buildAutonomousContinuationPrompt,
} from "./phase-steering.js";

export {
  Supervisor,
  reviewRequiresExecutor,
  type SupervisorConfig,
  type SupervisorEvent,
  type SupervisorEventType,
  type SupervisorResult,
} from "./supervisor.js";

export {
  SessionRunner,
  validateSessionGraph,
  STAGE_OUTCOMES,
  SESSION_RUN_STATUSES,
  type StageOutcome,
  type SessionRunStatus,
  type StageResult,
  type StageRunInput,
  type StageRunners,
  type StageRecord,
  type SessionRunResult,
  type SessionRunnerOptions,
} from "./session-runner.js";

export {
  fromSupervisorEvent,
  engineTypeForSupervisorEvent,
  type SupervisorEventContext,
} from "./engine-events.js";

export {
  SeatEventSink,
  seatStatusFromActivity,
  trackReviewerSeat,
  type SeatEventSinkOptions,
  type SeatInfo,
} from "./seat-events.js";
