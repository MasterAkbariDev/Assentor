import type { CapabilityProfile } from "./roster.js";

/**
 * Seed capability profiles for the roster (modes.md §4.4). Keys are
 * "provider/model" or "provider/*". Only these entries: no invented model ids.
 * Users override them with `mergeCapabilities`.
 */
export const DEFAULT_CAPABILITIES: CapabilityProfile[] = [
  // seed — user-editable
  { key: "claude-code/opus", strengths: ["coding", "reasoning", "ui", "review"], speed: "slow", cost: "high" },
  // seed — user-editable
  { key: "claude-code/sonnet", strengths: ["coding", "ui", "tests", "review"], speed: "medium", cost: "medium" },
  // seed — user-editable
  { key: "claude-code/haiku", strengths: ["tests", "docs"], speed: "fast", cost: "low" },
  // seed — user-editable
  { key: "codex/*", strengths: ["coding", "tests", "review"], speed: "medium", cost: "medium" },
  // seed — user-editable
  { key: "gemini/*", strengths: ["reasoning", "docs"], speed: "medium", cost: "medium" },
  // seed — user-editable
  { key: "antigravity/*", strengths: ["coding", "ui"], speed: "medium", cost: "medium" },
  // seed — user-editable
  { key: "cursor/*", strengths: ["coding", "ui"], speed: "medium", cost: "medium" },
  // seed — user-editable
  { key: "mock/*", strengths: [], speed: "fast", cost: "low" },
];

/**
 * Overrides replace defaults with the same key; new keys are appended. Neither
 * input is mutated. Overrides are expected to be validated by CapabilityProfileSchema.
 */
export function mergeCapabilities(
  defaults: readonly CapabilityProfile[],
  overrides: readonly CapabilityProfile[],
): CapabilityProfile[] {
  const byKey = new Map<string, CapabilityProfile>();
  for (const profile of defaults) {
    byKey.set(profile.key, profile);
  }
  for (const profile of overrides) {
    byKey.set(profile.key, profile);
  }
  return [...byKey.values()];
}
