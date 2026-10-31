import { z } from "zod";
import { SeatRoleSchema } from "#assentor/protocol/seats.js";

/**
 * Lead (Supervisor) mode data contract (task T02B-01a).
 *
 * The Lead seat plans a task board, hires seats for tasks and reads their
 * reports. These schemas are shared by the board model (T02B-05), the report
 * parser (T02B-03), the controller (T02B-02) and UIs. Design: docs/plans/modes.md §4.
 */

// ---------------------------------------------------------------------------
// Tasks and the board
// ---------------------------------------------------------------------------

/**
 * backlog → assigned → in_progress → in_review → accepted | rejected.
 * `split` marks a task replaced by its children; `rejected` tasks can be
 * reassigned (back to `assigned`).
 */
export const LEAD_TASK_STATUSES = [
  "backlog",
  "assigned",
  "in_progress",
  "in_review",
  "accepted",
  "rejected",
  "split",
] as const;
export type LeadTaskStatus = (typeof LEAD_TASK_STATUSES)[number];

/**
 * Task ids are short, path-safe and git-ref-safe, e.g. "T3" or "T3.1" (they
 * may end up in worktree branch names). No "..", no trailing "." and no
 * ".lock" suffix. Boards compare ids case-insensitively.
 */
export const TaskIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, "task id must be 1-32 chars of A-Z a-z 0-9 . _ -")
  .refine((id) => !id.includes("..") && !id.endsWith(".") && !id.toLowerCase().endsWith(".lock"), {
    message: 'task id must not contain "..", end with "." or end with ".lock"',
  });

/**
 * A repo-relative path prefix a task owns, "/"-separated: `src/auth` or
 * `src/auth/login.ts`. Refused: absolute paths, drive letters, backslashes,
 * empty, "." or ".." segments, a trailing "/", and glob characters (`* ? [ ] { }`:
 * paths are literal prefixes, not patterns). So no task can claim the whole
 * repo with "." or "*", or escape it with "..". Compare case-insensitively
 * when checking overlap (macOS and Windows file systems are).
 */
export const OwnedPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes("\\") &&
      !/[*?[\]{}]/.test(value) &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    { message: 'owned path must be repo-relative with "/" separators and no empty, "." or ".." segments' },
  );

/** What the Lead writes when planning (no runtime fields). */
export const LeadTaskPlanSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  /** Checkable outcomes; reviewers and gates judge against these. */
  acceptance: z.array(z.string().min(1).max(500)).max(20).default([]),
  /**
   * Path prefixes this task may change. Parallel tasks (neither depends on the
   * other) must not overlap (T02B-05 enforces). Empty means the task owns no
   * paths: it is read-only, and the controller (T02B-02) refuses to give it an
   * `edit` seat.
   */
  ownedPaths: z.array(OwnedPathSchema).max(50).default([]),
  dependsOn: z.array(TaskIdSchema).max(50).default([]),
  /** Suggested role prompt id for the seat that does it. */
  role: SeatRoleSchema.optional(),
});
export type LeadTaskPlan = z.infer<typeof LeadTaskPlanSchema>;

export const LeadTaskSchema = LeadTaskPlanSchema.extend({
  status: z.enum(LEAD_TASK_STATUSES).default("backlog"),
  /** Seat id currently owning the task. */
  assignee: z.string().optional(),
  /** Set on tasks created by `split`. */
  parentId: TaskIdSchema.optional(),
  rejectionReason: z.string().max(2000).optional(),
  reassignCount: z.number().int().nonnegative().default(0),
  escalationCount: z.number().int().nonnegative().default(0),
});
export type LeadTask = z.infer<typeof LeadTaskSchema>;

/** Tasks in creation order. Ids are unique, compared case-insensitively ("t3" and "T3" collide). */
export const TaskBoardSchema = z
  .object({ tasks: z.array(LeadTaskSchema) })
  .superRefine((board, ctx) => {
    const seen = new Set<string>();
    board.tasks.forEach((task, index) => {
      const key = task.id.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "id"], message: `duplicate task id "${task.id}"` });
      }
      seen.add(key);
    });
  });
export type TaskBoard = z.infer<typeof TaskBoardSchema>;

export function emptyTaskBoard(): TaskBoard {
  return { tasks: [] };
}

/** Board operations (T02B-05 implements `applyBoardOp`). */
export const BoardOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("plan"), tasks: z.array(LeadTaskPlanSchema).min(1).max(50) }),
  z.object({ op: z.literal("assign"), taskId: TaskIdSchema, seatId: z.string().min(1) }),
  z.object({
    op: z.literal("status"),
    taskId: TaskIdSchema,
    status: z.enum(["in_progress", "in_review"]),
    /** True when this status change follows an escalation to a stronger model. */
    escalated: z.boolean().optional(),
  }),
  z.object({ op: z.literal("accept"), taskId: TaskIdSchema }),
  z.object({ op: z.literal("reject"), taskId: TaskIdSchema, reason: z.string().min(1).max(2000) }),
  z.object({ op: z.literal("reassign"), taskId: TaskIdSchema, seatId: z.string().min(1) }),
  z.object({ op: z.literal("split"), taskId: TaskIdSchema, tasks: z.array(LeadTaskPlanSchema).min(2).max(20) }),
]);
export type BoardOp = z.infer<typeof BoardOpSchema>;

// ---------------------------------------------------------------------------
// Agent reports
// ---------------------------------------------------------------------------

export const AGENT_REPORT_STATUSES = ["done", "in_progress", "blocked", "needs_input", "failed"] as const;
export type AgentReportStatus = (typeof AGENT_REPORT_STATUSES)[number];

/** What every agent ends a Lead-mode turn with (modes.md §4.3). Claims are verified, not trusted. */
export const AgentReportSchema = z.object({
  taskId: TaskIdSchema,
  status: z.enum(AGENT_REPORT_STATUSES),
  summary: z.string().min(1).max(4000),
  filesChanged: z.array(z.string().max(500)).max(500).default([]),
  testsRun: z.array(z.object({ command: z.string().min(1).max(500), passed: z.boolean() })).max(100).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  blockers: z.array(z.string().max(1000)).max(20).default([]),
  questions: z.array(z.string().max(1000)).max(20).default([]),
  suggestedNext: z.string().max(1000).optional(),
});
export type AgentReport = z.infer<typeof AgentReportSchema>;
