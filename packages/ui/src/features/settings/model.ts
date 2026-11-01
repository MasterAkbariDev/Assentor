import { AUTONOMY_LEVELS } from "#assentor/protocol/events.js";
import type { RpcParams, RpcResult } from "#assentor/protocol/rpc.js";
import { ModelIdSchema } from "#assentor/protocol/seats.js";

// Mirrors SELECTABLE_EXECUTOR_PROVIDERS and the routing enums in the engine; rpc.ts keeps its copies private.
export const EXECUTOR_PROVIDERS = ["mock", "cursor", "claude-code", "antigravity", "codex", "qwen", "opencode"] as const;
export const ROUTING_STRATEGIES = ["FREE_FIRST", "CHEAPEST", "BALANCED", "BEST", "CUSTOM"] as const;
export const REVIEW_STRATEGIES = ["SINGLE", "ADAPTIVE", "PANEL", "FULL"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];
export type ReviewStrategy = (typeof REVIEW_STRATEGIES)[number];

export const AUTONOMY_LABELS: Record<Autonomy, string> = { manual: "Manual", supervised: "Supervised", autopilot: "Autopilot" };
export const LIMIT_FIELDS = [
  { key: "maxRounds", label: "Max rounds" },
  { key: "maxMessages", label: "Max messages" },
  { key: "maxRuntimeMinutes", label: "Max runtime (minutes)" },
  { key: "maxToolCalls", label: "Max tool calls" },
] as const;
export const GIT_FIELDS = [
  { key: "checkpoints", label: "Checkpoints" },
  { key: "autoCommit", label: "Auto-commit" },
] as const;
export const ARTIFACT_FIELDS = [
  { key: "diff", label: "Diff" },
  { key: "tests", label: "Tests" },
  { key: "logs", label: "Logs" },
  { key: "screenshots", label: "Screenshots" },
] as const;

export type LimitKey = (typeof LIMIT_FIELDS)[number]["key"];

export type SettingsView = RpcResult<"settings.get">["settings"];
export type SettingsPatch = RpcParams<"settings.save">["settings"];
export type KeySummary = RpcResult<"settings.get">["keys"][number];

/** The editable fields as the form holds them: limits are text, as typed. */
export interface SettingsForm {
  executor: { provider: string; model: string };
  run: { autonomy: Autonomy };
  routing: { strategy: RoutingStrategy; reviewStrategy: ReviewStrategy };
  limits: Record<LimitKey, string>;
  git: Record<"checkpoints" | "autoCommit", boolean>;
  artifacts: Record<"diff" | "tests" | "logs" | "screenshots", boolean>;
}

/** Field path (`limits.maxRounds`) to message. */
export type FieldErrors = Record<string, string>;

export function toForm(settings: SettingsView): SettingsForm {
  return {
    executor: { provider: settings.executor.provider, model: settings.executor.model ?? "" },
    run: { autonomy: settings.run.autonomy },
    routing: { strategy: settings.routing.strategy, reviewStrategy: settings.routing.reviewStrategy },
    limits: Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, String(settings.limits[key])])) as Record<LimitKey, string>,
    git: { checkpoints: settings.git.checkpoints, autoCommit: settings.git.autoCommit },
    artifacts: { ...settings.artifacts },
  };
}

const isWholeNumber = (text: string): boolean => {
  const value = Number(text.trim());
  return /^\d+$/.test(text.trim()) && Number.isSafeInteger(value) && value >= 1;
};

export function validate(form: SettingsForm, original: SettingsForm): FieldErrors {
  const errors: FieldErrors = {};
  const model = form.executor.model.trim();
  if (model === "") {
    // The patch cannot unset a model, so a blank field would be silently ignored.
    if (original.executor.model !== "") errors["executor.model"] = "A model is set. Type AUTO to use the provider's default.";
  } else {
    const result = ModelIdSchema.safeParse(model);
    if (!result.success) errors["executor.model"] = result.error.issues[0]?.message ?? "Not a valid model id.";
  }
  for (const { key, label } of LIMIT_FIELDS) {
    if (!isWholeNumber(form.limits[key])) errors[`limits.${key}`] = `${label}: enter a whole number of at least 1.`;
  }
  return errors;
}

/** The keys that changed, or undefined when none did. */
function changedKeys<T extends object>(next: T, prev: T): Partial<T> | undefined {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (next[key] !== prev[key]) out[key] = next[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Only the fields that differ from `original`, in the shape `settings.save` takes. Assumes `validate` passed. */
export function buildPatch(form: SettingsForm, original: SettingsForm): SettingsPatch {
  const patch: SettingsPatch = {};
  const executor: NonNullable<SettingsPatch["executor"]> = {};
  if (form.executor.provider !== original.executor.provider) executor.provider = form.executor.provider as (typeof EXECUTOR_PROVIDERS)[number];
  const model = form.executor.model.trim();
  if (model !== "" && model !== original.executor.model) executor.model = model;
  if (Object.keys(executor).length > 0) patch.executor = executor;
  if (form.run.autonomy !== original.run.autonomy) patch.run = { autonomy: form.run.autonomy };
  const routing = changedKeys(form.routing, original.routing);
  if (routing) patch.routing = routing;
  const limits: NonNullable<SettingsPatch["limits"]> = {};
  for (const { key } of LIMIT_FIELDS) {
    if (form.limits[key].trim() !== original.limits[key]) limits[key] = Number(form.limits[key].trim());
  }
  if (Object.keys(limits).length > 0) patch.limits = limits;
  const git = changedKeys(form.git, original.git);
  if (git) patch.git = git;
  const artifacts = changedKeys(form.artifacts, original.artifacts);
  if (artifacts) patch.artifacts = artifacts;
  return patch;
}

/**
 * The login command to copy, by CLI id, from the engine's own preflight and install notes.
 * CLIs without a documented command get no copy button.
 */
export const LOGIN_HINTS: Record<string, string> = {
  "claude-code": "claude",
  cursor: "agent login",
  antigravity: "agy",
};

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
