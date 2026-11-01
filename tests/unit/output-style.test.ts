import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBudgets,
  createEmptyContract,
  ReviewStatus,
  Supervisor,
  type Executor,
  type ExecutorResult,
  type Reviewer,
  type ReviewerTurnResult,
} from "../../packages/engine/src/index.js";
import { buildReviewPrompt } from "../../packages/engine/src/providers/reviewers/shared/prompt.js";
import { DEFAULT_OUTPUT_STYLE, OUTPUT_STYLES, styleFragment, withOutputStyle, type OutputStyle } from "../../packages/engine/src/output/style.js";
import { parseAssentorConfig } from "../../packages/engine/src/config/schema.js";
import { PromptLibrary } from "../../packages/engine/src/prompts/index.js";
import { specialtyAddendum } from "../../packages/engine/src/review/specialty-prompts.js";
import { RunReporter } from "../../packages/cli/src/cli/ui/reporter.js";
import { printBanner, resolveStyleFlags } from "../../packages/cli/src/cli/commands.js";
import { createLeadController } from "../../packages/engine/src/modes/lead/controller.js";
import type { LeadTask } from "../../packages/engine/src/modes/lead/types.js";
import type { ModeControllerInput } from "../../packages/engine/src/modes/registry.js";

const STYLED: OutputStyle[] = ["concise", "verbose"];
/** Every built-in prompt whose output a program reads back. */
const MACHINE_READ_OUTPUTS = ["review-result", "negotiation-proposal", "ranking", "synthesis", "subtasks"];

/** Chars/4, the same estimate the card uses (no tokenizer dependency). */
const approxTokens = (text: string) => Math.ceil(text.length / 4);

/** The review prompt for one seat: the shared static part, then this seat's addendum. */
function reviewPrompt(addendum: string | undefined): string {
  return buildReviewPrompt({
    contract: createEmptyContract("Add average() to src/math.ts"),
    round: 1,
    artifacts: [],
    specialtyAddendum: addendum,
  });
}

/** The JSON schema block the reviewer is told to return, as written in the prompt. */
function reviewSchemaBlock(prompt: string): string {
  const start = prompt.indexOf("Return ONLY valid JSON matching this schema:");
  const end = prompt.indexOf("Rules: confidence MUST");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

describe("output style fragments", () => {
  it("normal is the default and adds nothing", () => {
    expect(DEFAULT_OUTPUT_STYLE).toBe("normal");
    expect(styleFragment("normal")).toBe("");
    expect(withOutputStyle("Task body", "normal")).toBe("Task body");
  });

  it("each styled fragment is a built-in meta prompt with the style's id", () => {
    const library = PromptLibrary.loadBuiltinSync();
    expect(library.errors).toEqual([]);
    for (const style of STYLED) {
      const def = library.get(`style-${style}`);
      expect(def, style).toBeDefined();
      expect(def!.role).toBe("meta");
      expect(def!.variables).toEqual([]);
      expect(def!.body.startsWith(`## Output style: ${style}`)).toBe(true);
    }
  });

  it.each(STYLED)("the %s fragment is at most 120 tokens (chars/4)", (style) => {
    expect(approxTokens(styleFragment(style))).toBeLessThanOrEqual(120);
  });

  it.each(STYLED)("the %s fragment keeps the JSON-only rule for machine-read output", (style) => {
    expect(styleFragment(style)).toMatch(/JSON report or verdict/);
  });
});

describe("style reaches seat prompts exactly once, at the same offset", () => {
  const specialties = ["architecture", "security", "testing"] as const;

  it.each(STYLED)("%s: each reviewer prompt carries the fragment once, at the same offset", (style) => {
    const prompts = specialties.map((specialty) =>
      reviewPrompt(withOutputStyle(specialtyAddendum(specialty), style)),
    );
    const fragment = styleFragment(style);
    const offsets = prompts.map((prompt, index) => {
      expect(prompt.split(fragment).length - 1, `seat ${specialties[index]}`).toBe(1);
      return prompt.indexOf(fragment);
    });
    expect(new Set(offsets).size).toBe(1);
    // The seat's own addendum follows the fragment, so the fragment is shared prefix.
    prompts.forEach((prompt, index) => {
      expect(prompt.indexOf(specialtyAddendum(specialties[index]))).toBeGreaterThan(offsets[0]!);
    });
  });

  it("normal: the reviewer prompt is byte-identical to the prompt without a style", () => {
    for (const specialty of specialties) {
      const plain = reviewPrompt(specialtyAddendum(specialty));
      expect(reviewPrompt(withOutputStyle(specialtyAddendum(specialty), "normal"))).toBe(plain);
      expect(plain).not.toContain("## Output style");
    }
  });

  it.each(STYLED)("%s: the review JSON schema block is the same as in normal", (style) => {
    const normal = reviewPrompt(specialtyAddendum("code"));
    const styled = reviewPrompt(withOutputStyle(specialtyAddendum("code"), style));
    expect(reviewSchemaBlock(styled)).toBe(reviewSchemaBlock(normal));
    expect(styled).toContain("Rules: confidence MUST be a float between 0 and 1 inclusive");
  });

  it("machine-read prompts keep their body, JSON block included, intact under concise", () => {
    // Every built-in prompt whose output a program reads back keeps its body verbatim after the fragment.
    const defs = PromptLibrary.loadBuiltinSync()
      .list()
      .filter((def) => MACHINE_READ_OUTPUTS.includes(def.output));
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const styled = withOutputStyle(def.body, "concise");
      expect(styled, def.id).toBe(`${styleFragment("concise")}\n\n${def.body}`);
    }
  });
});

