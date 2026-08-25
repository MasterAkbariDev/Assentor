import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  BudgetKind,
  canSpend,
  createBudgets,
  isExhausted,
  remaining,
  spend,
  ValidationError,
} from "../../src/index.js";

describe("budgets", () => {
  it("creates budgets with defaults and overrides", () => {
    const budgets = createBudgets({ maxRounds: 3, maxMessages: 10 });
    expect(budgets.limits.maxRounds).toBe(3);
    expect(budgets.limits.maxMessages).toBe(10);
    expect(budgets.usage.rounds).toBe(0);
    expect(budgets.limits.maxToolCalls).toBe(200);
  });

  it("spends immutably within limits", () => {
    const start = createBudgets({ maxRounds: 2, maxMessages: 5 });
    const afterRound = spend(start, BudgetKind.Round);
    const afterMessages = spend(afterRound, BudgetKind.Message, 2);

    expect(start.usage.rounds).toBe(0);
    expect(afterRound.usage.rounds).toBe(1);
    expect(afterMessages.usage.messages).toBe(2);
    expect(remaining(afterMessages, BudgetKind.Round)).toBe(1);
    expect(remaining(afterMessages, BudgetKind.Message)).toBe(3);
  });

  it("reports canSpend accurately at the boundary", () => {
    let budgets = createBudgets({ maxRounds: 1 });
    expect(canSpend(budgets, BudgetKind.Round)).toBe(true);
    budgets = spend(budgets, BudgetKind.Round);
    expect(canSpend(budgets, BudgetKind.Round)).toBe(false);
    expect(isExhausted(budgets, BudgetKind.Round)).toBe(true);
  });

  it("throws BudgetExceededError when over limit", () => {
    const budgets = createBudgets({ maxToolCalls: 1 });
    const once = spend(budgets, BudgetKind.ToolCall);
    expect(() => spend(once, BudgetKind.ToolCall)).toThrow(BudgetExceededError);
  });

  it("tracks runtime ms spends", () => {
    const budgets = createBudgets({ maxRuntimeMs: 1000 });
    const next = spend(budgets, BudgetKind.RuntimeMs, 250);
    expect(next.usage.runtimeMs).toBe(250);
    expect(canSpend(next, BudgetKind.RuntimeMs, 750)).toBe(true);
    expect(canSpend(next, BudgetKind.RuntimeMs, 751)).toBe(false);
  });

  it("rejects negative spend amounts", () => {
    const budgets = createBudgets();
    expect(canSpend(budgets, BudgetKind.Message, -1)).toBe(false);
    expect(() => spend(budgets, BudgetKind.Message, -1)).toThrow(ValidationError);
  });
});
