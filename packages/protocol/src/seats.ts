import { z } from "zod";

/**
 * Seat / Team / Session contract (task T00-01).
 *
 * A **seat** is one running model instance. `3 × claude-code/opus` is three
 * seats with the same provider and model but separate ids, CLI sessions and
 * (when editing) separate worktrees. A **team** is a saved list of seat specs;
 * a **session** is a graph of **stages** that each use a team.
 *
 * This module is types + schemas + pure helpers only. Nothing here spawns
 * processes or touches disk.
 */

// ---------------------------------------------------------------------------
// Providers & transports
// ---------------------------------------------------------------------------

/** Providers reached through a local coding CLI. */
export const SEAT_CLI_PROVIDERS = [
  "claude-code",
  "codex",
  "antigravity",
  "cursor",
  "qwen",
  "opencode",
] as const;

/** Providers reached through an HTTP API with a vault/env key. */
export const SEAT_API_PROVIDERS = ["gemini", "openai"] as const;

/** Every provider a seat may use. `mock` is offline and allowed on both transports. */
export const SEAT_PROVIDERS = [
  ...SEAT_CLI_PROVIDERS,
  ...SEAT_API_PROVIDERS,
  "mock",
] as const;

export type SeatCliProvider = (typeof SEAT_CLI_PROVIDERS)[number];
export type SeatApiProvider = (typeof SEAT_API_PROVIDERS)[number];
export type SeatProvider = (typeof SEAT_PROVIDERS)[number];
export type SeatTransport = "cli" | "api";

/**
 * Aliases accepted in config. Note `gemini` stays the API provider here —
 * unlike executor aliases, where `gemini` means the Antigravity CLI.
 */
const SEAT_PROVIDER_ALIASES: Record<string, SeatProvider> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  antigravity: "antigravity",
  agy: "antigravity",
  "gemini-cli": "antigravity",
  "google-antigravity": "antigravity",
  cursor: "cursor",
  "cursor-agent": "cursor",
  agent: "cursor",
  qwen: "qwen",
  "qwen-code": "qwen",
  opencode: "opencode",
  gemini: "gemini",
  openai: "openai",
  mock: "mock",
};

/** Map a config spelling to a canonical seat provider, or `undefined` if unknown. */
export function normalizeSeatProvider(value: string): SeatProvider | undefined {
  return SEAT_PROVIDER_ALIASES[value.trim().toLowerCase()];
}

/** Transports a provider supports; the first entry is the default. */
export function transportsForSeatProvider(
  provider: SeatProvider,
): SeatTransport[] {
  if (provider === "mock") {
    return ["api", "cli"];
  }
  return (SEAT_API_PROVIDERS as readonly string[]).includes(provider)
    ? ["api"]
    : ["cli"];
}

export function defaultSeatTransport(provider: SeatProvider): SeatTransport {
  return transportsForSeatProvider(provider)[0]!;
}

const PROVIDER_DISPLAY: Record<SeatProvider, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  qwen: "Qwen",
  opencode: "OpenCode",
  gemini: "Gemini",
  openai: "OpenAI",
  mock: "Mock",
};

export function formatSeatProvider(provider: SeatProvider): string {
  return PROVIDER_DISPLAY[provider];
}

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

/** Built-in roles that produce work (prompts ship in Phase 3, T03-02). */
export const BUILTIN_BUILDER_ROLES = [
  "planner",
  "architect",
  "engineer",
  "refactorer",
  "debugger",
  "test-writer",
  "docs-writer",
  "devops",
  "db-migrations",
  "requirements-analyst",
  "integrator",
] as const;

/** Built-in reviewer and meta roles (prompts ship in Phase 3, T03-03). */
export const BUILTIN_REVIEW_ROLES = [
  "code-reviewer",
  "security-reviewer",
  "performance-reviewer",
  "ux-reviewer",
  "test-reviewer",
  "architecture-reviewer",
  "devils-advocate",
  "moderator",
  "judge",
  "summarizer",
] as const;

export const BUILTIN_SEAT_ROLES = [
  ...BUILTIN_BUILDER_ROLES,
  ...BUILTIN_REVIEW_ROLES,
] as const;

export type BuiltinSeatRole = (typeof BUILTIN_SEAT_ROLES)[number];

/**
 * A role is a prompt id: kebab-case, built-in or user-defined.
 * Legacy reviewer roles (`general`, `security`, …) are valid ids too.
 */
export type SeatRole = string;

export const SEAT_ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SeatRoleSchema = z
  .string()
  .regex(SEAT_ROLE_PATTERN, "role must be a kebab-case id (e.g. security-reviewer)");

