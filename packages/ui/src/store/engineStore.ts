import { createStore, type StoreApi } from "zustand/vanilla";
import type { EngineEvent, EngineEventOf, EngineEventType } from "#assentor/protocol/events.js";
import type { SessionSummary } from "#assentor/protocol/rpc.js";
import { emptyLeadBoardView, reduceLeadEvents, type LeadBoardView } from "#assentor/ui-shared/lead.js";
import { reduceSeatEvents, type SeatState } from "#assentor/ui-shared/status.js";

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

/** Most `review.finding` events kept per run, newest last. */
export const REVIEW_FINDING_CAP = 200;
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
  "negotiation.decided",
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
  /** From `mode.selected`, e.g. "lead". Undefined until that event arrives. */
  mode?: string;
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
  /** Latest reviewer-scoped `review.verdict` (it has a seat id; Lead's per-task verdict does not). */
  reviewVerdict?: EngineEventOf<"review.verdict">;
  /** Each panel member's latest own `review.verdict` (`panelMember`), keyed by seat id. */
  memberVerdicts: Record<string, EngineEventOf<"review.verdict">>;
  /** The last `REVIEW_FINDING_CAP` `review.finding` events, oldest first. */
  reviewFindings: EngineEventOf<"review.finding">[];
  /** The lead team board, folded by the shared `reduceLeadEvents` (T02B-18). Empty outside lead mode. */
  lead: LeadBoardView;
  /** Latest `session.state` value, e.g. EXECUTING. */
  state?: string;
  /** Set when the stream stopped for good (e.g. `unreadable_log`). */
  error?: string;
}

export interface EngineState {
  connection: ConnectionStatus;
  engineVersion?: string;
  sessions: SessionSummary[];
  /** True once `setSessions` has run at least once (the first list has arrived). */
  sessionsLoaded: boolean;
  selectedId?: string;
  /** Session ids, most recently selected first (at most `RECENT_LIMIT`). The command palette's "Recent" group. */
  recentIds: string[];
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

/** How many recently selected runs the command palette keeps. */
export const RECENT_LIMIT = 5;

function emptySession(id: string): SessionView {
  return { id, seats: {}, seatInfo: {}, seatEvents: {}, negotiationEvents: [], lead: emptyLeadBoardView(), reviewFindings: [], memberVerdicts: {}, lastSeq: 0, eventCount: 0 };
}

export function createEngineStore(): EngineStore {
  return createStore<EngineState>()((set) => ({
    connection: "connecting",
    sessions: [],
    sessionsLoaded: false,
    recentIds: [],
    setConnection: (connection, engineVersion) =>
      set((s) => ({ connection, engineVersion: engineVersion ?? s.engineVersion })),
    setSessions: (sessions) => set({ sessions, sessionsLoaded: true }),
    select: (id) =>
      set((s) =>
        id === s.selectedId
          ? s
          : {
              selectedId: id,
              openSeatId: undefined,
              session: id ? emptySession(id) : undefined,
              recentIds: id ? [id, ...s.recentIds.filter((x) => x !== id)].slice(0, RECENT_LIMIT) : s.recentIds,
            },
      ),
    openSeat: (seatId) => set({ openSeatId: seatId }),
    applyEvents: (sessionId, events) =>
      set((s) => {
        const current = s.session;
        if (!current || current.id !== sessionId || events.length === 0) {
          return s;
        }
        let { seats, seatInfo, seatEvents, negotiationEvents, lead, reviewVerdict, memberVerdicts, reviewFindings, lastSeq, eventCount, state, mode } = current;
        for (const event of events) {
          if (event.sessionId !== sessionId || event.seq <= lastSeq) {
            continue;
          }
          seats = reduceSeatEvents(seats, event);
          lead = reduceLeadEvents(lead, event);
          if (event.type === "mode.selected") {
            mode = event.data.mode;
          }
          if (event.seatId && event.type === "seat.spawned") {
            const { provider, transport, permissions } = event.data;
            seatInfo = { ...seatInfo, [event.seatId]: { provider, transport, permissions } };
          }
          if (event.seatId && ACTIVITY_EVENT_TYPES.has(event.type)) {
            seatEvents = { ...seatEvents, [event.seatId]: [...(seatEvents[event.seatId] ?? []), event].slice(-SEAT_EVENT_CAP) };
          }
          if (event.type === "review.verdict" && event.seatId) {
            if (event.data.panelMember) {
              memberVerdicts = { ...memberVerdicts, [event.seatId]: event };
            } else {
              reviewVerdict = event;
              // Findings follow their verdict: a new decision starts a new list.
              reviewFindings = [];
            }
          }
          if (event.type === "review.finding") {
            reviewFindings = [...reviewFindings, event].slice(-REVIEW_FINDING_CAP);
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
          session: { ...current, seats, seatInfo, seatEvents, negotiationEvents, lead, reviewVerdict, memberVerdicts, reviewFindings, lastSeq, eventCount, mode, ...(state ? { state } : {}) },
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
