import { z } from "zod";
import type { Autonomy } from "../core/run-mode.js";

/**
 * Mode registry — METADATA ONLY (T02B-01b). A mode decides how seats are organized
 * and who decides the next step; autonomy (`src/core/run-mode.ts`) is the separate
 * axis for how much it runs without asking. Catalog: docs/plans/modes.md §3.
 *
 * Not here yet: `buildSession(input)` for static modes arrives with the stage-graph
 * runner (T02-09), `createController(input)` for dynamic modes with the Lead
 * controller (T02B-02), and per-mode config validation with T02B-01 (`modes.<id>`).
 * Until then `available` says whether `assentor run` can actually run the mode.
 */

/** Ids in modes.md §3 catalog order. */
export const MODE_IDS = [
  "solo",
  "review",
  "negotiate",
  "lead",
  "cascade",
  "pipeline",
  "pair",
  "race",
  "redteam",
  "tdd",
  "swarm",
  "debug",
  "explore",
  "plan",
  "interactive",
  "auto",
  "watch",
] as const;
export type ModeId = (typeof MODE_IDS)[number];

/** Accepted spellings that resolve to a canonical id (modes.md §1). */
export const MODE_ALIASES: Readonly<Record<string, ModeId>> = { supervisor: "lead" };

/** Mode id from user input: trims, lowercases and resolves aliases; rejects unknown ids. */
export const ModeIdSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const id = value.trim().toLowerCase();
  return MODE_ALIASES[id] ?? id;
}, z.enum(MODE_IDS));

export interface ModeDefinition {
  id: ModeId;
  /** Display name, e.g. "Lead (Supervisor)". */
  title: string;
  /** One line for lists and help. */
  description: string;
  /** static: a fixed stage graph decides the next step; dynamic: a controller seat or router does (modes.md §2). */
  kind: "static" | "dynamic";
  defaultAutonomy: Autonomy;
  /** May change files in the user's project. Conservative: "optional" or "configurable" count as true. */
  editsCode: boolean;
  /** True only when `assentor run --mode <id>` can run it today; otherwise it fails before any work. */
  available: boolean;
}

function mode(
  id: ModeId,
  title: string,
  description: string,
  kind: ModeDefinition["kind"],
  editsCode: boolean,
  available = false,
): ModeDefinition {
  return { id, title, description, kind, defaultAutonomy: "supervised", editsCode, available };
}

const MODES: readonly ModeDefinition[] = [
  // Today's `assentor run`: one executor in a review loop (one reviewer or a `--team` panel).
  mode("solo", "Solo", "One executor with a review loop; today's assentor run.", "static", true, true),
  // A panel exists only inside solo (`run --team`); a review-only session that edits nothing needs T02-09.
  mode("review", "Review", "Several reviewers judge existing work; a policy merges their verdicts.", "static", false),
  // Engine and strategies exist (T02-03/04/07) but nothing in the CLI drives them until T02-09.
  mode("negotiate", "Negotiate", "Several peers reach consensus with a strategy (vote, debate, synthesize).", "static", true),
  mode("lead", "Lead (Supervisor)", "A lead seat plans tasks, picks agents and accepts or rejects their reports.", "dynamic", true),
  mode("cascade", "Cascade", "Start with a cheap model; escalate on failure or risk.", "dynamic", true),
  mode("pipeline", "Pipeline", "Requirements, architect, coder, tester, reviewer and docs stages in order.", "static", true),
  mode("pair", "Pair", "A driver codes while a navigator watches the stream and interjects.", "static", true),
  mode("race", "Race", "Several seats implement in parallel worktrees; a judge picks one.", "static", true),
  mode("redteam", "Red team", "An attacker writes failing tests or exploits; a builder fixes; repeat.", "static", true),
  mode("tdd", "TDD", "Failing tests first, then code that passes them without touching the tests.", "static", true),
  mode("swarm", "Swarm", "Many small independent items split across cheap seats, then merged.", "static", true),
  mode("debug", "Debug", "Seats test competing hypotheses in their own worktrees; evidence picks the fix.", "static", true),
  mode("explore", "Explore", "Read-only seats investigate a question; a synthesizer answers with citations.", "static", false),
  mode("plan", "Plan", "Produce a spec and task cards, no code.", "static", true),
  mode("interactive", "Interactive", "Chat with the team; a lead routes messages to seats.", "dynamic", true),
  mode("auto", "Auto", "Suggest a mode from the task and ask before running it.", "dynamic", true),
  mode("watch", "Watch", "React to commits, PRs or CI failures by running a chosen mode.", "static", true),
];

const BY_ID = new Map(MODES.map((m) => [m.id, m]));

/** Every mode in catalog order, available or not. */
export function listModes(): readonly ModeDefinition[] {
  return MODES;
}

/** The mode for an id or alias (`supervisor` → `lead`), any case; undefined when unknown. */
export function getMode(id: string): ModeDefinition | undefined {
  const parsed = ModeIdSchema.safeParse(id);
  return parsed.success ? BY_ID.get(parsed.data) : undefined;
}
