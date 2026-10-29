import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  ENGINE_EVENT_TYPES,
  SessionSpecSchema,
  SeatSpecSchema,
  TeamSchema,
  engineTypeForSupervisorEvent,
  expandSeatSpecs,
  fromSupervisorEvent,
  modelShortName,
  normalizeSeatProvider,
  parseEngineEvent,
  safeParseEngineEvent,
  transportsForSeatProvider,
  type EngineEvent,
  type SupervisorEventType,
} from "../../src/index.js";

describe("seat providers", () => {
  it("normalizes config aliases; gemini stays the API provider", () => {
    expect(normalizeSeatProvider("claude")).toBe("claude-code");
    expect(normalizeSeatProvider("AGY")).toBe("antigravity");
    expect(normalizeSeatProvider("cursor-agent")).toBe("cursor");
    expect(normalizeSeatProvider("gemini")).toBe("gemini");
    expect(normalizeSeatProvider("nope")).toBeUndefined();
  });

  it("knows supported transports", () => {
    expect(transportsForSeatProvider("codex")).toEqual(["cli"]);
    expect(transportsForSeatProvider("openai")).toEqual(["api"]);
    expect(transportsForSeatProvider("mock")).toEqual(["api", "cli"]);
  });

  it("rejects an unsupported transport", () => {
    const result = SeatSpecSchema.safeParse({ provider: "codex", transport: "api" });
    expect(result.success).toBe(false);
  });

  it("applies safe defaults", () => {
    const spec = SeatSpecSchema.parse({ provider: "claude" });
    expect(spec).toMatchObject({
      provider: "claude-code",
      model: "AUTO",
      role: "general",
      count: 1,
      permissions: "read-only",
    });
  });

  it("bounds count to 1..8", () => {
    expect(SeatSpecSchema.safeParse({ provider: "mock", count: 0 }).success).toBe(false);
    expect(SeatSpecSchema.safeParse({ provider: "mock", count: 9 }).success).toBe(false);
    expect(SeatSpecSchema.safeParse({ provider: "mock", count: 8 }).success).toBe(true);
  });

  it("requires kebab-case roles", () => {
    expect(SeatSpecSchema.safeParse({ provider: "mock", role: "Security Reviewer" }).success).toBe(false);
  });
});

describe("expandSeatSpecs", () => {
  it("expands counts with numbered display names", () => {
    const seats = expandSeatSpecs([
      { provider: "claude-code", model: "opus", count: 3, permissions: "edit", role: "engineer" },
      { provider: "codex", model: "sol", count: 2, permissions: "edit", role: "engineer" },
    ]);
    expect(seats.map((s) => s.displayName)).toEqual([
      "Opus#1",
      "Opus#2",
      "Opus#3",
      "Sol#1",
      "Sol#2",
    ]);
    expect(seats.map((s) => s.id)).toEqual(["opus-1", "opus-2", "opus-3", "sol-1", "sol-2"]);
    expect(seats.every((s) => s.transport === "cli" && s.permissions === "edit")).toBe(true);
  });

  it("continues numbering across specs with the same base (no collisions)", () => {
    const seats = expandSeatSpecs([
      { provider: "claude-code", model: "opus" },
      { provider: "cursor", model: "opus", count: 2 },
    ]);
    expect(seats.map((s) => s.displayName)).toEqual(["Opus#1", "Opus#2", "Opus#3"]);
    expect(new Set(seats.map((s) => s.id)).size).toBe(3);
    expect(seats[1]!.provider).toBe("cursor");
  });

  it("uses provider label for AUTO, custom names, and team prefixes", () => {
    const seats = expandSeatSpecs(
      [
        { provider: "gemini", count: 2 },
        { provider: "codex", name: "Critic" },
      ],
      { teamName: "Review Panel" },
    );
    expect(seats.map((s) => s.displayName)).toEqual(["Gemini#1", "Gemini#2", "Critic#1"]);
    expect(seats.map((s) => s.id)).toEqual([
      "review-panel.gemini-1",
      "review-panel.gemini-2",
      "review-panel.critic-1",
    ]);
    expect(seats[0]!.transport).toBe("api");
    expect(seats[0]!.teamName).toBe("Review Panel");
  });

  it("keeps ids unique when different bases slugify the same", () => {
    const seats = expandSeatSpecs([
      { provider: "mock", name: "Opus" },
      { provider: "mock", name: "opus" },
    ]);
    expect(seats.map((s) => s.id)).toEqual(["opus-1", "opus-1-2"]);
  });

  it("is deterministic", () => {
    const specs = [
      { provider: "claude-code", model: "opus", count: 2 },
      { provider: "openai", model: "gpt-x" },
    ] as const;
    expect(expandSeatSpecs(specs)).toEqual(expandSeatSpecs(specs));
  });

  it("shortens path-style model ids", () => {
    expect(modelShortName("opencode", "anthropic/claude-sonnet")).toBe("Claude-sonnet");
    expect(modelShortName("codex", "AUTO")).toBe("Codex");
  });
});

