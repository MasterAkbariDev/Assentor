import { createStore, type StoreApi } from "zustand/vanilla";
import type { EngineEvent, EngineEventType } from "@engine/protocol/events.js";
import type { SessionSummary } from "@engine/protocol/rpc.js";
import { reduceSeatEvents, type SeatState } from "@engine/ui-shared/status.js";

/**
 * UI state for the engine connection and the selected session (T04-06p).
 * Seat state comes from the same `reduceSeatEvents` the TUI uses, so the web
 * board and the terminal agree on every event.
 */

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "unauthorized" | "no_token";

/** What `seat.spawned` says about a seat beyond `SeatState` (the seat drawer's Info tab). */
export interface SeatInfo {
  provider: string;
  transport: "cli" | "api";
  permissions: "read-only" | "edit";
}

/**
 * The event types the seat drawer's Activity tab shows. Only these are kept per
 * seat, so high-volume types (tokens, thinking, output) can't push out the rows
 * that matter. `activity.ts` renders exactly these.
 */
export const ACTIVITY_EVENT_TYPES: ReadonlySet<EngineEventType> = new Set<EngineEventType>([
  "seat.status",
  "seat.tool_call",
  "seat.done",
  "seat.error",
  "seat.retry",
  "seat.model.changed",
  "review.verdict",
]);

/** Most activity events kept per seat (see `ACTIVITY_EVENT_TYPES`). */
export const SEAT_EVENT_CAP = 200;

/**
 * Events the negotiation view rebuilds a run from: the `negotiation.*` stream, the
 * `stage.started` that names each negotiation's strategy and attempt, and `seat.error`
 * (failed asks are the dissent the stream carries).
 */
export const NEGOTIATION_EVENT_TYPES: ReadonlySet<EngineEventType> = new Set<EngineEventType>([
  "negotiation.proposal",
  "negotiation.critique",
  "negotiation.vote",
  "negotiation.consensus",
  "stage.started",
  "seat.error",
]);

/**
 * Most negotiation events kept per session, oldest dropped.
 * shortcut: a very long session can lose an early stage.started (its strategy name), upgrade to per-stage storage if that shows up.
 */
export const NEGOTIATION_EVENT_CAP = 1_000;

export interface SessionView {
  id: string;
  seats: Record<string, SeatState>;
  /** From `seat.spawned`, keyed by seat id. */
  seatInfo: Record<string, SeatInfo>;
  /** The last `SEAT_EVENT_CAP` events of each seat whose type is in `ACTIVITY_EVENT_TYPES`, oldest first. */
  seatEvents: Record<string, EngineEvent[]>;
  /** The last `NEGOTIATION_EVENT_CAP` events whose type is in `NEGOTIATION_EVENT_TYPES`, oldest first. */
  negotiationEvents: EngineEvent[];
  /** Last applied `seq`; resubscribe from here. */
  lastSeq: number;
  eventCount: number;
  /** Latest `session.state` value, e.g. EXECUTING. */
  state?: string;
  /** Set when the stream stopped for good (e.g. `unreadable_log`). */
  error?: string;
}

export interface EngineState {
  connection: ConnectionStatus;
  engineVersion?: string;
  sessions: SessionSummary[];
  selectedId?: string;
  session?: SessionView;
  /** The seat whose drawer is open. Cleared when the selected run changes. */
  openSeatId?: string;
  setConnection(status: ConnectionStatus, engineVersion?: string): void;
  setSessions(sessions: SessionSummary[]): void;
  select(id: string | undefined): void;
  openSeat(seatId: string | undefined): void;
  /** Apply events in order; events at or below `lastSeq`, or for another session, are ignored. */
  applyEvents(sessionId: string, events: EngineEvent[]): void;
  failSession(sessionId: string, message: string): void;
}

export type EngineStore = StoreApi<EngineState>;

