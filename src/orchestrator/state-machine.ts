import { InvalidTransitionError } from "../core/errors.js";

/**
 * Explicit task FSM states for the Assentor supervisor.
 * Pure transition table only — no I/O or orchestration side effects.
 *
 * FSM_VERSION tracks schema evolution. Planned analysis phases
 * (TaskAnalysis → ComplexityScoring → ReviewerSelection → … → FinalVerification)
 * may be added in a later version; unknown persisted states MUST fall back via
 * {@link normalizeTaskState} so old task resumes keep working.
 */
export const FSM_VERSION = 1;

export const TaskState = {
  Initializing: "INITIALIZING",
  CheckingProject: "CHECKING_PROJECT",
  CreatingCheckpoint: "CREATING_CHECKPOINT",
  Contracting: "CONTRACTING",
  Executing: "EXECUTING",
  CollectingEvidence: "COLLECTING_EVIDENCE",
  Reviewing: "REVIEWING",
  Communicating: "COMMUNICATING",
  Done: "DONE",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
  BudgetExceeded: "BUDGET_EXCEEDED",
  Timeout: "TIMEOUT",
  HumanRequired: "HUMAN_REQUIRED",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

const KNOWN_STATES = new Set<string>(Object.values(TaskState));

/**
 * Map unknown/future persisted phases to a safe resumable state.
 * Keeps resume backward compatible when FSM_VERSION advances.
 */
export function normalizeTaskState(
  state: string | undefined | null,
  fallback: TaskState = TaskState.Executing,
): TaskState {
  if (state && KNOWN_STATES.has(state)) {
    return state as TaskState;
  }
  return fallback;
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.Done,
  TaskState.Failed,
  TaskState.Cancelled,
  TaskState.BudgetExceeded,
  TaskState.Timeout,
  TaskState.HumanRequired,
]);

/**
 * Legal transitions keyed by source state.
 * Terminal states have no outgoing transitions.
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  [TaskState.Initializing]: [TaskState.CheckingProject],
  [TaskState.CheckingProject]: [TaskState.CreatingCheckpoint],
  [TaskState.CreatingCheckpoint]: [TaskState.Contracting],
  [TaskState.Contracting]: [TaskState.Executing],
  [TaskState.Executing]: [
    TaskState.CollectingEvidence,
    TaskState.Failed,
    TaskState.Cancelled,
    TaskState.BudgetExceeded,
    TaskState.Timeout,
  ],
  [TaskState.CollectingEvidence]: [TaskState.Reviewing],
  [TaskState.Reviewing]: [
    TaskState.Done,
    TaskState.Executing,
    TaskState.Communicating,
    TaskState.HumanRequired,
    TaskState.Failed,
    TaskState.Cancelled,
    TaskState.BudgetExceeded,
    TaskState.Timeout,
  ],
  [TaskState.Communicating]: [
    TaskState.Executing,
    TaskState.Reviewing,
    TaskState.Failed,
    TaskState.Cancelled,
    TaskState.BudgetExceeded,
    TaskState.Timeout,
    TaskState.HumanRequired,
  ],
  [TaskState.Done]: [],
  [TaskState.Failed]: [],
  [TaskState.Cancelled]: [],
  [TaskState.BudgetExceeded]: [],
  [TaskState.Timeout]: [],
  [TaskState.HumanRequired]: [],
};

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  const allowed = TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Returns `to` when the transition is legal; otherwise throws InvalidTransitionError.
 */
export function transition(from: TaskState, to: TaskState): TaskState {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
  return to;
}

export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from];
}
