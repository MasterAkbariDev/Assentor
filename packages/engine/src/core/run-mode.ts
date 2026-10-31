import { z } from "zod";
import { AUTONOMY_LEVELS } from "#assentor/protocol/events.js";

export const RUN_MODES = ["supervised", "autopilot"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const DEFAULT_RUN_MODE: RunMode = "supervised";

export function parseRunMode(value: unknown): RunMode {
  if (typeof value === "string" && value.trim().toLowerCase() === "autopilot") {
    return "autopilot";
  }
  return "supervised";
}

export function isAutopilot(mode: RunMode | undefined): boolean {
  return mode === "autopilot";
}

export function formatRunMode(mode: RunMode | undefined): string {
  return mode === "autopilot" ? "Autopilot" : "Supervised";
}

/**
 * Autonomy: how much a session runs without asking the user. It is independent
 * of the mode (how seats are organized, see `src/modes/registry.ts`) and
 * replaces the old `run.mode` axis, whose two values are also autonomy levels.
 *
 * Precedence (highest first): CLI `--autonomy` (or the deprecated
 * `--mode supervised|autopilot` / `--autopilot`) > config `run.autonomy` >
 * legacy config `run.mode`. The config half is applied by the `run` schema, the
 * CLI half by `loadAssentorConfig` overrides.
 */
export { AUTONOMY_LEVELS };
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

/** Accepts any case and surrounding spaces; anything else is rejected, not defaulted. */
export const AutonomySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(AUTONOMY_LEVELS),
);

/** YAML `autonomy:` left empty (null) or blank means unset, not an invalid value. */
export function blankToUndefined(value: unknown): unknown {
  return value === null || (typeof value === "string" && value.trim() === "") ? undefined : value;
}

/**
 * The run mode the engine reads today (`config.run.mode`). `manual` has no engine
 * behaviour of its own yet, so it runs like `supervised` (never auto-steers).
 */
export function runModeForAutonomy(autonomy: Autonomy): RunMode {
  return autonomy === "autopilot" ? "autopilot" : "supervised";
}
