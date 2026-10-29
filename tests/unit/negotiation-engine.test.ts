import { afterEach, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NegotiationCancelledError,
  NegotiationResultSchema,
  createId,
  expandSeatSpecs,
  type EngineEventDraft,
} from "../../src/index.js";
import { createNegotiationContext, runNegotiation, type SeatStepRunner } from "../../src/negotiation/engine.js";
import { voteStrategy } from "../../src/negotiation/strategies/vote.js";
import { SeatScheduler } from "../../src/seats/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const seats = expandSeatSpecs([
  { provider: "claude-code", model: "opus", count: 2 },
  { provider: "codex", model: "sol" },
]);

function scheduler(extra: ConstructorParameters<typeof SeatScheduler>[0] extends infer O ? Partial<O> : never = {}) {
  return new SeatScheduler({ sessionId: "s", backoffBaseMs: 1, ...extra });
}

/** A runner that proposes "plan from <seat>" and ranks every proposal in label order. */
const votingRunner: SeatStepRunner = async ({ seat, step, vars }) => {
  if (step === "negotiate-propose") return { proposal: `plan from ${seat.id}` };
  if (step === "negotiate-rank") {
    const labels = (vars.proposals as Array<{ label: string }>).map((p) => p.label);
    return { ranking: labels };
  }
  throw new Error(`unexpected step ${step}`);
};

describe("runNegotiation", () => {
  it("runs a strategy through the scheduler, emits events and persists the result", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "negotiation-engine-"));
    dirs.push(projectPath);
    const sessionId = createId();
    const events: EngineEventDraft[] = [];
    const { result, transcript } = await runNegotiation({
      sessionId,
      projectPath,
      runId: "plan",
      strategy: voteStrategy,
      goal: "Pick a cache design",
      seats,
      scheduler: scheduler(),
      runStep: votingRunner,
      emit: (e) => events.push(e),
    });

    expect(NegotiationResultSchema.parse(result)).toEqual(result);
    expect(result.strategy).toBe("vote");
    expect(result.transcriptRef).toBe("negotiations/plan.json");
    expect(transcript).toHaveLength(6); // 3 proposes + 3 ranks
    expect(transcript.every((t) => t.ok && t.attempts === 1)).toBe(true);
    expect(transcript.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5]);

    const saved = JSON.parse(
      await fs.readFile(path.join(projectPath, ".assentor", "sessions", sessionId, "negotiations", "plan.json"), "utf8"),
    );
    expect(saved.result).toEqual(result);
    expect(saved.transcript).toHaveLength(6);

    const types = events.map((e) => e.type);
    expect(types).toContain("negotiation.proposal");
    expect(types).toContain("negotiation.vote");
    expect(types).toContain("negotiation.consensus");
    expect(events.filter((e) => e.type === "seat.status" && e.data.status === "thinking")).toHaveLength(6);
    expect(events.filter((e) => e.type === "seat.done")).toHaveLength(6);
    expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
  });

  it("refuses unknown strategies, invalid teams and unsafe run ids", async () => {
    const base = { sessionId: "s", goal: "g", seats, scheduler: scheduler(), runStep: votingRunner };
    await expect(runNegotiation({ ...base, runId: "x", strategy: "no-such" })).rejects.toThrow("unknown negotiation strategy");
    await expect(runNegotiation({ ...base, runId: "x", strategy: voteStrategy, seats: seats.slice(0, 1) })).rejects.toThrow(
      "vote:",
    );
    await expect(runNegotiation({ ...base, runId: "../escape", strategy: voteStrategy })).rejects.toThrow("invalid negotiation run id");
  });
});