/**
 * A model id that is safe to pass to a CLI as an argument value: `AUTO`, or a
 * plain id like `opus`, `gpt-5`, `anthropic/claude-sonnet`, `gemini-2.5-flash`.
 * Never starts with `-` (it could be read as a flag). Use it wherever a model
 * choice comes from a model (e.g. the Lead controller), not only from config.
 */
export const MODEL_ID_PATTERN = /^(AUTO|[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/;
export const ModelIdSchema = z
  .string()
  .regex(MODEL_ID_PATTERN, "model must be AUTO or an id of letters, digits and . _ : / - (not starting with -)");

/**
 * `read-only` seats never receive bypass/unattended flags and never get a
 * writable worktree. `edit` seats work inside their own worktree.
 */
export const SEAT_PERMISSIONS = ["read-only", "edit"] as const;
export type SeatPermissions = (typeof SEAT_PERMISSIONS)[number];

// ---------------------------------------------------------------------------
// Seat spec (config shape) and Seat (runtime shape)
// ---------------------------------------------------------------------------

export const SEAT_MAX_COUNT = 8;

export const SeatBudgetSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  maxRuntimeMinutes: z.number().int().positive().optional(),
});
export type SeatBudget = z.infer<typeof SeatBudgetSchema>;

const SeatProviderSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? (normalizeSeatProvider(value) ?? value) : value,
  z.enum(SEAT_PROVIDERS),
);

/**
 * One entry in a team. `count > 1` expands to several seats with the same
 * settings (see `expandSeatSpecs`).
 */
export const SeatSpecSchema = z
  .object({
    provider: SeatProviderSchema,
    /** Omit to use the provider's default transport. */
    transport: z.enum(["cli", "api"]).optional(),
    /** Model id or `AUTO` (provider default). Free text; validated by the catalog, not here. */
    model: z.string().min(1).default("AUTO"),
    role: SeatRoleSchema.default("general"),
    /** Prompt id to use instead of the role's default prompt. */
    promptRef: SeatRoleSchema.optional(),
    count: z.number().int().min(1).max(SEAT_MAX_COUNT).default(1),
    permissions: z.enum(SEAT_PERMISSIONS).default("read-only"),
    /** Display-name base, e.g. `Sol` → `Sol#1`. Defaults to the model short name. */
    name: z.string().trim().min(1).max(32).optional(),
    budget: SeatBudgetSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    if (
      spec.transport &&
      !transportsForSeatProvider(spec.provider).includes(spec.transport)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transport"],
        message: `${spec.provider} does not support transport "${spec.transport}" (supported: ${transportsForSeatProvider(spec.provider).join(", ")})`,
      });
    }
  });

/** Parsed seat spec (defaults applied). */
export type SeatSpec = z.infer<typeof SeatSpecSchema>;
/** Seat spec as written in config (defaults optional). */
export type SeatSpecInput = z.input<typeof SeatSpecSchema>;

export const TeamSchema = z.object({
  description: z.string().optional(),
  seats: z.array(SeatSpecSchema).min(1),
});
export type Team = z.infer<typeof TeamSchema>;
export type TeamInput = z.input<typeof TeamSchema>;

/** A concrete seat produced by expanding a `SeatSpec`. */
export interface Seat {
  /** Stable, path-safe id unique within one expansion, e.g. `opus-2` or `review-panel.opus-2`. */
  id: string;
  /** Human label shown in UI and logs, e.g. `Opus#2`. */
  displayName: string;
  /** 1-based number shown after `#`. */
  ordinal: number;
  teamName?: string;
  provider: SeatProvider;
  transport: SeatTransport;
  model: string;
  role: SeatRole;
  promptRef?: string;
  permissions: SeatPermissions;
  budget?: SeatBudget;
  /** Set by the worktree manager (T02-01) for `edit` seats. */
  worktreePath?: string;
  /** CLI conversation/session id once the seat has run. */
  sessionId?: string;
}

export interface ExpandSeatOptions {
  /** Prefixes ids as `<teamName>.<seat>` and is copied onto each seat. */
  teamName?: string;
}

/**
 * Short, human model label: last path segment, first letter upper-cased.
 * `opus` → `Opus`, `anthropic/claude-sonnet` → `Claude-sonnet`.
 * `AUTO` falls back to the provider label (`Claude`, `Codex`, …).
 */
export function modelShortName(provider: SeatProvider, model: string): string {
  const trimmed = model.trim();
  if (!trimmed || trimmed.toUpperCase() === "AUTO") {
    return formatSeatProvider(provider);
  }
  const last = trimmed.split("/").filter(Boolean).pop() ?? trimmed;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "seat";
}

