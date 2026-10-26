import type { EngineEvent } from "@engine/protocol/events.js";

/**
 * A realistic event stream for one run (executor + two reviewers + panel),
 * built in code so it always matches the event schema. Screen tests and the
 * store tests use it.
 */

const SESSION_ID = "6f9e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

function stream(sessionId: string): EngineEvent[] {
  let seq = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, s)).toISOString();
  const e = (draft: Omit<EngineEvent, "seq" | "at" | "sessionId">): EngineEvent =>
    ({ ...draft, sessionId, seq: ++seq, at: at(seq) }) as EngineEvent;
  const spawn = (seatId: string, displayName: string, role: string, permissions: "edit" | "read-only") =>
    e({
      type: "seat.spawned",
      seatId,
      data: { displayName, provider: "mock", transport: "api", model: "AUTO", role, permissions },
    } as never);

  return [
    e({ type: "session.created", data: { title: "Implement average()" } } as never),
    spawn("executor", "Executor", "engineer", "edit"),
    spawn("panel", "Review panel", "panel", "read-only"),
    spawn("reviewer-1", "Opus#1", "code-reviewer", "read-only"),
    spawn("reviewer-2", "Opus#2", "security-reviewer", "read-only"),
    e({ type: "session.state", data: { to: "EXECUTING" } } as never),
    e({ type: "seat.status", seatId: "executor", data: { status: "starting" } } as never),
    e({ type: "seat.status", seatId: "executor", data: { status: "writing" } } as never),
    e({ type: "seat.output.delta", seatId: "executor", data: { text: "Reading src/average.ts\nAdding average()\n" } } as never),
    e({ type: "seat.tool_call", seatId: "executor", data: { name: "editing", summary: "src/average.ts" } } as never),
    e({ type: "seat.done", seatId: "executor", data: { ok: true, summary: "average() added" } } as never),
    e({ type: "session.state", data: { to: "REVIEWING" } } as never),
    e({ type: "seat.status", seatId: "reviewer-1", data: { status: "starting" } } as never),
    e({ type: "seat.status", seatId: "reviewer-2", data: { status: "starting" } } as never),
    e({ type: "seat.done", seatId: "reviewer-1", data: { ok: true, summary: "Looks correct" } } as never),
    e({ type: "seat.error", seatId: "reviewer-2", data: { message: "timed out" } } as never),
  ];
}

export const sessionFixture = { id: SESSION_ID, events: stream(SESSION_ID) };

/** `seats` × `perSeat` output deltas, for throughput tests. */
export function burstFixture(seats: number, perSeat: number): { id: string; events: EngineEvent[] } {
  const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const events: EngineEvent[] = [];
  let seq = 0;
  const at = new Date(Date.UTC(2026, 9, 25)).toISOString();
  for (let s = 0; s < seats; s += 1) {
    events.push({
      seq: ++seq,
      sessionId: id,
      seatId: `seat-${s}`,
      at,
      type: "seat.spawned",
      data: { displayName: `Seat#${s}`, provider: "mock", transport: "api", model: "AUTO", role: "general", permissions: "read-only" },
    } as EngineEvent);
  }
  for (let i = 0; i < perSeat; i += 1) {
    for (let s = 0; s < seats; s += 1) {
      events.push({ seq: ++seq, sessionId: id, seatId: `seat-${s}`, at, type: "seat.output.delta", data: { text: `line ${i}\n` } } as EngineEvent);
    }
  }
  return { id, events };
}