describe("executor prompt (supervisor)", () => {
  function recordingExecutor(prompts: string[]): Executor {
    return {
      name: "recording-executor",
      capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: true, supportsScreenshots: false }),
      async run(task) {
        prompts.push(task.prompt);
        return { status: "completed", summary: "done", sessionId: "s1" } as ExecutorResult;
      },
      async continue() {
        return { status: "completed", summary: "done", sessionId: "s1" } as ExecutorResult;
      },
      async cancel() {},
    };
  }

  const passReviewer: Reviewer = {
    name: "pass-reviewer",
    async review(): Promise<ReviewerTurnResult> {
      return {
        result: {
          status: ReviewStatus.Pass,
          confidence: 0.9,
          summary: "ok",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        },
      } as ReviewerTurnResult;
    },
    async continue(): Promise<ReviewerTurnResult> {
      throw new Error("not used");
    },
  };

  async function firstPrompt(outputStyle?: OutputStyle): Promise<string> {
    const prompts: string[] = [];
    await new Supervisor({
      projectPath: "/tmp/output-style-test",
      contract: createEmptyContract("Implement average()"),
      executor: recordingExecutor(prompts),
      reviewer: passReviewer,
      budgets: createBudgets({ maxRounds: 2, maxMessages: 10 }),
      ...(outputStyle ? { outputStyle } : {}),
    }).run();
    return prompts[0]!;
  }

  it("normal leaves the executor task prompt as the bare goal", async () => {
    expect(await firstPrompt()).toBe("Implement average()");
    expect(await firstPrompt("normal")).toBe("Implement average()");
  });

  it("concise puts the fragment once in front of the executor goal", async () => {
    const prompt = await firstPrompt("concise");
    expect(prompt).toBe(`${styleFragment("concise")}\n\nImplement average()`);
    expect(prompt.split(styleFragment("concise")).length - 1).toBe(1);
  });
});

describe("config and flags", () => {
  it("output.style defaults to normal and accepts the three styles", () => {
    expect(parseAssentorConfig({}).output.style).toBe("normal");
    for (const style of OUTPUT_STYLES) {
      expect(parseAssentorConfig({ output: { style } }).output.style).toBe(style);
    }
  });

  it("rejects an unknown output.style", () => {
    expect(() => parseAssentorConfig({ output: { style: "terse" } })).toThrow();
  });

  it("--style and --brief resolve to a style; neither leaves the config in charge", () => {
    expect(resolveStyleFlags({})).toBeUndefined();
    expect(resolveStyleFlags({ brief: true })).toBe("concise");
    expect(resolveStyleFlags({ style: "VERBOSE" })).toBe("verbose");
    expect(resolveStyleFlags({ style: "concise", brief: true })).toBe("concise");
  });

  it("rejects an unknown --style and a --brief that conflicts with --style", () => {
    expect(() => resolveStyleFlags({ style: "terse" })).toThrow(/Unknown style "terse"/);
    expect(() => resolveStyleFlags({ style: "normal", brief: true })).toThrow(/--brief is --style concise/);
  });
});

