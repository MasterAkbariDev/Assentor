import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
} from "../../packages/engine/src/index.js";
import { SeatScheduler } from "../../packages/engine/src/seats/index.js";
import { cascadeProblems, createCascadeController, type CascadeExtras } from "../../packages/engine/src/modes/cascade.js";
import type { MockReviewerStep } from "../../packages/engine/src/providers/reviewers/mock/index.js";

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
  const deps = async (existing?: string): Promise<StageRunnerDeps> => {
    const projectPath = existing ?? (await fs.mkdtemp(path.join(os.tmpdir(), "cascade-")));
    if (!existing) dirs.push(projectPath);
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
  /** Use this directory and the real git reader (no `readChanges` stub). */
  projectPath?: string;
}

async function run(script: Script, options: RunOptions = {}) {
  const s = setup(script);
  const cascade = {
    ...getMode("cascade")!,
    createController: (input: ModeControllerInput) =>
      createCascadeController(input, { ...(options.projectPath ? {} : { readChanges: async () => ({ files: [], diff: "" }) }), ...options.extras }),
  };
  // The session itself asks before each stage under manual (T02B-02); approve those so only cascade's own asks are counted.
  let session: ReturnType<typeof prepareModeSession> | undefined;
  session = prepareModeSession({
    mode: options.projectPath ? "cascade" : cascade, // a real project path uses the registry controller as shipped
    sessionId: createId(),
    goal: options.goal ?? GOAL,
    autonomy: options.autonomy ?? "autopilot",
    config: options.cfg ?? config,
    deps: await s.deps(options.projectPath),
    emit: (e) => {
      s.events.push(e);
      if (e.type === "user.question") {
        const { questionId } = e.data as unknown as { questionId: string };
        queueMicrotask(() => session!.answer(questionId, "approve"));
      }
    },
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
    expect(escalated).toEqual([expect.objectContaining({ toTier: 2, trigger: "danger_start" })]);
    expect(escalated[0]).not.toHaveProperty("fromTier"); // no lower tier ran
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

const killDiff = (extra = "process.kill(pid, 'SIGKILL');") =>
  [
    "diff --git a/src/process/kill.ts b/src/process/kill.ts",
    "index 1111111..2222222 100644",
    "--- a/src/process/kill.ts",
    "+++ b/src/process/kill.ts",
    "@@ -1,1 +1,2 @@",
    " export {};",
    `+${extra}`,
    "",
  ].join("\n");

describe("danger after every tier, not only after a pass", () => {
  /** Reads: the clean start, then `after` for every later call. */
  const afterStart = (after: { files: string[]; diff: string }) => {
    let calls = 0;
    return async () => (calls++ === 0 ? { files: [], diff: "" } : after);
  };

  it("a tier that edits a danger path and ends NEEDS_WORK jumps to the top tier, asking first under supervised", async () => {
    const asked: string[] = [];
    const { result, prompts, escalated } = await run(
      { review: { r1: needsWork(2) } },
      {
        autonomy: "supervised",
        extras: { approve: async (q) => (asked.push(q), true), readChanges: afterStart({ files: ["src/process/kill.ts"], diff: killDiff() }) },
      },
    );
    expect(result.status).toBe("completed");
    expect(prompts.map((p) => p.team)).toEqual(["cheap", "top"]); // mid never ran
    expect(escalated).toEqual([expect.objectContaining({ fromTier: 0, toTier: 2, trigger: "danger" })]);
    expect(asked).toHaveLength(1);
  });

  it("a tier that crashes after editing a danger path still gets the danger check", async () => {
    const { escalated, prompts } = await run(
      { exec: { cheap: async () => { throw new Error("provider crashed"); } } },
      { extras: { readChanges: afterStart({ files: ["src/process/kill.ts"], diff: killDiff() }) } },
    );
    expect(escalated.map((e) => [e.toTier, e.trigger])).toEqual([[2, "danger"]]);
    expect(prompts.at(-1)?.team).toBe("top");
  });

  it("new danger in an already-dirty category is not hidden by the baseline", async () => {
    const dirty = { files: ["src/process/kill.ts"], diff: "" };
    let calls = 0;
    const { prompts, escalated } = await run(
      {},
      { extras: { readChanges: async () => (calls++ === 0 ? dirty : { files: dirty.files, diff: killDiff("child_process.spawn('rm', ['-rf', dir]);") }) } },
    );
    expect(escalated.map((e) => e.trigger)).toEqual(["danger"]);
    expect(prompts.map((p) => p.team)).toEqual(["cheap", "top"]);
    expect(escalated[0]?.categories).not.toContain("unscanned");
  });

  it("a cut-off reasons list cannot be compared with the start, so it counts as danger", async () => {
    const many = { files: Array.from({ length: 60 }, (_, i) => `src/process/f${i}.ts`), diff: "" };
    const { escalated } = await run({}, { extras: { readChanges: async () => many } });
    expect(escalated.map((e) => e.trigger)).toEqual(["danger"]);
  });
});

describe("incomparable unscanned reasons", () => {
  const sameBothTimes = (unscanned: string[]) => ({ extras: { readChanges: async () => ({ files: [], diff: "", unscanned }) } });

  it("a cut-off list of unscanned files counts as new danger even if it reads the same as at the start", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `untracked file "f${i}" (1 bytes, mtime 1) could not be read: x`);
    const { escalated } = await run({}, sameBothTimes(many));
    expect(escalated.map((e) => e.trigger)).toEqual(["danger"]);
  });

  it("the 'were not scanned' count reason (files past the path cap) counts as new danger", async () => {
    const { escalated } = await run({}, sameBothTimes(["7 untracked files past the first 5000 were not scanned"]));
    expect(escalated.map((e) => e.trigger)).toEqual(["danger"]);
  });

  it("a short per-file unscanned reason that reads the same as at the start is not blamed on the tier", async () => {
    const { escalated } = await run({}, sameBothTimes(['untracked file "big" (2000000 bytes, mtime 1) is over the 1000000 byte scan limit']));
    expect(escalated).toEqual([]);
  });
});

describe("tier outcome record and warnings", () => {
  it("emits cascade.tier_succeeded with the triggers; a throwing callback does not fail the session", async () => {
    const { result, events } = await run(
      { review: { r1: needsWork(2) } },
      { extras: { onTierSucceeded: () => { throw new Error("scoreboard down"); } } },
    );
    expect(result.status).toBe("completed");
    expect(events.filter((e) => e.type === "cascade.tier_succeeded").map((e) => e.data)).toEqual([
      { tier: 1, team: "mid", escalations: 1, triggers: ["needs_work"] },
    ]);
  });

  it("a danger start is not counted as an escalation", async () => {
    const { events } = await run({}, { goal: "Use the credentials from the secrets vault to rotate the signing key" });
    expect(events.find((e) => e.type === "cascade.tier_succeeded")?.data).toEqual({ tier: 2, team: "top", escalations: 0, triggers: [] });
  });

  it("the top tier ending blocked ends the session blocked", async () => {
    const { result, escalated } = await run({
      review: { r1: [{ type: "blocked" }], r2: [{ type: "blocked" }], r3: [{ type: "blocked", summary: "needs a human" }] },
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("top tier (top) ended blocked");
    expect(escalated.map((e) => e.trigger)).toEqual(["blocked", "blocked"]);
  });

  it("warns when a reviewer seat uses the same provider/model as an implementer", async () => {
    const teams = { ...baseConfig.teams, same: { seats: [{ provider: "mock", model: "a", permissions: "read-only" }] } };
    const cfg = parseAssentorConfig({
      teams,
      modes: { cascade: { tiers: [{ team: "cheap", reviewTeam: "same" }, { team: "top", reviewTeam: "r3" }] } },
    });
    const { events } = await run({}, { cfg });
    const warnings = events.filter((e) => e.type === "session.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({ kind: "cascade.self_review" });
    expect(String((warnings[0]?.data as { message?: string }).message)).toContain("tiers[0]");
  });
});

// Real git processes: slow under load, like the other real-git suites.
describe("the default git reader (registry controller)", { timeout: 60_000 }, () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

  async function repo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-git-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    return dir;
  }

  it("an untracked new file whose content spawns a process escalates to the top tier", async () => {
    const dir = await repo();
    const write = (name: string, body: string) => async (): Promise<ExecutorResult> => {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), body);
      return { status: "completed", summary: "done" };
    };
    const { result, escalated, prompts } = await run(
      { exec: { cheap: write("src/helper.ts", 'import { spawn } from "node:child_process";\nspawn("sh", ["-c", cmd]);\n') } },
      { projectPath: dir },
    );
    expect(result.status).toBe("completed");
    expect(prompts.map((p) => p.team)).toEqual(["cheap", "top"]);
    expect(escalated).toEqual([expect.objectContaining({ fromTier: 0, toTier: 2, trigger: "danger" })]);
    expect(git(dir, "status", "--porcelain")).toContain("?? src/"); // nothing was staged by the check
  });

  it("an untracked harmless file does not escalate", async () => {
    const dir = await repo();
    const { result, escalated, prompts } = await run(
      { exec: { cheap: async () => (await fs.writeFile(path.join(dir, "notes.txt"), "average = sum / n\n"), { status: "completed" as const, summary: "done" }) } },
      { projectPath: dir },
    );
    expect(result.status).toBe("completed");
    expect(escalated).toEqual([]);
    expect(prompts.map((p) => p.team)).toEqual(["cheap"]);
  });

  const writer = (dir: string, name: string, body: string) => async (): Promise<ExecutorResult> => {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
    return { status: "completed", summary: "done" };
  };

  it("an empty untracked file is nothing to scan and does not escalate", async () => {
    const dir = await repo();
    const { escalated } = await run({ exec: { cheap: writer(dir, "empty.txt", "") } }, { projectPath: dir });
    expect(escalated).toEqual([]);
  });

  it("a directory symlink added by a tier cannot be diffed and escalates as unscanned", async () => {
    const dir = await repo();
    await fs.mkdir(path.join(dir, "real"));
    const link = async (): Promise<ExecutorResult> => (await fs.symlink(path.join(dir, "real"), path.join(dir, "data")), { status: "completed", summary: "done" });
    const { escalated, prompts } = await run({ exec: { cheap: link } }, { projectPath: dir });
    expect(escalated).toEqual([expect.objectContaining({ fromTier: 0, toTier: 2, trigger: "danger" })]);
    expect(String(escalated[0]?.reason)).toContain("could not be read");
    expect(prompts.map((p) => p.team)).toEqual(["cheap", "top"]);
  });

  it("one oversized untracked file is unscanned for itself only: the cascade stays usable", async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, "big.bin.txt"), "x".repeat(1_200_000)); // at the start
    const calm = await run({}, { projectPath: dir });
    expect(calm.escalated).toEqual([]);
    expect(calm.prompts.map((p) => p.team)).toEqual(["cheap"]);

    const evil = await run(
      { exec: { cheap: writer(dir, "src/z_evil.ts", 'import { spawn } from "node:child_process";\nspawn("sh");\n') } },
      { projectPath: dir },
    );
    expect(evil.escalated).toEqual([expect.objectContaining({ trigger: "danger", toTier: 2 })]);
    expect(evil.escalated[0]?.categories).not.toContain("unscanned"); // only the new danger is named
  }, 60_000);

  it("a dangerous file sorted after the diff budget is spent is never treated as clean", async () => {
    const dir = await repo();
    for (const name of ["a.txt", "b.txt", "c.txt"]) await fs.writeFile(path.join(dir, name), "x\n".repeat(450_000)); // ~900 KB each, 2.7 MB in all
    const { escalated, prompts } = await run(
      { exec: { cheap: writer(dir, "src/z_evil.ts", 'import { spawn } from "node:child_process";\nspawn("sh");\n') } },
      { projectPath: dir },
    );
    expect(escalated).toEqual([expect.objectContaining({ trigger: "danger", toTier: 2 })]);
    expect(prompts.map((p) => p.team)).toEqual(["cheap", "top"]);
  }, 60_000);

  it("an untracked file that did not fit the budget is unscanned again when a tier edits it", async () => {
    const dir = await repo();
    for (const name of ["a.txt", "b.txt", "c.txt"]) await fs.writeFile(path.join(dir, name), "x\n".repeat(450_000)); // c.txt overflows the budget
    const untouched = await run({}, { projectPath: dir });
    expect(untouched.escalated).toEqual([]); // the same unscanned file as at the start is not blamed on the tier

    const edit = async (): Promise<ExecutorResult> => {
      await fs.appendFile(path.join(dir, "c.txt"), 'spawn("sh");\n');
      return { status: "completed", summary: "done" };
    };
    const edited = await run({ exec: { cheap: edit } }, { projectPath: dir });
    expect(edited.escalated).toEqual([expect.objectContaining({ trigger: "danger", toTier: 2, categories: ["unscanned"] })]);
  }, 60_000);

  it("a directory that is not a git repo is unscanned danger", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-nogit-"));
    dirs.push(dir);
    const { escalated } = await run({}, { projectPath: dir });
    expect(escalated).toEqual([expect.objectContaining({ toTier: 2, trigger: "danger", categories: ["unscanned"] })]);
  });
});