describe("team and session schemas", () => {
  it("parses the plan's team example", () => {
    const doc = parseYaml(`
teams:
  heavy-negotiators:
    seats:
      - { provider: claude-code, model: opus, count: 3, role: engineer }
      - { provider: codex, model: "some-codex-model", count: 2, role: engineer }
  review-panel:
    seats:
      - { provider: claude-code, model: sonnet, role: security-reviewer }
      - { provider: gemini, transport: api, model: AUTO, role: code-reviewer, count: 2 }
      - { provider: codex, role: test-reviewer }
`) as { teams: Record<string, unknown> };
    const teams = Object.fromEntries(
      Object.entries(doc.teams).map(([name, team]) => [name, TeamSchema.parse(team)]),
    );
    expect(expandSeatSpecs(teams["heavy-negotiators"]!.seats)).toHaveLength(5);
    expect(expandSeatSpecs(teams["review-panel"]!.seats)).toHaveLength(4);
  });

  it("rejects empty teams", () => {
    expect(TeamSchema.safeParse({ seats: [] }).success).toBe(false);
  });

  it("validates stage references", () => {
    const ok = SessionSpecSchema.safeParse({
      title: "Feature",
      goal: "Add login",
      stages: [
        { id: "plan", kind: "negotiate", team: "heavy", next: "build" },
        { id: "build", kind: "execute", next: "review" },
        { id: "review", kind: "review", onNeedsWork: "build" },
      ],
    });
    expect(ok.success).toBe(true);

    const bad = SessionSpecSchema.safeParse({
      title: "x",
      goal: "y",
      stages: [
        { id: "a", kind: "plan", next: "missing" },
        { id: "a", kind: "review" },
      ],
    });
    expect(bad.success).toBe(false);
    const messages = bad.success ? [] : bad.error.issues.map((i) => i.message);
    expect(messages).toContain('duplicate stage id "a"');
    expect(messages).toContain('unknown stage id "missing"');
  });
});

describe("engine events", () => {
  const base = { seq: 1, sessionId: "s-1", at: "2026-10-24T10:00:00.000Z" };

  it("round-trips through JSON", () => {
    const event = parseEngineEvent({
      ...base,
      seatId: "opus-1",
      type: "seat.status",
      data: { status: "thinking", detail: "reading files" },
    });
    expect(parseEngineEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("validates payloads by type and keeps unknown fields", () => {
    const event = parseEngineEvent({
      ...base,
      type: "seat.tokens",
      data: { tokensIn: 10, tokensOut: 5, extra: "kept" },
    });
    expect(event.data).toMatchObject({ extra: "kept" });

    const bad = safeParseEngineEvent({ ...base, type: "seat.status", data: { status: "napping" } });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]!.path[0]).toBe("data");
    }
  });

  it("rejects unknown types and bad envelopes", () => {
    expect(safeParseEngineEvent({ ...base, type: "seat.dance", data: {} }).success).toBe(false);
    expect(safeParseEngineEvent({ ...base, seq: 0, type: "round.started", data: { round: 1 } }).success).toBe(false);
    expect(safeParseEngineEvent({ ...base, at: "yesterday", type: "round.started", data: { round: 1 } }).success).toBe(false);
  });

  it("narrows data on type", () => {
    const event: EngineEvent = parseEngineEvent({
      ...base,
      type: "negotiation.consensus",
      data: { round: 2, score: 0.8, reached: true, preferred: "Proposal B" },
    });
    if (event.type === "negotiation.consensus") {
      expect(event.data.reached).toBe(true);
    } else {
      throw new Error("expected consensus event");
    }
  });

  it("has a non-empty catalog without duplicates", () => {
    expect(new Set(ENGINE_EVENT_TYPES).size).toBe(ENGINE_EVENT_TYPES.length);
  });
});