describe("reporter output by style", () => {
  type Ev = Parameters<RunReporter["onEvent"]>[0];
  let logged: string[];

  let stdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    logged = [];
    // The reporter writes in place only on a TTY; these tests use the line-based path.
    stdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    // The reporter prints in-place only on a TTY; tests use the line-based path.
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTTY, configurable: true });
  });

  /** One short run: a round, the executor, a review that needs work, then a second pass. */
  function runOutput(style: OutputStyle | undefined): string {
    logged = [];
    const reporter = new RunReporter({ executorName: "Claude", reviewerName: "Gemini" });
    if (style) reporter.setStyle(style);
    const on = (event: Record<string, unknown>) => reporter.onEvent(event as unknown as Ev);
    reporter.note("task id: T-1");
    reporter.note("review strategy: ADAPTIVE · reviewers: Gemini");
    on({ type: "round.started", data: { round: 1 } });
    on({ type: "executor.started" });
    on({ type: "executor.completed", data: { status: "completed", summary: "Added average() and a test." } });
    on({ type: "review.started" });
    on({
      type: "review.completed",
      data: {
        status: "NEEDS_WORK",
        summary: "average([]) divides by zero.",
        confidence: 0.8,
        issues: [{ severity: "major", description: "average([]) divides by zero" }],
        requiredChanges: ["Return 0 for an empty array"],
      },
    });
    on({ type: "task.completed", data: { summary: "Done after one fix." } });
    reporter.dispose();
    return logged.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
  }

  it("normal output and banner match the golden output", () => {
    expect(runOutput(undefined)).toMatchInlineSnapshot(`
      "  task id: T-1
        review strategy: ADAPTIVE · reviewers: Gemini

      ▸ Round 1

      ▸ Executor · Claude
        ✓ Claude · 0s · done

        Executor response
        Added average() and a test.


      ▸ Reviewer · Gemini
        ✓ Gemini · 0s · response received

        Decision: NEEDS_WORK · confidence 80%
        average([]) divides by zero.
        Issues
          • [major] average([]) divides by zero
        Required changes
          • Return 0 for an empty array

        Task completed: Done after one fix."
    `);
  });

  it("normal banner matches the golden box, and concise is one line", () => {
    const banner = (style: OutputStyle | undefined) => {
      logged = [];
      printBanner({
        task: "Add average()",
        round: "0 / 8",
        executor: "Claude",
        reviewer: "Gemini",
        mode: "supervised",
        status: "EXECUTING",
        ...(style === "concise" ? { concise: true } : {}),
      });
      return logged.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    };
    expect(banner(undefined)).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────────╮
      │ ASSENTOR                                    │
      ├──────────────────────────────────────────┤
      │ Task      Add average()                │
      │ Round     0 / 8                        │
      │ Mode      supervised                   │
      │ Executor  Claude                       │
      │ Reviewer  Gemini                       │
      │ Status    EXECUTING                    │
      ╰──────────────────────────────────────────╯"
    `);
    expect(banner("concise")).toMatchInlineSnapshot(`"ASSENTOR · EXECUTING · round 0 / 8 · Add average()"`);
  });

  it("--brief (concise) keeps one line per stage and the final line", () => {
    const out = runOutput("concise");
    expect(out).not.toContain("Executor response");
    expect(out).not.toContain("Required changes");
    expect(out).not.toContain("task id:");
    expect(out).toContain("Decision: NEEDS_WORK");
    expect(out).toContain("Done after one fix.");
    expect(out).toMatchInlineSnapshot(`
      "
      ▸ Round 1

      ▸ Executor · Claude
        ✓ Claude · 0s · done

      ▸ Reviewer · Gemini
        ✓ Gemini · 0s · response received

        Decision: NEEDS_WORK · confidence 80%

        Task completed: Done after one fix."
    `);
  });

  it("concise keeps warnings and the full executor error, and drops setup notes", () => {
    logged = [];
    const reporter = new RunReporter({ executorName: "Claude", reviewerName: "Gemini" });
    reporter.setStyle("concise");
    const long = "Claude exited with code 1: " + "x".repeat(120) + " (see stderr)";
    reporter.note("task id: T-1");
    reporter.note("Extended budgets for resume: rounds 3/8", "warning");
    reporter.onEngineEvent({
      type: "session.warning",
      seatId: "executor",
      data: { kind: "budget", message: "tokens at 80% of the session limit" },
    } as never);
    reporter.onEvent({ type: "executor.started" } as never);
    reporter.onEvent({ type: "executor.failed", data: { status: "failed", error: long } } as never);
    reporter.onEvent({ type: "task.failed", data: { summary: long } } as never);
    reporter.dispose();
    const out = logged.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(out).not.toContain("task id:");
    expect(out).toContain("Extended budgets for resume: rounds 3/8");
    expect(out).toContain("budget: tokens at 80% of the session limit");
    // Wrapping may split the sentence, but the whole error text must reach the screen.
    expect(out).toContain("Claude exited with code 1:");
    expect(out).toContain("x".repeat(120));
    expect(out).toContain("(see stderr)");
  });

  it("verbose keeps the normal detail", () => {
    const out = runOutput("verbose");
    expect(out).toContain("task id: T-1");
    expect(out).toContain("Executor response");
    expect(out).toContain("Required changes");
  });

  it("verbose lists each reviewer seat, even a single one; normal and concise do not", () => {
    const seatLines = (style: OutputStyle | undefined) => {
      logged = [];
      const reporter = new RunReporter({ executorName: "Claude", reviewerName: "Gemini" });
      if (style) reporter.setStyle(style);
      reporter.onEngineEvent({
        type: "seat.spawned",
        seatId: "reviewer-1",
        data: { displayName: "Gemini", model: "AUTO", role: "general" },
      } as never);
      reporter.onEngineEvent({
        type: "review.verdict",
        data: { legacyType: "review.completed", status: "PASS" },
      } as never);
      reporter.dispose();
      return logged.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    };
    expect(seatLines("verbose")).toContain("Review seats");
    expect(seatLines("verbose")).toContain("Gemini");
    expect(seatLines(undefined)).not.toContain("Review seats");
    expect(seatLines("concise")).not.toContain("Review seats");
  });
});

describe("Lead agent prompt", () => {
  /** The Lead's agent prompt for one task, built the way the controller builds it. */
  function leadAgentPrompt(style: OutputStyle | undefined): string {
    const config = parseAssentorConfig({
      ...(style ? { output: { style } } : {}),
      modes: { lead: { lead: { provider: "mock", model: "lead" } } },
    });
    const controller = createLeadController({
      sessionId: "3f2c1a7e-9b4d-4c8e-8a1f-6d2e5b7c9a10",
      goal: "Add average() to src/math.ts",
      title: "Add average()",
      autonomy: "supervised",
      config,
      deps: { projectPath: "/tmp/output-style-lead" },
    } as unknown as ModeControllerInput) as unknown as {
      agentPrompt(task: LeadTask, feedback: string | undefined): string;
    };
    const task = {
      id: "T1",
      title: "Add average()",
      description: "Add average(xs) to src/math.ts.",
      acceptance: ["average([1,2]) is 1.5"],
      ownedPaths: ["src/math.ts"],
      role: "engineer",
    } as unknown as LeadTask;
    return controller.agentPrompt(task, undefined);
  }

  it("concise adds one fragment in front and leaves the report block intact", () => {
    const normal = leadAgentPrompt(undefined);
    const concise = leadAgentPrompt("concise");
    expect(concise).toBe(`${styleFragment("concise")}\n\n${normal}`);
    expect(concise.split(styleFragment("concise")).length - 1).toBe(1);
    expect(concise).toContain('"taskId": "T1"');
    expect(concise.trimEnd().endsWith("Report only what you did: the lead checks it against your diff and the test gates.")).toBe(true);
  });
});

