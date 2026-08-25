import { z } from "zod";
import { ValidationError } from "./errors.js";

export const TaskContractSchema = z.object({
  goal: z.string().min(1),
  requirements: z.array(z.string()),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  nonGoals: z.array(z.string()),
  verificationPlan: z.array(z.string()),
});

export type TaskContract = z.infer<typeof TaskContractSchema>;

export function createEmptyContract(goal: string): TaskContract {
  const trimmed = goal.trim();
  if (!trimmed) {
    throw new ValidationError("Task contract goal must be non-empty");
  }

  return {
    goal: trimmed,
    requirements: [],
    constraints: [],
    acceptanceCriteria: [],
    nonGoals: [],
    verificationPlan: [],
  };
}

export function parseTaskContract(input: unknown): TaskContract {
  const result = TaskContractSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError("Invalid task contract", result.error.flatten());
  }
  return result.data;
}

/**
 * Appends unique acceptance criteria (case-sensitive exact match).
 * Existing criteria are preserved in order; new ones are appended.
 */
export function mergeAcceptanceCriteria(
  contract: TaskContract,
  criteria: string[],
): TaskContract {
  const seen = new Set(contract.acceptanceCriteria);
  const merged = [...contract.acceptanceCriteria];

  for (const item of criteria) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    merged.push(trimmed);
  }

  return {
    ...contract,
    acceptanceCriteria: merged,
  };
}

export function hasAcceptanceCriteria(contract: TaskContract): boolean {
  return contract.acceptanceCriteria.length > 0;
}