describe("runNegotiation lifecycle", () => {
  async function tempProject() {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "negotiation-engine-"));
    dirs.push(projectPath);
    return projectPath;
  }

  it("never puts seat ids, display names or models into step vars, and keeps ask order", async () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    // Later seats answer first, so completion order differs from ask order.
    const delay: Record<string, number> = { "opus-1": 15, "opus-2": 8, "sol-1": 1 };
    const { transcript } = await runNegotiation({
      sessionId: "s",
      runId: "anon",
      strategy: voteStrategy,
      goal: "Pick a cache design",
      seats,
      scheduler: scheduler(),
      runStep: async ({ seat, step, vars }) => {
        seen.push(vars);
        await new Promise((r) => setTimeout(r, delay[seat.id]));
        if (step === "negotiate-propose") return { proposal: `idea ${Object.keys(delay).indexOf(seat.id)}` };
        return { ranking: (vars.proposals as Array<{ label: string }>).map((p) => p.label) };
      },
    });
    expect(seen).toHaveLength(6);
    const text = JSON.stringify(seen).toLowerCase();
    for (const seat of seats) {
      for (const leak of [seat.id, seat.displayName, seat.model]) {
        expect(text).not.toContain(leak.toLowerCase());
      }
    }
    expect(transcript.map((t) => t.seatId)).toEqual(["opus-1", "opus-2", "sol-1", "opus-1", "opus-2", "sol-1"]);
  });

  it("removes its abort listener from the caller's signal after every run", async () => {
    const session = new AbortController();
    for (let i = 0; i < 12; i++) {
      await runNegotiation({
        sessionId: "s",
        runId: `r${i}`,
        strategy: voteStrategy,
        goal: "g",
        seats,
        scheduler: scheduler(),
        runStep: votingRunner,
        signal: session.signal,
      });
    }
    expect(getEventListeners(session.signal, "abort")).toHaveLength(0);
  });

  it("checks the output path before any model call: bad session id, existing run id", async () => {
    const projectPath = await tempProject();
    let calls = 0;
    const runStep: SeatStepRunner = async (req) => {
      calls++;
      return votingRunner(req);
    };
    const base = { projectPath, runId: "plan", strategy: voteStrategy, goal: "g", seats, runStep };
    await expect(runNegotiation({ ...base, sessionId: "../bad", scheduler: scheduler() })).rejects.toThrow("Invalid session id");
    expect(calls).toBe(0);

    const sessionId = createId();
    await runNegotiation({ ...base, sessionId, scheduler: scheduler() });
    const before = calls;
    await expect(runNegotiation({ ...base, sessionId, scheduler: scheduler() })).rejects.toThrow("already exists");
    expect(calls).toBe(before);
  });

  it("rejects with NegotiationCancelledError when aborted mid-round, closes seat status, writes no file", async () => {
    const projectPath = await tempProject();
    const sessionId = createId();
    const session = new AbortController();
    const events: EngineEventDraft[] = [];
    const run = runNegotiation({
      sessionId,
      projectPath,
      runId: "plan",
      strategy: voteStrategy,
      goal: "g",
      seats,
      scheduler: scheduler(),
      emit: (e) => events.push(e),
      signal: session.signal,
      runStep: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("killed")))),
    });
    await new Promise((r) => setTimeout(r, 5));
    session.abort();
    await expect(run).rejects.toBeInstanceOf(NegotiationCancelledError);

    for (const seat of seats) {
      const mine = events.filter((e) => e.seatId === seat.id);
      expect(mine.map((e) => e.type)).toEqual(["seat.status", "seat.done"]);
      expect(mine[1]!.data).toEqual({ ok: false, summary: "cancelled" });
    }
    await expect(fs.stat(path.join(projectPath, ".assentor", "sessions", sessionId, "negotiations"))).rejects.toThrow();
  });
});

