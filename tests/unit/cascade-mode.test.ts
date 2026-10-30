import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createId,
  expandSeatSpecs,
  getMode,
  MockReviewer,
  ModeValidationError,
  PanelReviewer,
  parseAssentorConfig,
  prepareModeSession,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type ModeControllerInput,
  type StageRunnerDeps,
  type StageSpec,
} from "../../src/index.js";
import { SeatScheduler } from "../../src/seats/index.js";
import { cascadeProblems, createCascadeController, type CascadeExtras } from "../../src/modes/cascade.js";
import type { MockReviewerStep } from "../../src/providers/reviewers/mock/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const GOAL = "Add an average() helper";
const edit = (model: string, provider = "mock") => ({ seats: [{ provider, model, permissions: "edit" }] });
const readOnly = (model: string, provider = "mock") => ({
  seats: [{ provider, model, role: "code-reviewer", permissions: "read-only" }],
});

const baseConfig = {
  teams: { cheap: edit("a"), mid: edit("b"), top: edit("c"), r1: readOnly("x"), r2: readOnly("y"), r3: readOnly("z") },
  modes: {
    cascade: {
      tiers: [
        { team: "cheap", reviewTeam: "r1", maxRounds: 2 },
        { team: "mid", reviewTeam: "r2", maxRounds: 1 },
        { team: "top", reviewTeam: "r3", maxRounds: 1 },
      ],
    },
  },
};
const config = parseAssentorConfig(baseConfig);
const withCascade = (cascade: unknown, teams: unknown = baseConfig.teams, extra: unknown = {}) =>
  parseAssentorConfig({ teams, modes: { cascade }, ...(extra as object) });

const needsWork = (n: number): MockReviewerStep[] =>
  Array.from({ length: n }, () => ({ type: "needs_work" as const, requiredChanges: ["handle an empty list"] }));

interface Script {
  /** Reviewer steps by review team. */
  review?: Record<string, MockReviewerStep[]>;
  /** Executor result by implementing team; throw to fail the tier. */
  exec?: Record<string, () => Promise<ExecutorResult>>;
}

function setup(script: Script = {}, over: Partial<StageRunnerDeps> = {}) {
  const prompts: Array<{ team: string; prompt: string }> = [];
  const events: EngineEventDraft[] = [];
  const deps = async (): Promise<StageRunnerDeps> => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-"));
    dirs.push(projectPath);
    return {
      projectPath,
      scheduler: new SeatScheduler({ sessionId: "s", backoffBaseMs: 1 }),
      runStep: async () => {
        throw new Error("no negotiation expected");
      },
      seatsFor: (stage: StageSpec) => expandSeatSpecs(config.teams[stage.team!]!.seats, { teamName: stage.team! }),
      createExecutor: (stage): Executor => {
        const team = stage.team!;
        const exec = {
          name: `exec-${team}`,
          capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
          run: async (task: { prompt: string }) => {
            prompts.push({ team, prompt: task.prompt });
            return script.exec?.[team] ? script.exec[team]!() : { status: "completed" as const, summary: "done" };
          },
          continue: async () => ({ status: "completed" as const, summary: "done" }),
          cancel: async () => undefined,
        };
        return exec;
      },
      createReviewer: (stage) =>
        new PanelReviewer({
          name: "panel",
          policy: "majority",
          reviewers: [new MockReviewer({ name: "r", steps: [...(script.review?.[stage.team!] ?? [])] })],
        }),
      supervisor: { skipGates: true },
      ...over,
    };
  };
  return { prompts, events, deps };
}

interface RunOptions {
  autonomy?: "manual" | "supervised" | "autopilot";
  goal?: string;
  cfg?: typeof config;
  extras?: CascadeExtras;
  signal?: AbortSignal;
}

