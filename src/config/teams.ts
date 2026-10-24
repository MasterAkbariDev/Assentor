import { z } from "zod";
import {
  normalizeSeatProvider,
  TeamSchema,
  type SeatSpecInput,
  type Team,
} from "../core/seats.js";
import type { AssentorConfig } from "./schema.js";

/** Negotiate-mode strategies. `debate` is the default. */
export const NEGOTIATE_STRATEGIES = [
  "debate",
  "vote",
  "best-of-n",
  "synthesize",
  "divide",
] as const;

/** Config for `modes.negotiate`: which team negotiates and how. */
export const NegotiateModeSchema = z.object({
  /** Name of a key in `teams`. */
  team: z.string().min(1),
  strategy: z.enum(NEGOTIATE_STRATEGIES).default("debate"),
  /** Maximum negotiation rounds, 1–10. */
  maxRounds: z.number().int().min(1).max(10).default(3),
  /** Agreement threshold, 0–1. */
  consensus: z.number().min(0).max(1).default(0.7),
});
export type NegotiateMode = z.infer<typeof NegotiateModeSchema>;

/** Config for `modes.review`: which team reviews and how verdicts combine. */
export const ReviewModeSchema = z.object({
  /** Name of a key in `teams`. */
  team: z.string().min(1),
  policy: z
    .enum(["majority", "unanimous", "weighted", "security-veto", "adjudicator"])
    .default("security-veto"),
  tiebreak: z.enum(["adjudicator", "negotiate"]).default("adjudicator"),
});
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

/** Result of `resolveTeams`: the team that executes and the team that reviews. */
export interface ResolvedTeams {
  executor: Team;
  review: Team;
}

/**
 * Resolve the executor and review teams for a config.
 *
 * - `executor`: one `edit` seat for `config.executor.provider`, role `engineer`.
 * - `review`: the team named by `modes.review.team` when it is set; otherwise
 *   one `read-only` seat per entry in `config.reviewers` (legacy mapping).
 *
 * Throws when a mode names a team that is not in `config.teams`.
 */
export function resolveTeams(config: AssentorConfig): ResolvedTeams {
  assertModeTeamsDefined(config);

  const executor = TeamSchema.parse({
    seats: [
      {
        provider: seatProviderFor(
          config.executor.provider,
          `executor "${config.executor.provider}"`,
        ),
        count: 1,
        permissions: "edit",
        role: "engineer",
      },
    ],
  });

  const reviewTeamName = config.modes.review?.team;
  const namedReview =
    reviewTeamName === undefined
      ? undefined
      : config.teams[reviewTeamName];
  const review =
    namedReview ??
    TeamSchema.parse({ seats: config.reviewers.map(legacyReviewerSeat) });

  return { executor, review };
}

function legacyReviewerSeat(
  reviewer: AssentorConfig["reviewers"][number],
): SeatSpecInput {
  return {
    provider: seatProviderFor(reviewer.provider, `reviewer "${reviewer.provider}"`),
    transport: reviewer.transport,
    model: reviewer.model ?? "AUTO",
    role: reviewer.role,
    ...(reviewer.name ? { name: reviewer.name } : {}),
    count: 1,
    permissions: "read-only",
  };
}

function seatProviderFor(value: string, label: string) {
  const provider = normalizeSeatProvider(value);
  if (!provider) {
    throw new Error(`Cannot map ${label} to a seat provider`);
  }
  return provider;
}

function assertModeTeamsDefined(config: AssentorConfig): void {
  const modes = [
    ["negotiate", config.modes.negotiate?.team],
    ["review", config.modes.review?.team],
  ] as const;
  for (const [mode, team] of modes) {
    if (team === undefined || Object.prototype.hasOwnProperty.call(config.teams, team)) {
      continue;
    }
    const defined = Object.keys(config.teams);
    throw new Error(
      `Unknown team "${team}" in modes.${mode}. Defined teams: ${
        defined.length > 0 ? defined.join(", ") : "(none)"
      }`,
    );
  }
}
