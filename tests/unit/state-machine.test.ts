import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canTransition,
  FSM_VERSION,
  InvalidTransitionError,
  isTerminalState,
  normalizeTaskState,
  TaskState,
  TRANSITIONS,
  transition,
} from "../../src/index.js";

describe("state machine", () => {
  it("defines transitions for every TaskState", () => {
    for (const state of Object.values(TaskState)) {
      expect(TRANSITIONS[state]).toBeDefined();
      expect(Array.isArray(TRANSITIONS[state])).toBe(true);
    }
  });

  it("normalizes unknown future phases for resume compatibility", () => {
    expect(FSM_VERSION).toBeGreaterThanOrEqual(1);
    expect(normalizeTaskState("TASK_ANALYSIS")).toBe(TaskState.Executing);
    expect(normalizeTaskState(TaskState.Reviewing)).toBe(TaskState.Reviewing);
  });

  it("marks terminal states correctly", () => {
    expect(isTerminalState(TaskState.Done)).toBe(true);
    expect(isTerminalState(TaskState.Failed)).toBe(true);
    expect(isTerminalState(TaskState.Cancelled)).toBe(true);
    expect(isTerminalState(TaskState.BudgetExceeded)).toBe(true);
    expect(isTerminalState(TaskState.Timeout)).toBe(true);
    expect(isTerminalState(TaskState.HumanRequired)).toBe(true);
    expect(isTerminalState(TaskState.Executing)).toBe(false);
    expect(allowedTransitions(TaskState.Done)).toEqual([]);
  });

  it("allows the happy-path startup chain", () => {
    const path: TaskState[] = [
      TaskState.Initializing,
      TaskState.CheckingProject,
      TaskState.CreatingCheckpoint,
      TaskState.Contracting,
      TaskState.Executing,
      TaskState.CollectingEvidence,
      TaskState.Reviewing,
      TaskState.Done,
    ];

    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
      expect(transition(from, to)).toBe(to);
    }
  });

  it("supports NEEDS_WORK and communication loops", () => {
    expect(canTransition(TaskState.Reviewing, TaskState.Executing)).toBe(true);
    expect(canTransition(TaskState.Reviewing, TaskState.Communicating)).toBe(true);
    expect(canTransition(TaskState.Communicating, TaskState.Executing)).toBe(true);
    expect(canTransition(TaskState.Communicating, TaskState.Reviewing)).toBe(true);
    expect(canTransition(TaskState.Reviewing, TaskState.HumanRequired)).toBe(true);
  });

  it("allows failure paths from active states", () => {
    for (const from of [
      TaskState.Executing,
      TaskState.Reviewing,
      TaskState.Communicating,
    ] as const) {
      expect(canTransition(from, TaskState.Failed)).toBe(true);
      expect(canTransition(from, TaskState.Cancelled)).toBe(true);
      expect(canTransition(from, TaskState.BudgetExceeded)).toBe(true);
      expect(canTransition(from, TaskState.Timeout)).toBe(true);
    }
  });

  it("rejects illegal transitions", () => {
    expect(canTransition(TaskState.Initializing, TaskState.Done)).toBe(false);
    expect(canTransition(TaskState.Done, TaskState.Executing)).toBe(false);
    expect(canTransition(TaskState.CheckingProject, TaskState.Reviewing)).toBe(
      false,
    );

    expect(() =>
      transition(TaskState.Initializing, TaskState.Done),
    ).toThrow(InvalidTransitionError);

    try {
      transition(TaskState.Done, TaskState.Executing);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const typed = error as InvalidTransitionError;
      expect(typed.from).toBe(TaskState.Done);
      expect(typed.to).toBe(TaskState.Executing);
      expect(typed.code).toBe("INVALID_TRANSITION");
    }
  });
});
