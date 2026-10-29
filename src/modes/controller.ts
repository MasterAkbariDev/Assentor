import { z } from "zod";
import { ModelIdSchema, SEAT_PERMISSIONS, SEAT_PROVIDERS, SeatRoleSchema } from "../core/seats.js";
import { LeadTaskPlanSchema, TaskIdSchema, type AgentReport, type TaskBoard } from "./lead/types.js";
import type { RosterEntry } from "./roster.js";

/**
 * Dynamic-mode controller contract (task T02B-01a). A controller seat (the
 * Lead) never acts directly: each turn it returns actions, and the engine
 * validates every action against policy, limits and budget before executing
 * it (T02B-02). Design: docs/plans/modes.md §4.2.
 */

/**
 * A seat the Lead wants to hire. `model` ends up as a CLI argument, so it must
 * pass `ModelIdSchema`. Policy (allowed providers, cost, `mock` only in tests)
 * is enforced by the engine (T02B-02), not here.
 */
export const SeatChoiceSchema = z.object({
  role: SeatRoleSchema,
  provider: z.enum(SEAT_PROVIDERS),
  model: ModelIdSchema.default("AUTO"),
  permissions: z.enum(SEAT_PERMISSIONS),
});

export const ControllerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plan_tasks"), tasks: z.array(LeadTaskPlanSchema).min(1).max(50) }),
  z.object({ action: z.literal("assign"), taskId: TaskIdSchema, seat: SeatChoiceSchema }),
  z.object({ action: z.literal("message"), seatId: z.string().min(1), text: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("request_report"), seatId: z.string().min(1) }),
  z.object({
    action: z.literal("review"),
    taskId: TaskIdSchema,
    team: z.string().min(1).max(64).optional(),
    policy: z.string().min(1).max(64).optional(),
  }),
  z.object({
    action: z.literal("escalate"),
    taskId: TaskIdSchema,
    model: ModelIdSchema,
    provider: z.enum(SEAT_PROVIDERS).optional(),
  }),
  z.object({ action: z.literal("reassign"), taskId: TaskIdSchema, seatId: z.string().min(1) }),
  z.object({ action: z.literal("split"), taskId: TaskIdSchema, tasks: z.array(LeadTaskPlanSchema).min(2).max(20) }),
  z.object({ action: z.literal("accept"), taskId: TaskIdSchema }),
  z.object({ action: z.literal("reject"), taskId: TaskIdSchema, reason: z.string().min(1).max(2000) }),
  z.object({ action: z.literal("integrate"), taskIds: z.array(TaskIdSchema).min(1).max(50) }),
  z.object({
    action: z.literal("ask_user"),
    question: z.string().min(1).max(2000),
    options: z.array(z.string().min(1).max(200)).max(6).optional(),
  }),
  z.object({ action: z.literal("retire"), seatId: z.string().min(1) }),
  z.object({ action: z.literal("finish"), summary: z.string().min(1).max(4000) }),
]);
export type ControllerAction = z.infer<typeof ControllerActionSchema>;
export type ControllerActionName = ControllerAction["action"];

export const CONTROLLER_ACTION_NAMES = ControllerActionSchema.options.map(
  (option) => option.shape.action.value,
) as ControllerActionName[];

/** One Lead turn's output. */
export const ControllerTurnSchema = z.object({
  actions: z.array(ControllerActionSchema).min(1).max(20),
  /** Short reasoning shown in the lead log. */
  note: z.string().max(2000).optional(),
});
export type ControllerTurn = z.infer<typeof ControllerTurnSchema>;

/** The engine's verdict on one action. Refused actions go back to the Lead next turn. */
export interface ControllerActionResult {
  action: ControllerAction;
  accepted: boolean;
  /** Why it was refused, or what happened (e.g. new seat id). */
  reason?: string;
}

/** One executed turn: the actions asked for and the engine's verdict on each, in order. Shown to the controller next turn. */
export interface ControllerTurnResult {
  turn: ControllerTurn;
  results: ControllerActionResult[];
}

/**
 * What the controller sees and can do each turn (implemented by T02B-02).
 * Limits, policy and budget live on the engine side behind `execute`; T02B-02
 * may add read-only views of them here.
 */
export interface ControllerContext {
  readonly sessionId: string;
  readonly goal: string;
  readonly board: TaskBoard;
  readonly roster: readonly RosterEntry[];
  /** Latest verified report per task id. */
  readonly reports: Readonly<Record<string, AgentReport>>;
  readonly signal: AbortSignal;
  /** Validate against policy/limits/budget, then execute. Never throws for a refused action. */
  execute(action: ControllerAction): Promise<ControllerActionResult>;
}
