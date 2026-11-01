import type { EngineEvent } from "#assentor/protocol/events.js";

/** A run with one executor and one reviewer, both live, for the board's controls tests. */
export function liveRun(sessionId: string, extra: Array<Partial<EngineEvent> & { type: string; data: object }> = []): EngineEvent[] {
  let seq = 0;
  const e = (draft: object): EngineEvent => ({ sessionId, seq: ++seq, at: new Date(Date.UTC(2026, 9, 25, 10, 0, seq)).toISOString(), ...draft }) as EngineEvent;
  const spawn = (seatId: string, displayName: string, role: string) =>
    e({ type: "seat.spawned", seatId, data: { displayName, provider: "mock", transport: "api", model: "AUTO", role, permissions: "edit" } });
  return [
    spawn("executor", "Executor", "engineer"),
    spawn("reviewer-1", "Reviewer", "code-reviewer"),
    e({ type: "seat.status", seatId: "executor", data: { status: "writing" } }),
    e({ type: "seat.status", seatId: "reviewer-1", data: { status: "starting" } }),
    ...extra.map((x) => e(x)),
  ];
}