describe("askSeat semantics", () => {
  function context(runStep: SeatStepRunner, extra: Record<string, unknown> = {}) {
    const events: EngineEventDraft[] = [];
    const made = createNegotiationContext({
      sessionId: "s",
      goal: "g",
      seats,
      scheduler: scheduler(),
      runStep,
      emit: (e) => events.push(e),
      ...extra,
    });
    return { ...made, events };
  }

  it("parses JSON from text replies, fenced or bare", async () => {
    const { ctx } = context(async ({ seat }) =>
      seat.id === "opus-1" ? 'Here you go:\n```json\n{"proposal":"fenced"}\n```' : 'I propose {"proposal":"bare"} ok',
    );
    expect(await ctx.askSeat("opus-1", "negotiate-propose", {}, { readOnly: true })).toEqual({
      ok: true,
      seatId: "opus-1",
      data: { proposal: "fenced" },
    });
    expect(await ctx.askSeat("opus-2", "negotiate-propose", {}, { readOnly: true })).toMatchObject({
      ok: true,
      data: { proposal: "bare" },
    });
  });

  it("turns bad replies, seat errors and timeouts into ok:false", async () => {
    const { ctx, events, transcript } = context(
      async ({ seat, signal }) => {
        if (seat.id === "opus-1") return "no json here";
        if (seat.id === "opus-2") throw new Error("auth failed");
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
      },
      { askTimeoutMs: 20 },
    );
    const bad = await ctx.askSeat("opus-1", "negotiate-propose", {}, { readOnly: true });
    const failed = await ctx.askSeat("opus-2", "negotiate-propose", {}, { readOnly: true });
    const slow = await ctx.askSeat("sol-1", "negotiate-propose", {}, { readOnly: true });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("invalid negotiate-propose reply") });
    expect(failed).toMatchObject({ ok: false, error: "error: auth failed" });
    expect(slow).toMatchObject({ ok: false, error: expect.stringContaining("timeout") });
    expect(events.filter((e) => e.type === "seat.error")).toHaveLength(3);
    expect(transcript.map((t) => t.ok)).toEqual([false, false, false]);
  });

  it("rejects with NegotiationCancelledError on a session budget stop", async () => {
    const { ctx, events } = context(
      async ({ reportUsage }) => {
        reportUsage({ tokensIn: 50 });
        return { proposal: "x" };
      },
      { scheduler: scheduler({ sessionBudget: { maxTokens: 10 } }) },
    );
    const error = await ctx.askSeat("opus-1", "negotiate-propose", {}, { readOnly: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NegotiationCancelledError);
    expect((error as NegotiationCancelledError).reason).toBe("budget");
    expect(events.filter((e) => e.type === "seat.done").map((e) => e.data)).toEqual([{ ok: false, summary: "budget exceeded" }]);
    // Later asks reject at once.
    await expect(ctx.askSeat("opus-2", "negotiate-propose", {}, { readOnly: true })).rejects.toBeInstanceOf(
      NegotiationCancelledError,
    );
  });

  it("rejects in-flight and later asks when the caller cancels, and stops the scheduler", async () => {
    const caller = new AbortController();
    const sched = scheduler();
    const { ctx } = context(
      async ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("x")))),
      { signal: caller.signal, scheduler: sched },
    );
    const inFlight = ctx.askSeat("opus-1", "negotiate-propose", {}, { readOnly: true });
    await new Promise((r) => setTimeout(r, 5));
    caller.abort();
    await expect(inFlight).rejects.toBeInstanceOf(NegotiationCancelledError);
    expect(ctx.signal.aborted).toBe(true);
    await expect(ctx.askSeat("opus-2", "negotiate-propose", {}, { readOnly: true })).rejects.toBeInstanceOf(
      NegotiationCancelledError,
    );
    expect(sched.runningCount).toBe(0);
  });

  it("reports editing, not thinking, for a step that may write", async () => {
    const { ctx, events } = context(async () => ({ proposal: "p" }));
    await ctx.askSeat("opus-1", "negotiate-propose", {}, { readOnly: false });
    expect(events[0]!.data).toMatchObject({ status: "editing" });
  });

  it("throws for a seat that isn't in the team", async () => {
    const { ctx } = context(votingRunner);
    await expect(ctx.askSeat("nobody", "negotiate-propose", {}, { readOnly: true })).rejects.toThrow("unknown seat");
  });
});
