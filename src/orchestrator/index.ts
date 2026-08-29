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
  type SupervisorConfig,
  type SupervisorEvent,
  type SupervisorEventType,
  type SupervisorResult,
} from "./supervisor.js";
