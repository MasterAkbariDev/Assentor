import { z } from "zod";
import type { AssentorConfig } from "../../config/schema.js";
import { ModelIdSchema, SEAT_PROVIDERS } from "#assentor/protocol/seats.js";
import { RosterPolicySchema } from "../roster.js";

// Browser-safe (the registry validates with it); the controller lives in ./controller.ts.

/** `StageSpec.strategy` of the stages the Lead hands `deps.createExecutor`; `options.seat` is the hired `Seat`. */
export const LEAD_AGENT_STRATEGY = "lead-agent";

const SeatModelSchema = z.object({ provider: z.enum(SEAT_PROVIDERS), model: ModelIdSchema.default("AUTO") }).strict();

/** `modes.lead` (T02B-02, modes.md §4.6). */
export const LeadConfigSchema = z
  .object({
    /** The lead seat (read-only). Required: there is no default lead model yet. */
    lead: SeatModelSchema,
    /** Cheap seat that folds old log entries into the rolling summary. Without it the oldest entries are cut. */
    summarizer: SeatModelSchema.optional(),
    /** Who the lead may hire, on top of what the host's roster offers. */
    roster: RosterPolicySchema.strict().default({}),
    limits: z
      .object({
        maxSeats: z.number().int().min(1).max(16).default(6),
        maxTasks: z.number().int().min(1).max(50).default(20),
        maxReassignPerTask: z.number().int().min(0).max(10).default(2),
        maxEscalationsPerTask: z.number().int().min(0).max(10).default(2),
        maxLeadTurns: z.number().int().min(1).max(200).default(40),
        /** Refused actions before the user is asked whether to go on. */
        maxInvalidActions: z.number().int().min(1).max(50).default(5),
        leadTurnTimeoutMinutes: z.number().int().min(1).max(120).default(10),
        taskTimeoutMinutes: z.number().int().min(1).max(1440).default(60),
      })
      .strict()
      .default({}),
    policy: z
      .object({
        /** `auto` integrates without asking, and only under autopilot. */
        integrate: z.enum(["approve", "auto"]).default("approve"),
        /** `accept` needs a PASS from a `review` of the task's latest run. */
        reviewBeforeAccept: z.boolean().default(true),
        /** Team for `review` when the action names none (else the host's default reviewer). */
        reviewTeam: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type LeadConfig = z.infer<typeof LeadConfigSchema>;

/** Problems with `modes.lead`, or `[]`. */
export function leadConfigProblems(config: AssentorConfig): string[] {
  const parsed = LeadConfigSchema.safeParse(config.modes.lead);
  if (!parsed.success) {
    return config.modes.lead === undefined
      ? ["lead mode needs modes.lead with at least lead: { provider, model } in the config"]
      : parsed.error.issues.map((issue) => `modes.lead.${issue.path.join(".")}: ${issue.message}`);
  }
  const team = parsed.data.policy.reviewTeam;
  return team && !config.teams[team] ? [`modes.lead.policy.reviewTeam: unknown team "${team}"`] : [];
}

