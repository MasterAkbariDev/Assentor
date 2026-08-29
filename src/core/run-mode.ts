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