function emptySession(id: string): SessionView {
  return { id, seats: {}, seatInfo: {}, seatEvents: {}, negotiationEvents: [], lastSeq: 0, eventCount: 0 };
}

export function createEngineStore(): EngineStore {
  return createStore<EngineState>()((set) => ({
    connection: "connecting",
    sessions: [],
    setConnection: (connection, engineVersion) =>
      set((s) => ({ connection, engineVersion: engineVersion ?? s.engineVersion })),
    setSessions: (sessions) => set({ sessions }),
    select: (id) =>
      set((s) =>
        id === s.selectedId
          ? s
          : { selectedId: id, openSeatId: undefined, session: id ? emptySession(id) : undefined },
      ),
    openSeat: (seatId) => set({ openSeatId: seatId }),
    applyEvents: (sessionId, events) =>
      set((s) => {
        const current = s.session;
        if (!current || current.id !== sessionId || events.length === 0) {
          return s;
        }
        let { seats, seatInfo, seatEvents, negotiationEvents, lastSeq, eventCount, state } = current;
        for (const event of events) {
          if (event.sessionId !== sessionId || event.seq <= lastSeq) {
            continue;
          }
          seats = reduceSeatEvents(seats, event);
          if (event.seatId && event.type === "seat.spawned") {
            const { provider, transport, permissions } = event.data;
            seatInfo = { ...seatInfo, [event.seatId]: { provider, transport, permissions } };
          }
          if (event.seatId && ACTIVITY_EVENT_TYPES.has(event.type)) {
            seatEvents = { ...seatEvents, [event.seatId]: [...(seatEvents[event.seatId] ?? []), event].slice(-SEAT_EVENT_CAP) };
          }
          if (NEGOTIATION_EVENT_TYPES.has(event.type)) {
            negotiationEvents = [...negotiationEvents, event].slice(-NEGOTIATION_EVENT_CAP);
          }
          lastSeq = event.seq;
          eventCount += 1;
          if (event.type === "session.state") {
            state = event.data.to;
          }
        }
        if (lastSeq === current.lastSeq) {
          return s;
        }
        return {
          session: { ...current, seats, seatInfo, seatEvents, negotiationEvents, lastSeq, eventCount, ...(state ? { state } : {}) },
        };
      }),
    failSession: (sessionId, message) =>
      set((s) => (s.session?.id === sessionId ? { session: { ...s.session, error: message } } : s)),
  }));
}

/** Pending events past this are applied at once, so a hidden tab can't build an unbounded backlog. */
export const MAX_PENDING_EVENTS = 1_000;

function defaultSchedule(flush: () => void): void {
  // Hidden tabs pause animation frames; fall back to a timer so the backlog keeps draining.
  const hidden = typeof document !== "undefined" && document.hidden;
  if (!hidden && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flush);
  } else {
    setTimeout(flush, hidden ? 250 : 16);
  }
}

/**
 * Collect events and apply them once per animation frame, so a burst of
 * output deltas costs one render, not hundreds. More than
 * `MAX_PENDING_EVENTS` waiting are applied immediately.
 */
export function createFrameBatcher(
  store: EngineStore,
  schedule: (flush: () => void) => void = defaultSchedule,
  maxPending: number = MAX_PENDING_EVENTS,
): { push(sessionId: string, event: EngineEvent): void; flush(): void } {
  let pending: Array<{ sessionId: string; event: EngineEvent }> = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    const bySession = new Map<string, EngineEvent[]>();
    for (const { sessionId, event } of batch) {
      const list = bySession.get(sessionId);
      if (list) {
        list.push(event);
      } else {
        bySession.set(sessionId, [event]);
      }
    }
    for (const [sessionId, events] of bySession) {
      store.getState().applyEvents(sessionId, events);
    }
  };
  return {
    push(sessionId, event) {
      pending.push({ sessionId, event });
      if (pending.length >= maxPending) {
        flush();
        return;
      }
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    flush,
  };
}
