import { createStore, type StoreApi } from "zustand/vanilla";
import type { EngineEvent } from "@engine/protocol/events.js";
import type { SessionSummary } from "@engine/protocol/rpc.js";
import { reduceSeatEvents, type SeatState } from "@engine/ui-shared/status.js";

/**
 * UI state for the engine connection and the selected session (T04-06p).
 * Seat state comes from the same `reduceSeatEvents` the TUI uses, so the web
 * board and the terminal agree on every event.
 */

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "unauthorized" | "no_token";

export interface SessionView {
  id: string;
  seats: Record<string, SeatState>;
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
  setConnection(status: ConnectionStatus, engineVersion?: string): void;
  setSessions(sessions: SessionSummary[]): void;
  select(id: string | undefined): void;
  /** Apply events in order; events at or below `lastSeq`, or for another session, are ignored. */
  applyEvents(sessionId: string, events: EngineEvent[]): void;
  failSession(sessionId: string, message: string): void;
}

export type EngineStore = StoreApi<EngineState>;

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
          : { selectedId: id, session: id ? { id, seats: {}, lastSeq: 0, eventCount: 0 } : undefined },
      ),
    applyEvents: (sessionId, events) =>
      set((s) => {
        const current = s.session;
        if (!current || current.id !== sessionId || events.length === 0) {
          return s;
        }
        let { seats, lastSeq, eventCount, state } = current;
        for (const event of events) {
          if (event.sessionId !== sessionId || event.seq <= lastSeq) {
            continue;
          }
          seats = reduceSeatEvents(seats, event);
          lastSeq = event.seq;
          eventCount += 1;
          if (event.type === "session.state") {
            state = event.data.to;
          }
        }
        if (lastSeq === current.lastSeq) {
          return s;
        }
        return { session: { ...current, seats, lastSeq, eventCount, ...(state ? { state } : {}) } };
      }),
    failSession: (sessionId, message) =>
      set((s) => (s.session?.id === sessionId ? { session: { ...s.session, error: message } } : s)),
  }));
}

/**
 * Collect events and apply them once per animation frame, so a burst of
 * output deltas costs one render, not hundreds.
 */
export function createFrameBatcher(
  store: EngineStore,
  schedule: (flush: () => void) => void = (flush) =>
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(flush) : setTimeout(flush, 16),
): { push(sessionId: string, event: EngineEvent): void; flush(): void } {
  let pending: Array<{ sessionId: string; event: EngineEvent }> = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = pending;
    pending = [];
    const bySession = new Map<string, EngineEvent[]>();
    for (const { sessionId, event } of batch) {
      bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), event]);
    }
    for (const [sessionId, events] of bySession) {
      store.getState().applyEvents(sessionId, events);
    }
  };
  return {
    push(sessionId, event) {
      pending.push({ sessionId, event });
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    flush,
  };
}