/**
 * Expand seat specs into concrete seats. Deterministic: the same input always
 * yields the same ids and names. Numbering is per display-name base across all
 * specs, so two specs that both resolve to `Opus` produce `Opus#1..#n` without
 * collisions.
 *
 * Accepts raw input too; it is parsed with `SeatSpecSchema` (throws ZodError on
 * invalid specs).
 */
export function expandSeatSpecs(
  specs: readonly SeatSpecInput[],
  options: ExpandSeatOptions = {},
): Seat[] {
  const counters = new Map<string, number>();
  const usedIds = new Set<string>();
  const seats: Seat[] = [];

  for (const input of specs) {
    const spec = SeatSpecSchema.parse(input);
    const base = spec.name ?? modelShortName(spec.provider, spec.model);
    const transport = spec.transport ?? defaultSeatTransport(spec.provider);

    for (let i = 0; i < spec.count; i += 1) {
      const ordinal = (counters.get(base) ?? 0) + 1;
      counters.set(base, ordinal);

      let localId = `${slugify(base)}-${ordinal}`;
      // Distinct bases can slugify to the same id ("Opus" vs "opus"); keep ids unique.
      let suffix = 2;
      while (usedIds.has(localId)) {
        localId = `${slugify(base)}-${ordinal}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(localId);

      seats.push({
        id: options.teamName ? `${slugify(options.teamName)}.${localId}` : localId,
        displayName: `${base}#${ordinal}`,
        ordinal,
        ...(options.teamName ? { teamName: options.teamName } : {}),
        provider: spec.provider,
        transport,
        model: spec.model,
        role: spec.role,
        ...(spec.promptRef ? { promptRef: spec.promptRef } : {}),
        permissions: spec.permissions,
        ...(spec.budget ? { budget: spec.budget } : {}),
      });
    }
  }

  return seats;
}

// ---------------------------------------------------------------------------
// Seat status
// ---------------------------------------------------------------------------

/**
 * Live state of a seat. Icons/labels live in the UI layer (T01-06,
 * `src/ui-shared/status.ts`), not here.
 */
export const SEAT_STATUSES = [
  "queued",
  "starting",
  "thinking",
  "writing",
  "tool",
  "editing",
  "waiting",
  "rate_limited",
  "done",
  "failed",
  "dissent",
] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];
export const SeatStatusSchema = z.enum(SEAT_STATUSES);

/** Statuses after which a seat will not change again in the current turn. */
export function isTerminalSeatStatus(status: SeatStatus): boolean {
  return status === "done" || status === "failed";
}

// ---------------------------------------------------------------------------
// Stages & sessions (shape only — the runner is T02-09)
// ---------------------------------------------------------------------------

export const STAGE_KINDS = ["plan", "negotiate", "execute", "review"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const StageSpecSchema = z.object({
  /** Unique within the session, kebab-case. */
  id: SeatRoleSchema,
  kind: z.enum(STAGE_KINDS),
  /** Team name from config `teams`. Optional for stages that inherit one. */
  team: z.string().min(1).optional(),
  /** Strategy id, e.g. `debate`, `best-of-n`, `panel`. Interpreted by the runner. */
  strategy: z.string().min(1).optional(),
  /** Strategy-specific options; validated by the strategy. */
  options: z.record(z.unknown()).default({}),
  /** Pause for user approval before this stage starts. */
  requireApproval: z.boolean().default(false),
  /** Stage id to run next; omitted = session ends after this stage. */
  next: z.string().min(1).optional(),
  /** Stage id to return to when a review stage returns NEEDS_WORK. */
  onNeedsWork: z.string().min(1).optional(),
});
export type StageSpec = z.infer<typeof StageSpecSchema>;

export const SessionSpecSchema = z
  .object({
    title: z.string().min(1),
    goal: z.string().min(1),
    /** Playbook id this session was created from, if any. */
    playbook: z.string().optional(),
    stages: z.array(StageSpecSchema).min(1),
  })
  .superRefine((session, ctx) => {
    const ids = new Set<string>();
    for (const [index, stage] of session.stages.entries()) {
      if (ids.has(stage.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "id"],
          message: `duplicate stage id "${stage.id}"`,
        });
      }
      ids.add(stage.id);
    }
    for (const [index, stage] of session.stages.entries()) {
      for (const key of ["next", "onNeedsWork"] as const) {
        const target = stage[key];
        if (target && !ids.has(target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, key],
            message: `unknown stage id "${target}"`,
          });
        }
      }
    }
  });
export type SessionSpec = z.infer<typeof SessionSpecSchema>;
