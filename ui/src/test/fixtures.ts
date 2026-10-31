import { parseEngineEvent, type EngineEvent } from "@engine/protocol/events.js";

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

const NEGOTIATION_ID = "7a1d3e5f-2c4b-4d6e-9f08-1a2b3c4d5e6f";

/**
 * Two negotiations in one run, in the shape the engine emits them (stage-scoped):
 * - `debate-1`: two rounds, a critique with citations, a failed ask (dissent), consensus reached in round 2.
 * - `vote-1`: three proposals, three ballots, Borda A 3 / B 5 / C 1 of 6 possible, consensus 5/6.
 * Proposal events carry no author, as the current strategies send none.
 */
function negotiationStream(sessionId: string): EngineEvent[] {
  let seq = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 11, 0, s)).toISOString();
  const e = (draft: Record<string, unknown>): EngineEvent => ({ ...draft, sessionId, seq: ++seq, at: at(seq) }) as EngineEvent;
  const spawn = (seatId: string, displayName: string, role: string) =>
    e({
      type: "seat.spawned",
      seatId,
      data: { displayName, provider: "mock", transport: "api", model: "AUTO", role, permissions: "read-only" },
    });

  return [
    e({ type: "session.created", data: { title: "Pick an approach" } }),
    spawn("seat-a", "Opus#1", "proposer"),
    spawn("seat-b", "Opus#2", "critic"),
    spawn("seat-c", "Sonnet#1", "critic"),
    e({ type: "stage.started", stageId: "debate-1", data: { kind: "negotiate", strategy: "debate", attempt: 1 } }),
    e({ type: "seat.error", stageId: "debate-1", seatId: "seat-c", data: { message: "invalid negotiate-propose reply: no JSON found" } }),
    e({ type: "negotiation.proposal", stageId: "debate-1", data: { round: 1, label: "Proposal A", text: "Stream the file in chunks. <b>Bold</b> is text." } }),
    e({ type: "negotiation.proposal", stageId: "debate-1", data: { round: 1, label: "Proposal B", text: "Load the whole file, then sum." } }),
    e({
      type: "negotiation.critique",
      stageId: "debate-1",
      seatId: "seat-b",
      data: { round: 1, targetLabel: "Proposal A", text: "Chunking misses the last partial line.", citations: ["src/average.ts:12", "spec §3.2"] },
    }),
    e({ type: "negotiation.consensus", stageId: "debate-1", data: { round: 1, score: 0.4, reached: false } }),
    e({ type: "negotiation.proposal", stageId: "debate-1", data: { round: 2, label: "Proposal A", text: "Stream in chunks and carry the partial line." } }),
    e({ type: "negotiation.consensus", stageId: "debate-1", data: { round: 2, score: 0.8, reached: true, preferred: "Proposal A" } }),
    e({ type: "stage.started", stageId: "vote-1", data: { kind: "negotiate", strategy: "vote", attempt: 1 } }),
    e({ type: "negotiation.proposal", stageId: "vote-1", data: { round: 1, label: "Proposal A", text: "Sum with a loop." } }),
    e({ type: "negotiation.proposal", stageId: "vote-1", data: { round: 1, label: "Proposal B", text: "Use reduce." } }),
    e({ type: "negotiation.proposal", stageId: "vote-1", data: { round: 1, label: "Proposal C", text: "Return NaN for empty input." } }),
    e({ type: "negotiation.vote", stageId: "vote-1", seatId: "seat-a", data: { round: 2, ranking: ["Proposal B", "Proposal A", "Proposal C"] } }),
    e({ type: "negotiation.vote", stageId: "vote-1", seatId: "seat-b", data: { round: 2, ranking: ["Proposal A", "Proposal B", "Proposal C"] } }),
    e({ type: "negotiation.vote", stageId: "vote-1", seatId: "seat-c", data: { round: 2, ranking: ["Proposal B", "Proposal C", "Proposal A"] } }),
    e({ type: "negotiation.consensus", stageId: "vote-1", data: { round: 2, score: 5 / 6, reached: true, preferred: "Proposal B" } }),
  ];
}

export const negotiationFixture = { id: NEGOTIATION_ID, events: negotiationStream(NEGOTIATION_ID) };
const LEAD_SESSION_ID = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";

/**
 * A lead-mode run: six tasks, two seats, one refused action, one rejected task that stays
 * rejected, and one reassigned, escalated task. Validated against the event schema as it is built.
 */
function leadStream(sessionId: string): EngineEvent[] {
  let seq = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 9, 0, s)).toISOString();
  const e = (type: string, data: object, seatId?: string): EngineEvent =>
    parseEngineEvent({ seq: ++seq, sessionId, ...(seatId ? { seatId } : {}), type, data, at: at(seq) });
  const spawn = (seatId: string, displayName: string, model: string) =>
    e("seat.spawned", { displayName, provider: "claude-code", transport: "cli", model, role: "engineer", permissions: "edit" }, seatId);
  const task = (taskId: string, title: string) => e("task.created", { taskId, title, replaced: false });

  return [
    e("mode.selected", { mode: "lead", kind: "dynamic", autonomy: "supervised" }),
    e("session.created", { title: "Login feature" }),
    spawn("seat-1", "Opus#1", "opus"),
    spawn("seat-2", "Sonnet#2", "sonnet"),
    e("session.state", { to: "EXECUTING" }),
    e("lead.turn", { turn: 1 }),
    task("T1", "Login form"),
    task("T2", "Login API"),
    task("T3", "Session docs"),
    task("T4", "Refactor auth"),
    task("T5", "Token refresh"),
    task("T6", "Release notes"),
    e("lead.action", { action: "plan_tasks", accepted: true, reason: "6 task(s) planned" }),
    e("task.assigned", { taskId: "T1", seatId: "seat-1" }),
    e("task.status", { taskId: "T1", status: "in_progress" }),
    e("seat.status", { status: "writing" }, "seat-1"),
    e("task.assigned", { taskId: "T2", seatId: "seat-2" }),
    e("task.status", { taskId: "T2", status: "in_progress" }),
    e("task.status", { taskId: "T2", status: "in_review" }),
    e("task.assigned", { taskId: "T3", seatId: "seat-2" }),
    e("task.status", { taskId: "T3", status: "in_progress" }),
    e("task.accepted", { taskId: "T3" }),
    e("task.assigned", { taskId: "T4", seatId: "seat-1" }),
    e("task.status", { taskId: "T4", status: "in_progress" }),
    e("task.rejected", { taskId: "T4", reason: "tests are missing" }),
    e("lead.action", { action: "reject", accepted: true, reason: "T4 rejected" }),
    e("task.assigned", { taskId: "T5", seatId: "seat-1" }),
    e("task.status", { taskId: "T5", status: "in_progress" }),
    e("task.rejected", { taskId: "T5", reason: "edge case untested" }),
    e("lead.action", { action: "assign", accepted: false, reason: "seat-1 is busy with another task" }),
    e("task.escalated", { taskId: "T5", from: "claude-code/opus", to: "claude-code/sonnet" }),
    e("task.assigned", { taskId: "T5", seatId: "seat-2" }),
    e("lead.action", { action: "escalate", accepted: true, reason: "T5 escalated to seat-2" }),
  ];
}

export const leadFixture = { id: LEAD_SESSION_ID, events: leadStream(LEAD_SESSION_ID) };

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
