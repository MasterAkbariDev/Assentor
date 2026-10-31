import { expandSeatSpecs } from "#assentor/protocol/seats.js";
import { resolveTeams } from "../../config/teams.js";
import type { AssentorConfig } from "../../config/schema.js";
import type { ModeDefinition } from "../registry.js";
import { selectTddSeats, TddModeSchema } from "./config.js";

/**
 * TDD mode (T02B-11): one execute stage with `strategy: "tdd"` plus the panel review, like solo.
 * The red → green → tamper flow lives in the stage's executor (`createTddExecutor`, `./executor.ts`);
 * the host must return it from `createExecutor` for that strategy.
 */

/** `modes.tdd` problems: shape, the team and its seats, and the review team. */
function validate(config: AssentorConfig): string[] {
  const section = config.modes.tdd;
  if (!section) return ["tdd mode needs modes.tdd with a team (one test-writer seat and one coder seat)"];
  const parsed = TddModeSchema.safeParse(section);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `modes.tdd.${i.path.join(".") || "(section)"}: ${i.message}`);
  }
  const problems: string[] = [];
  const team = Object.hasOwn(config.teams, parsed.data.team) ? config.teams[parsed.data.team] : undefined;
  if (!team) {
    problems.push(`modes.tdd.team: unknown team "${parsed.data.team}" (defined: ${Object.keys(config.teams).join(", ") || "(none)"})`);
  } else {
    const seats = selectTddSeats(expandSeatSpecs(team.seats, { teamName: parsed.data.team }));
    if (typeof seats === "string") problems.push(`modes.tdd.team "${parsed.data.team}": ${seats}`);
  }
  try {
    resolveTeams(config);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

export const tddRuntime: Pick<ModeDefinition, "validate" | "buildSession"> = {
  validate,
  buildSession: ({ goal, title, config }) => {
    const { team, ...options } = TddModeSchema.parse(config.modes.tdd);
    const review = config.modes.review;
    return {
      title,
      goal,
      stages: [
        { id: "tdd", kind: "execute", strategy: "tdd", team, options, next: "review" },
        {
          id: "review",
          kind: "review",
          strategy: "panel",
          ...(review ? { team: review.team } : {}),
          options: review?.tiebreak === "negotiate" ? { tiebreak: "negotiate" } : {},
        },
      ],
    };
  },
};
