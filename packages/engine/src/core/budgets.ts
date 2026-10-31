import { BudgetExceededError, ValidationError } from "./errors.js";
import type { BudgetKind, BudgetLimits, Budgets, BudgetUsage } from "./types.js";
import { BudgetKind as BudgetKindValues } from "./types.js";

const DEFAULT_LIMITS: BudgetLimits = {
  maxRounds: 8,
  maxMessages: 50,
  maxToolCalls: 200,
  maxRuntimeMs: 120 * 60 * 1000,
};

const ZERO_USAGE: BudgetUsage = {
  rounds: 0,
  messages: 0,
  toolCalls: 0,
  runtimeMs: 0,
};

export function createBudgets(limits: Partial<BudgetLimits> = {}): Budgets {
  return {
    limits: { ...DEFAULT_LIMITS, ...limits },
    usage: { ...ZERO_USAGE },
  };
}

function usageFor(kind: BudgetKind, usage: BudgetUsage): number {
  switch (kind) {
    case BudgetKindValues.Round:
      return usage.rounds;
    case BudgetKindValues.Message:
      return usage.messages;
    case BudgetKindValues.ToolCall:
      return usage.toolCalls;
    case BudgetKindValues.RuntimeMs:
      return usage.runtimeMs;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function limitFor(kind: BudgetKind, limits: BudgetLimits): number {
  switch (kind) {
    case BudgetKindValues.Round:
      return limits.maxRounds;
    case BudgetKindValues.Message:
      return limits.maxMessages;
    case BudgetKindValues.ToolCall:
      return limits.maxToolCalls;
    case BudgetKindValues.RuntimeMs:
      return limits.maxRuntimeMs;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Returns true if spending `amount` of `kind` would still be within limits.
 * Usage is compared as usage + amount <= limit (inclusive of remaining capacity).
 */
export function canSpend(
  budgets: Budgets,
  kind: BudgetKind,
  amount = 1,
): boolean {
  if (amount < 0) {
    return false;
  }
  const next = usageFor(kind, budgets.usage) + amount;
  return next <= limitFor(kind, budgets.limits);
}

/**
 * Returns a new Budgets with `amount` of `kind` applied.
 * Throws BudgetExceededError when the spend would exceed the limit.
 */
export function spend(
  budgets: Budgets,
  kind: BudgetKind,
  amount = 1,
): Budgets {
  if (amount < 0) {
    throw new ValidationError(`Budget spend amount must be >= 0, got ${amount}`);
  }

  if (!canSpend(budgets, kind, amount)) {
    const usage = usageFor(kind, budgets.usage);
    const limit = limitFor(kind, budgets.limits);
    throw new BudgetExceededError(kind, limit, usage + amount);
  }

  const usage: BudgetUsage = { ...budgets.usage };

  switch (kind) {
    case BudgetKindValues.Round:
      usage.rounds += amount;
      break;
    case BudgetKindValues.Message:
      usage.messages += amount;
      break;
    case BudgetKindValues.ToolCall:
      usage.toolCalls += amount;
      break;
    case BudgetKindValues.RuntimeMs:
      usage.runtimeMs += amount;
      break;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }

  return {
    limits: budgets.limits,
    usage,
  };
}

export function remaining(budgets: Budgets, kind: BudgetKind): number {
  return Math.max(0, limitFor(kind, budgets.limits) - usageFor(kind, budgets.usage));
}

export function isExhausted(budgets: Budgets, kind: BudgetKind): boolean {
  return remaining(budgets, kind) === 0;
}