async function run(script: Script, options: RunOptions = {}) {
  const s = setup(script);
  const cascade = {
    ...getMode("cascade")!,
    createController: (input: ModeControllerInput) => createCascadeController(input, { readChanges: async () => ({ files: [], diff: "" }), ...options.extras }),
  };
  const session = prepareModeSession({
    mode: cascade,
    sessionId: createId(),
    goal: options.goal ?? GOAL,
    autonomy: options.autonomy ?? "autopilot",
    config: options.cfg ?? config,
    deps: await s.deps(),
    emit: (e) => void s.events.push(e),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const result = await session.run();
  const escalated = s.events.filter((e) => e.type === "cascade.escalated").map((e) => e.data as Record<string, unknown>);
  return { ...s, result, escalated };
}

describe("cascadeProblems", () => {
  it("accepts a valid ladder", () => {
    expect(cascadeProblems(config)).toEqual([]);
  });

  it("needs at least two tiers", () => {
    expect(cascadeProblems(parseAssentorConfig({}))[0]).toContain("at least two tiers");
    expect(cascadeProblems(withCascade({ tiers: [{ team: "cheap", reviewTeam: "r1" }] }))[0]).toContain("at least two tiers");
  });

  it("reports unknown teams, a missing edit seat, and a missing reviewTeam", () => {
    const problems = cascadeProblems(
      withCascade({ tiers: [{ team: "ghost", reviewTeam: "r1" }, { team: "r2", reviewTeam: "nope" }, { team: "top" }] }),
    );
    expect(problems).toEqual([
      'modes.cascade.tiers[0]: unknown team "ghost"',
      'modes.cascade.tiers[1]: team "r2" has no edit seat',
      'modes.cascade.tiers[1]: unknown reviewTeam "nope"',
      "modes.cascade.tiers[2]: no reviewTeam, and modes.review.team is not set",
    ]);
  });

  it("modes.review.team is the default reviewTeam", () => {
    const cfg = withCascade({ tiers: [{ team: "cheap" }, { team: "top" }] }, baseConfig.teams, { modes: { review: { team: "r1" }, cascade: { tiers: [{ team: "cheap" }, { team: "top" }] } } });
    expect(cascadeProblems(cfg)).toEqual([]);
  });

  it("never self-review: another team, read-only, and not cheaper than the implementer", () => {
    expect(cascadeProblems(withCascade({ tiers: [{ team: "cheap", reviewTeam: "cheap" }, { team: "top", reviewTeam: "r1" }] }))).toContain(
      'modes.cascade.tiers[0]: a tier cannot review its own team "cheap"',
    );
    const editReviewer = cascadeProblems(withCascade({ tiers: [{ team: "cheap", reviewTeam: "mid" }, { team: "top", reviewTeam: "r1" }] }));
    expect(editReviewer).toHaveLength(1);
    expect(editReviewer[0]).toMatch(/^modes\.cascade\.tiers\[0\]: reviewer seat ".+" must be read-only$/);
    const teams = { strong: edit("opus", "claude-code"), weakReview: readOnly("haiku", "claude-code"), strongReview: readOnly("opus", "claude-code") };
    const weak = cascadeProblems(withCascade({ tiers: [{ team: "strong", reviewTeam: "weakReview" }, { team: "strong", reviewTeam: "strongReview" }] }, teams));
    expect(weak).toHaveLength(1);
    expect(weak[0]).toContain("cheaper than the implementers");
  });
});

describe("cascade config schema", () => {
  it("existing configs parse unchanged and tiers stay optional", () => {
    expect(parseAssentorConfig({}).modes.cascade).toBeUndefined();
    expect(parseAssentorConfig({ modes: { cascade: { dangerAreas: [] } } }).modes.cascade).toEqual({ dangerAreas: [] });
    expect(parseAssentorConfig({ modes: { cascade: { tiers: [{ team: "a" }] } } }).modes.cascade).toEqual({ tiers: [{ team: "a" }] });
  });

  it("rejects malformed tiers", () => {
    for (const tiers of [[], [{ id: "fast" }], [{ team: "" }], [{ team: "a", maxRounds: 0 }], [{ team: "a", maxRounds: 11 }], [{ team: "a", extra: 1 }], Array(7).fill({ team: "a" })]) {
      expect(() => parseAssentorConfig({ modes: { cascade: { tiers } } })).toThrow();
    }
  });
});

describe("cascade mode, end to end (mock seats)", () => {
  it("is registered as a dynamic, runnable mode that is not CLI-available", () => {
    const mode = getMode("cascade")!;
    expect(mode.kind).toBe("dynamic");
    expect(mode.createController).toBeTypeOf("function");
    expect(mode.available).toBe(false);
  });

  it("is refused before anything starts when the tiers are missing", async () => {
    const s = setup();
    try {
      prepareModeSession({ mode: "cascade", sessionId: createId(), goal: GOAL, autonomy: "autopilot", config: parseAssentorConfig({}), deps: await s.deps() });
      throw new Error("expected a ModeValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ModeValidationError);
      expect((error as ModeValidationError).problems[0]).toContain("at least two tiers");
    }
    expect(s.events).toEqual([]);
  });

  it("the cheap tier passing finishes the session with no escalation and records the tier", async () => {
    const records: unknown[] = [];
    const { result, prompts, escalated, events } = await run({}, { extras: { onTierSucceeded: (r) => void records.push(r) } });
    expect(result).toMatchObject({ status: "completed", mode: "cascade" });
    expect(prompts.map((p) => p.team)).toEqual(["cheap"]);
    expect(escalated).toEqual([]);
    expect(records).toEqual([{ tier: 0, team: "cheap", reviewTeam: "r1", escalations: 0 }]);
    expect(events[0]).toMatchObject({ type: "mode.selected", data: { mode: "cascade", kind: "dynamic" } });
  });

  it("escalates after N NEEDS_WORK rounds, hands over the findings, and records the successful tier", async () => {
    const records: Array<{ tier: number; escalations: number }> = [];
    const { result, prompts, escalated } = await run(
      { review: { r1: needsWork(2) } },
      { extras: { onTierSucceeded: (r) => void records.push(r) } },
    );
    expect(result).toMatchObject({ status: "completed" });
    expect(String(escalated[0]?.reason)).toContain("after 2 rounds"); // maxRounds 2
    expect(prompts.at(-1)?.team).toBe("mid");
    expect(prompts.at(-1)?.prompt).toContain("handle an empty list");
    expect(escalated).toEqual([expect.objectContaining({ fromTier: 0, toTier: 1, trigger: "needs_work" })]);
    expect(records).toMatchObject([{ tier: 1, escalations: 1 }]);
    expect(result.reason).toContain("tier 2 of 3");
  });

  it("escalates through every tier and blocks when the top tier still needs work", async () => {
    const { result, escalated, prompts } = await run({ review: { r1: needsWork(2), r2: needsWork(1), r3: needsWork(1) } });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("top tier (top) ended needs_work");
    expect(escalated.map((e) => [e.fromTier, e.toTier, e.trigger])).toEqual([[0, 1, "needs_work"], [1, 2, "needs_work"]]);
    expect(prompts.at(-1)?.team).toBe("top");
  });

  it("escalates when the reviewer blocks the tier", async () => {
    const { result, escalated } = await run({ review: { r1: [{ type: "blocked", summary: "needs a human decision" }] } });
    expect(result.status).toBe("completed");
    expect(escalated).toEqual([expect.objectContaining({ toTier: 1, trigger: "blocked" })]);
  });

  it("escalates when the tier's seats fail; a failure at the top tier fails the session", async () => {
    const boom = async (): Promise<ExecutorResult> => {
      throw new Error("provider crashed");
    };
    const recovered = await run({ exec: { cheap: boom } });
    expect(recovered.result.status).toBe("completed");
    expect(recovered.escalated).toEqual([expect.objectContaining({ toTier: 1, trigger: "tier_failed" })]);
    expect(String(recovered.escalated[0]?.reason)).toContain("provider crashed");

    const failed = await run({ exec: { cheap: boom, mid: boom, top: boom } });
    expect(failed.result.status).toBe("failed");
    expect(failed.escalated.map((e) => e.trigger)).toEqual(["tier_failed", "tier_failed"]);
  });

  it("a failing verification gate is a NEEDS_WORK round and escalates", async () => {
    let gateRuns = 0;
    const gates = {
      verification: {
        enabled: true,
        commands: { typecheck: "", test: "check", lint: "", build: "" },
        skipReviewOnFailure: { typecheck: true, build: true, test: true, lint: false },
      },
      runVerificationCommand: async () => (gateRuns++ < 2 ? { stdout: "", stderr: "1 test failed", code: 1 } : { stdout: "ok", stderr: "", code: 0 }),
    };
    const s = setup({}, { supervisor: gates as never });
    const session = prepareModeSession({
      mode: { ...getMode("cascade")!, createController: (i) => createCascadeController(i, { readChanges: async () => ({ files: [], diff: "" }) }) },
      sessionId: createId(),
      goal: GOAL,
      autonomy: "autopilot",
      config,
      deps: await s.deps(),
      emit: (e) => void s.events.push(e),
    });
    expect(await session.run()).toMatchObject({ status: "completed" });
    expect(s.events.filter((e) => e.type === "cascade.escalated").map((e) => (e.data as unknown as { trigger: string }).trigger)).toEqual(["needs_work"]);
    expect(s.prompts.at(-1)?.team).toBe("mid");
  });
});

describe("danger", () => {
  const dangerGoal = "Use the credentials from the secrets vault to rotate the signing key";

  it("a danger task starts on the top tier; autopilot asks nothing", async () => {
    const asked: string[] = [];
    const { result, prompts, escalated } = await run({}, { goal: dangerGoal, extras: { approve: async (s) => (asked.push(s), true) } });
    expect(result.status).toBe("completed");
    expect(prompts.map((p) => p.team)).toEqual(["top"]);
    expect(escalated).toEqual([expect.objectContaining({ fromTier: 0, toTier: 2, trigger: "danger" })]);
    expect(prompts[0]?.prompt).toContain("danger area");
    expect(asked).toEqual([]);
  });

  it("supervised asks before a danger start; a refusal ends blocked before the top tier runs", async () => {
    const asked: string[] = [];
    const denied = await run({}, { autonomy: "supervised", goal: dangerGoal, extras: { approve: async (s) => (asked.push(s), false) } });
    expect(asked).toHaveLength(1);
    expect(denied.result.status).toBe("blocked");
    expect(denied.result.reason).toContain("not approved");
    expect(denied.prompts).toEqual([]);

    const allowed = await run({}, { autonomy: "supervised", goal: dangerGoal, extras: { approve: async () => true } });
    expect(allowed.result.status).toBe("completed");
    expect(allowed.prompts.map((p) => p.team)).toEqual(["top"]);
  });

  it("supervised without an approval channel blocks a danger start", async () => {
    const { result, prompts } = await run({}, { autonomy: "supervised", goal: dangerGoal });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("no approval channel");
    expect(prompts).toEqual([]);
  });

  it("supervised does not ask for an ordinary task", async () => {
    const asked: string[] = [];
    const { result } = await run({}, { autonomy: "supervised", extras: { approve: async (s) => (asked.push(s), true) } });
    expect(result.status).toBe("completed");
    expect(asked).toEqual([]);
  });

  it("danger in the diff after a passing tier jumps to the top tier with approval", async () => {
    const asked: string[] = [];
    let calls = 0;
    const diff = [
      "diff --git a/src/process/kill.ts b/src/process/kill.ts",
      "index 1111111..2222222 100644",
      "--- a/src/process/kill.ts",
      "+++ b/src/process/kill.ts",
      "@@ -1,1 +1,2 @@",
      " export {};",
      "+process.kill(pid, 'SIGKILL');",
      "",
    ].join("\n");
    const { result, prompts, escalated } = await run(
      {},
      {
        autonomy: "supervised",
        extras: {
          approve: async (s) => (asked.push(s), true),
          readChanges: async () => (calls++ === 0 ? { files: [], diff: "" } : { files: ["src/process/kill.ts"], diff }),
        },
      },
    );
    expect(result.status).toBe("completed");
    expect(prompts.map((p) => p.team)).toEqual(["cheap", "top"]);
    expect(escalated).toEqual([expect.objectContaining({ fromTier: 0, toTier: 2, trigger: "danger" })]);
    expect(escalated[0]?.categories).toBeTruthy();
    expect(asked).toHaveLength(1);
    expect(prompts[1]?.prompt).toContain("danger area");
  });

  it("danger that was already in the working tree at the start is not blamed on the tier", async () => {
    const dirty = { files: ["src/process/kill.ts"], diff: "" };
    const { result, prompts, escalated } = await run({}, { extras: { readChanges: async () => dirty } });
    expect(result.status).toBe("completed");
    expect(prompts.map((p) => p.team)).toEqual(["cheap"]);
    expect(escalated).toEqual([]);
  });

  it("changes that cannot be read count as danger", async () => {
    const { result, escalated } = await run({}, { extras: { readChanges: async () => { throw new Error("git exploded"); } } });
    expect(result.status).toBe("completed");
    expect(escalated).toEqual([expect.objectContaining({ toTier: 2, trigger: "danger", categories: ["unscanned"] })]);
  });

  it("modes.cascade.dangerAreas extend the built-in rules", async () => {
    const cfg = parseAssentorConfig({
      ...baseConfig,
      modes: { cascade: { ...baseConfig.modes.cascade, dangerAreas: [{ name: "billing", keywords: ["invoice ledger"] }] } },
    });
    const { prompts } = await run({}, { cfg, goal: "Rework the invoice ledger rounding" });
    expect(prompts.map((p) => p.team)).toEqual(["top"]);
  });
});

describe("autonomy, cancel and budget", () => {
  it("manual refuses to start without an approval channel", async () => {
    const { result, prompts } = await run({}, { autonomy: "manual" });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("approval channel");
    expect(prompts).toEqual([]);
  });

  it("manual asks before every tier", async () => {
    const asked: string[] = [];
    const { result, prompts } = await run({ review: { r1: needsWork(2) } }, { autonomy: "manual", extras: { approve: async (s) => (asked.push(s), true) } });
    expect(result.status).toBe("completed");
    expect(asked).toHaveLength(2);
    expect(prompts.at(-1)?.team).toBe("mid");
  });

  it("an abort while waiting for approval settles as cancelled", async () => {
    const ctl = new AbortController();
    const { result, prompts } = await run({}, { autonomy: "manual", signal: ctl.signal, extras: { approve: () => { queueMicrotask(() => ctl.abort()); return new Promise<boolean>(() => undefined); } } });
    expect(result).toMatchObject({ status: "cancelled", reason: "cancelled" });
    expect(prompts).toEqual([]);
  });

  it("a budget stop ends the session and never escalates", async () => {
    const calls: string[] = [];
    const input = {
      sessionId: createId(),
      goal: GOAL,
      title: GOAL,
      autonomy: "autopilot",
      config,
      deps: { projectPath: "/nonexistent" },
      signal: new AbortController().signal,
      emit: () => undefined,
      stages: {
        negotiate: async () => ({ outcome: "pass", summary: "" }),
        execute: async (i: { stage: StageSpec }) => (calls.push(i.stage.team!), { outcome: "budget", summary: "out of tokens" }),
      },
    } as unknown as ModeControllerInput;
    const result = await createCascadeController(input, { readChanges: async () => ({ files: [], diff: "" }) }).run();
    expect(result).toEqual({ status: "budget_exceeded", reason: "out of tokens" });
    expect(calls).toEqual(["cheap"]);
  });
});
