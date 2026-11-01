import type { AUTONOMY_LEVELS } from "#assentor/protocol/events.js";

type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/**
 * The mode cards. There is no `modes.list` RPC yet, and the registry
 * (`packages/engine/src/modes/registry.ts`) pulls in Node modules, so the browser
 * keeps this literal copy. `modeCatalog.test.ts` fails when it drifts from `listModes()`.
 */
export interface ModeCard {
  id: string;
  title: string;
  /** One line, without the engine's "Not runnable yet" note. */
  description: string;
  kind: "static" | "dynamic";
  editsCode: boolean;
  /** True only when the engine can run the mode from a session. */
  available: boolean;
  /** Why an unavailable mode cannot run: the engine's note, or `UNAVAILABLE_REASON`. Absent when available. */
  reason?: string;
  defaultAutonomy: AutonomyLevel;
}

/** Fallback for an unavailable mode whose engine description carries no "Not runnable yet" note. */
export const UNAVAILABLE_REASON = "Not available yet: the engine cannot run this mode from a session.";

const S = "supervised" as const;
const DEP_NOTE = "Not runnable yet: new worktrees get no dependency install before its gates.";

export const MODE_CATALOG: readonly ModeCard[] = [
  { id: "solo", title: "Solo", description: "One executor with a review loop; today's assentor run.", kind: "static", editsCode: true, available: true, defaultAutonomy: S },
  { id: "review", title: "Review", description: "Several reviewers judge existing work; a policy merges their verdicts.", kind: "static", editsCode: false, available: true, defaultAutonomy: S },
  { id: "negotiate", title: "Negotiate", description: "Several peers reach consensus with a strategy (vote, debate, synthesize).", kind: "static", editsCode: true, available: true, defaultAutonomy: S },
  { id: "lead", title: "Lead (Supervisor)", description: "A lead seat plans tasks, picks agents and accepts or rejects their reports.", kind: "dynamic", editsCode: true, available: false, reason: DEP_NOTE, defaultAutonomy: S },
  { id: "cascade", title: "Cascade", description: "Start with a cheap model; escalate on failure or risk.", kind: "dynamic", editsCode: true, available: true, defaultAutonomy: S },
  { id: "pipeline", title: "Pipeline", description: "Requirements, architect, coder, tester, reviewer and docs stages in order.", kind: "static", editsCode: true, available: true, defaultAutonomy: S },
  { id: "pair", title: "Pair", description: "A driver codes while a navigator watches the stream and interjects.", kind: "dynamic", editsCode: true, available: false, reason: DEP_NOTE, defaultAutonomy: S },
  { id: "race", title: "Race", description: "Several seats implement in parallel worktrees; a judge picks one.", kind: "static", editsCode: true, available: false, reason: UNAVAILABLE_REASON, defaultAutonomy: S },
  { id: "redteam", title: "Red team", description: "An attacker writes failing tests or exploits; a builder fixes; repeat.", kind: "dynamic", editsCode: true, available: false, reason: DEP_NOTE, defaultAutonomy: S },
  { id: "tdd", title: "TDD", description: "Failing tests first, then code that passes them without touching the tests.", kind: "static", editsCode: true, available: false, reason: DEP_NOTE, defaultAutonomy: S },
  { id: "swarm", title: "Swarm", description: "Many small independent items split across cheap seats, then merged.", kind: "dynamic", editsCode: true, available: false, reason: DEP_NOTE, defaultAutonomy: S },
  { id: "debug", title: "Debug", description: "Seats test competing hypotheses in their own worktrees; evidence picks the fix.", kind: "dynamic", editsCode: true, available: false, reason: DEP_NOTE, defaultAutonomy: S },
  { id: "explore", title: "Explore", description: "Read-only seats investigate a question; a synthesizer answers with citations.", kind: "static", editsCode: false, available: true, defaultAutonomy: S },
  { id: "plan", title: "Plan", description: "Produce a spec and task cards, no code.", kind: "static", editsCode: true, available: true, defaultAutonomy: S },
  { id: "interactive", title: "Interactive", description: "Chat with the team; a lead routes messages to seats.", kind: "dynamic", editsCode: true, available: false, reason: UNAVAILABLE_REASON, defaultAutonomy: S },
  { id: "auto", title: "Auto", description: "Suggest a mode from the task and ask before running it.", kind: "dynamic", editsCode: true, available: false, reason: UNAVAILABLE_REASON, defaultAutonomy: S },
  { id: "watch", title: "Watch", description: "React to commits, PRs or CI failures by running a chosen mode.", kind: "static", editsCode: true, available: false, reason: UNAVAILABLE_REASON, defaultAutonomy: S },
];
