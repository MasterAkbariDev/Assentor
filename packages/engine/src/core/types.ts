/**
 * Shared domain types for Assentor.
 * Provider-specific types belong under src/providers/.
 */

export type TaskId = string;
export type MessageId = string;
export type ConversationId = string;
export type AgentId = string;

export const AgentRole = {
  Executor: "executor",
  Reviewer: "reviewer",
  Supervisor: "supervisor",
  Human: "human",
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export { ReviewStatus, Severity } from "#assentor/protocol/review-result.js";

/**
 * High-level task lifecycle status persisted in state (broader than FSM states).
 */
export const TaskStatus = {
  Pending: "PENDING",
  Running: "RUNNING",
  Blocked: "BLOCKED",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const BudgetKind = {
  Round: "round",
  Message: "message",
  ToolCall: "toolCall",
  RuntimeMs: "runtimeMs",
} as const;

export type BudgetKind = (typeof BudgetKind)[keyof typeof BudgetKind];

export interface BudgetLimits {
  maxRounds: number;
  maxMessages: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
}

export interface BudgetUsage {
  rounds: number;
  messages: number;
  toolCalls: number;
  runtimeMs: number;
}

export interface Budgets {
  limits: BudgetLimits;
  usage: BudgetUsage;
}

export interface AgentRef {
  id: AgentId;
  role: AgentRole;
  provider?: string;
}
