import type { EngineEvent } from "@engine/protocol/events.js";
import type { LeadBoardView } from "@engine/ui-shared/lead.js";
import type { SeatState } from "@engine/ui-shared/status.js";
import type { EngineState } from "./engineStore.js";

/** The team board of the selected run, only when that run is in lead mode. */
export function selectLeadBoard(state: EngineState): LeadBoardView | undefined {
  return state.session?.mode === "lead" ? state.session.lead : undefined;
}

/** Seats of the selected run, keyed by seat id. Undefined before a run is selected. */
export function selectSeats(state: EngineState): Record<string, SeatState> | undefined {
  return state.session?.seats;
}

const NO_EVENTS: readonly EngineEvent[] = [];

/** Negotiation-related events of the selected run (see `NEGOTIATION_EVENT_TYPES`). Stable until one arrives. */
export function selectNegotiationEvents(state: EngineState): readonly EngineEvent[] {
  return state.session?.negotiationEvents ?? NO_EVENTS;
}

/** True when the selected run has at least one `negotiation.*` event; decides whether the negotiation view is shown. */
export function selectHasNegotiation(state: EngineState): boolean {
  return selectNegotiationEvents(state).some((event) => event.type.startsWith("negotiation."));
}

/** A seat that can still change: anything but done and failed. Only live seats need the elapsed ticker. */
export function isLiveSeat(seat: SeatState): boolean {
  return seat.status !== "done" && seat.status !== "failed";
}

export type SeatGroupKey = "executor" | "reviewers" | "other";

export interface SeatGroup {
  key: SeatGroupKey;
  title: string;
  seats: SeatState[];
}

const GROUP_ORDER: readonly SeatGroupKey[] = ["executor", "reviewers", "other"];

const GROUP_TITLES: Record<SeatGroupKey, string> = {
  executor: "Executor",
  reviewers: "Reviewers",
  other: "Other seats",
};

function groupKeyFor(seatId: string): SeatGroupKey {
  if (seatId === "executor") return "executor";
  if (seatId === "panel" || seatId.startsWith("reviewer-")) return "reviewers";
  return "other";
}

/**
 * Executor first, then reviewers (`reviewer-*` and the panel), then any other
 * seat. Empty groups are dropped. Seats keep the order the engine spawned them in.
 */
export function groupSeats(seats: Record<string, SeatState>): SeatGroup[] {
  const buckets: Record<SeatGroupKey, SeatState[]> = { executor: [], reviewers: [], other: [] };
  for (const seat of Object.values(seats)) {
    buckets[groupKeyFor(seat.seatId)].push(seat);
  }
  return GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    title: GROUP_TITLES[key],
    seats: buckets[key],
  }));
}