describe("fromSupervisorEvent", () => {
  // Record<SupervisorEventType, …> makes this list exhaustive at compile time.
  const SAMPLES: Record<SupervisorEventType, Record<string, unknown> | undefined> = {
    "state.changed": { from: "EXECUTING", to: "REVIEWING", reason: "done" },
    "round.started": { round: 1 },
    "round.completed": { round: 1, state: "EXECUTING" },
    "executor.started": { round: 1 },
    "executor.completed": { status: "completed", summary: "edited 2 files" },
    "executor.failed": { error: "timeout" },
    "executor.retry": { attempt: 1, maxAttempts: 3, delayMs: 2000 },
    "executor.interrupted": { round: 1, reason: "Interrupted to switch models" },
    "review.started": { round: 1 },
    "review.completed": { status: "PASS", summary: "ok", confidence: 0.9 },
    "review.retry": { attempt: 2, maxAttempts: 3, delayMs: 4000 },
    "evidence.requested": { count: 2 },
    "evidence.fulfilled": { count: 3, files: ["a.ts"] },
    "change.requested": { requiredChanges: ["fix x"] },
    "verification.started": { commands: {} },
    "verification.passed": { slots: [] },
    "verification.failed": { failures: [] },
    "loop.detected": { fingerprint: "abc", count: 3, rounds: [1, 2, 3] },
    "budget.exceeded": { kind: "round" },
    "task.completed": { round: 2 },
    "task.blocked": { reason: "loop_detected" },
    "task.failed": undefined,
  };

  it.each(Object.entries(SAMPLES) as Array<[SupervisorEventType, Record<string, unknown> | undefined]>)(
    "maps %s to a valid engine event",
    (type, data) => {
      const draft = fromSupervisorEvent(
        { type, at: "2026-10-24T10:00:00.000Z", ...(data ? { data } : {}) },
        { sessionId: "s-1", executorSeatId: "opus-1", reviewerSeatId: "panel" },
      );
      expect(draft.type).toBe(engineTypeForSupervisorEvent(type));
      expect(draft.data).toMatchObject({ legacyType: type, ...(data ?? {}) });
      const event = parseEngineEvent({ ...draft, seq: 1 });
      expect(event.type).toBe(draft.type);
    },
  );

  it("scopes executor and reviewer events to seats", () => {
    const ctx = { sessionId: "s-1", executorSeatId: "opus-1", reviewerSeatId: "panel" };
    expect(fromSupervisorEvent({ type: "executor.started", at: base() }, ctx).seatId).toBe("opus-1");
    expect(fromSupervisorEvent({ type: "review.started", at: base() }, ctx).seatId).toBe("panel");
    expect(fromSupervisorEvent({ type: "round.started", at: base(), data: { round: 1 } }, ctx).seatId).toBeUndefined();
    expect(fromSupervisorEvent({ type: "executor.started", at: base() }, { sessionId: "s" }).seatId).toBe("executor");
  });

  it("fills required payload fields from legacy data", () => {
    const failed = fromSupervisorEvent(
      { type: "executor.failed", at: base(), data: { error: "rate limited" } },
      { sessionId: "s-1" },
    );
    expect(failed).toMatchObject({ type: "seat.error", data: { message: "rate limited" } });

    const gate = fromSupervisorEvent({ type: "verification.failed", at: base() }, { sessionId: "s-1" });
    expect(gate).toMatchObject({ type: "gate.result", data: { passed: false } });
  });

  function base(): string {
    return "2026-10-24T10:00:00.000Z";
  }
});
