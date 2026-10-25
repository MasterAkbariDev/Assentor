import {
  expandSeatSpecs,
  type Seat,
  type SeatProvider,
  type SeatTransport,
  type Team,
} from "../core/seats.js";
import type { Reviewer } from "../providers/reviewers/types.js";

/**
 * Seat factory (task T01-02): expand a review `Team` into one `Reviewer` per
 * seat, for `PanelReviewer`.
 *
 * Review seats are always read-only. A team that marks a review seat `edit` is
 * downgraded with a warning; no edit or bypass flag ever reaches a reviewer.
 */

/** What the factory passes to `createReviewer` for one seat. */
export interface ReviewerSeatRequest {
  /** Reviewer provider id understood by `createReviewer` (`claude`, `codex`, `gemini`, …). */
  provider: string;
  transport: SeatTransport;
  /** Explicit model, or undefined for the provider/CLI default. */
  model?: string;
  apiKey?: string;
  /** The seat's display name, e.g. `Opus#2`; findings carry it. */
  name: string;
  specialtyAddendum?: string;
  onStatus?: (message: string) => void;
}

export interface ReviewerSeatDeps {
  createReviewer: (request: ReviewerSeatRequest) => Promise<Reviewer>;
  /** API key for an API seat; not called for CLI or mock seats. */
  resolveApiKey?: (provider: string) => Promise<string | undefined>;
  /** Model for an API seat whose model is `AUTO` (e.g. `config.models.gemini`). */
  defaultApiModel?: (provider: string) => string | undefined;
  /** Extra prompt text for the seat at this index. */
  specialtyAddendum?: (seat: Seat, index: number) => string | undefined;
  onStatus?: (seat: Seat, index: number, message: string) => void;
  onWarning?: (message: string) => void;
  /** Prefixes seat ids as `<teamName>.<seat>`. */
  teamName?: string;
}

export interface ReviewerSeat {
  seat: Seat;
  reviewer: Reviewer;
}

/** Seat provider → reviewer provider id. Providers without a reviewer adapter are absent. */
const REVIEWER_PROVIDER: Partial<Record<SeatProvider, string>> = {
  "claude-code": "claude",
  codex: "codex",
  antigravity: "antigravity",
  cursor: "cursor",
  gemini: "gemini",
  openai: "openai",
  mock: "mock",
};

const API_KEY_PROVIDERS = new Set(["gemini", "openai"]);

/** Reviewer provider id for a seat provider, or undefined when it has no reviewer adapter. */
export function reviewerProviderForSeat(provider: SeatProvider): string | undefined {
  return REVIEWER_PROVIDER[provider];
}

/** `{ provider, transport }` per expanded seat, for preflight checks and labels. */
export function reviewTeamTargets(
  team: Team,
): Array<{ provider: string; transport: SeatTransport }> {
  return expandSeatSpecs(team.seats).map((seat) => ({
    provider: REVIEWER_PROVIDER[seat.provider] ?? seat.provider,
    transport: seat.transport,
  }));
}

/**
 * Build one reviewer per seat of `team`, in seat order. Throws before creating
 * any reviewer when a seat's provider has no reviewer adapter.
 */
export async function createReviewerSeats(
  team: Team,
  deps: ReviewerSeatDeps,
): Promise<ReviewerSeat[]> {
  const seats = expandSeatSpecs(team.seats, { teamName: deps.teamName }).map(
    (seat) => enforceReadOnly(seat, deps.onWarning),
  );

  for (const seat of seats) {
    if (!REVIEWER_PROVIDER[seat.provider]) {
      throw new Error(
        `Review seat ${seat.displayName}: provider "${seat.provider}" cannot review yet. ` +
          `Use ${Object.keys(REVIEWER_PROVIDER).join(", ")}.`,
      );
    }
  }

  const result: ReviewerSeat[] = [];
  for (const [index, seat] of seats.entries()) {
    const provider = REVIEWER_PROVIDER[seat.provider]!;
    const explicitModel = isAuto(seat.model) ? undefined : seat.model.trim();
    // CLI seats use only an explicit model; API seats fall back to the configured default.
    const model =
      seat.transport === "cli"
        ? explicitModel
        : (explicitModel ?? deps.defaultApiModel?.(provider));
    const apiKey =
      seat.transport === "api" && API_KEY_PROVIDERS.has(provider)
        ? await deps.resolveApiKey?.(provider)
        : undefined;

    const reviewer = await deps.createReviewer({
      provider,
      transport: seat.transport,
      ...(model ? { model } : {}),
      ...(apiKey ? { apiKey } : {}),
      name: seat.displayName,
      specialtyAddendum: deps.specialtyAddendum?.(seat, index),
      onStatus: deps.onStatus
        ? (message) => deps.onStatus!(seat, index, message)
        : undefined,
    });
    result.push({ seat, reviewer });
  }
  return result;
}

function enforceReadOnly(seat: Seat, onWarning?: (message: string) => void): Seat {
  if (seat.permissions === "read-only") {
    return seat;
  }
  onWarning?.(
    `Review seat ${seat.displayName} is marked "${seat.permissions}"; reviewers are always read-only, so it runs read-only.`,
  );
  return { ...seat, permissions: "read-only" };
}

function isAuto(model: string): boolean {
  const trimmed = model.trim();
  return trimmed.length === 0 || trimmed.toUpperCase() === "AUTO";
}
