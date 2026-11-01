import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadAssentorConfig, type AssentorConfig } from "#assentor/engine/config/load.js";
import { resolveTeams } from "#assentor/engine/config/teams.js";
import { createId, isId } from "#assentor/engine/core/ids.js";
import { EventLog } from "#assentor/engine/events/log.js";
import { buildExecutorRegistry } from "#assentor/engine/executors/adapters.js";
import { locateBinary, type BinaryTool } from "#assentor/engine/executors/cli-locator.js";
import { isSelectableExecutorProvider, normalizeExecutorProvider } from "#assentor/engine/executors/providers.js";
import { resolveProviderApiKey } from "#assentor/engine/keys/resolve.js";
import { CliModelCatalog } from "#assentor/engine/models/cli-catalog.js";
import { DEFAULT_CAPABILITIES } from "#assentor/engine/modes/capabilities.js";
import { roleBudget } from "#assentor/engine/context/budget.js";
import { packStepVars } from "#assentor/engine/negotiation/pack-vars.js";
import type { ModeHostServices, ModeId, ExecutorOutputChunk } from "#assentor/engine/modes/registry.js";
import { getMode } from "#assentor/engine/modes/registry.js";
import { appendLessons, buildRetroInput, retroVariables } from "#assentor/engine/modes/retro.js";
import { buildRoster } from "#assentor/engine/modes/roster-build.js";
import { RosterPolicySchema } from "#assentor/engine/modes/roster.js";
import { prepareModeSession, type ModeRunResult } from "#assentor/engine/modes/session.js";
import { selectTddSeats } from "#assentor/engine/modes/tdd/config.js";
import { createTddExecutor, reviewerTestChangeDecision, TDD_STRATEGY_ID } from "#assentor/engine/modes/tdd/executor.js";
import { SeatEventSink } from "#assentor/engine/orchestrator/seat-events.js";
import type { StageRunnerDeps } from "#assentor/engine/orchestrator/session-stages.js";
import { sessionPaths } from "#assentor/engine/persistence/paths.js";
import { GeminiProvider, createOpenAIProvider } from "#assentor/engine/providers/ai/index.js";
import { MockExecutor } from "#assentor/engine/providers/executors/mock/index.js";
import type { Executor, ExecutorResult } from "#assentor/engine/providers/executors/types.js";
import { withAssentorGitignore } from "#assentor/engine/providers/executors/with-gitignore.js";
import { ProcessCliTransport, resolveCliAdapter } from "#assentor/engine/providers/reviewers/cli/index.js";
import type { Reviewer } from "#assentor/engine/providers/reviewers/types.js";
import { PanelReviewer, REVIEW_POLICIES, type ReviewPolicy } from "#assentor/engine/review/index.js";
import { createSeatScheduler, reviewerProviderForSeat } from "#assentor/engine/seats/index.js";
import { PromptLibrary } from "#assentor/engine/prompts/library.js";
import { expandSkillPresets, SkillLibrary, SkillSession, withSkillsAsk } from "#assentor/engine/skills/index.js";
import { WorktreeManager } from "#assentor/engine/worktrees/manager.js";
import { cliUsage } from "#assentor/engine/usage/cli-usage.js";
import type { EngineEvent, EngineEventDraft } from "#assentor/protocol/events.js";
import { extractJsonCandidate } from "#assentor/protocol/parse.js";
import { estimateRun } from "#assentor/engine/estimate/cost.js";
import { observedPricing } from "#assentor/engine/usage/observed.js";
import { expandSeatSpecs, SEAT_CLI_PROVIDERS, type Seat, type StageSpec } from "#assentor/protocol/seats.js";
import {
  attachRunInterrupt,
  buildContract,
  createMembersFromBackends,
  executorEmitsPlainText,
  panelPolicyOptions,
  resolveExecutorModel,
  withReviewTeam,
  type RunAssentorInput,
} from "./commands.js";
import { createAnswerLoop, terminalQuestionIO, type QuestionIO } from "./mode-questions.js";
import { printPreflight, runPreflight } from "./preflight.js";
import { confirmRunEstimate, formatRunEstimate, toRunEstimate } from "./run-estimate.js";
import { RunReporter } from "./ui/reporter.js";

/**
 * `assentor run --mode <id>` for every mode except solo (whose Supervisor path
 * in commands.ts is unchanged): builds the host services, hands them to
 * `prepareModeSession`, answers the session's questions from the terminal, and
 * cancels on Ctrl+C. The autonomy floor stays in `prepareModeSession`.
 */

/** Replace host pieces (tests, embedding hosts). Anything left out is the real one. */
export interface ModeRunHooks {
  askSeat?: NonNullable<ModeHostServices["askSeat"]>;
  roster?: NonNullable<ModeHostServices["roster"]>;
  /** An executor for this seat instead of its provider's CLI; undefined uses the CLI. */
  seatExecutor?: (seat: Seat, stage: StageSpec) => Executor | undefined;
  questions?: QuestionIO;
}

/** Modes whose controller continues saved state (`resume: true`). */
const RESUMABLE: ReadonlySet<ModeId> = new Set(["lead", "swarm"]);
const RUN_FILE = "mode-run.json";
/** Execute strategies the host cannot build (they need their own executor factories). */
const UNWIRED_STRATEGIES: ReadonlySet<string> = new Set(["best-of-n", "divide"]);
const RunRecordSchema = z.object({ mode: z.string(), goal: z.string() });
/** Upper bound for one free-form model call; the scheduler and session signal usually stop it first. */
const ASK_TIMEOUT_MS = 30 * 60_000;

export type ModeTaskInput = RunAssentorInput & { modeId: ModeId; resumeSessionId?: string };

export async function runModeTask(input: ModeTaskInput) {
  const projectPath = path.resolve(input.projectPath);
  const mode = getMode(input.modeId)!;
  const reporter = new RunReporter({ verbose: input.verbose, executorName: mode.title, reviewerName: "reviewers" });
  reporter.preparing("loading config…");
  const abort = new AbortController();
  const detachInterrupt = attachRunInterrupt({
    reporter,
    getExecutor: () => undefined,
    getTaskId: () => undefined,
    getSupervisor: () => ({ requestCancel: () => abort.abort() }),
  });
  let log: EventLog | undefined;
  let sink: SeatEventSink | undefined;
  try {
    const loaded = await loadAssentorConfig(projectPath, {
      executor: input.executor,
      reviewer: input.reviewer,
      maxRounds: input.maxRounds,
      maxMessages: input.maxMessages,
      mode: input.autopilot ? "autopilot" : input.mode,
      autonomy: input.autonomy,
    });
    const config = input.team ? withReviewTeam(loaded, input.team) : loaded;
    const autonomy = config.run.autonomy ?? config.run.mode;
    const pricing = await observedPricing(projectPath).catch(() => ({}));
    const estimate = estimateRun(config, { prompt: input.prompt, modeId: mode.id, pricing });
    reporter.note(formatRunEstimate(estimate, config, `mode ${mode.id}`, { excludesExecutor: true }));
    // Resume has no --yes and the run was already started: no gate.
    if (!input.resumeSessionId) {
      await confirmRunEstimate({
        estimate,
        limits: config.limits,
        yes: input.yes,
        io: input.confirmIO ?? terminalQuestionIO(),
        hold: (open) => reporter.holdOutput(open),
        log: (line) => reporter.note(line),
      });
    }

    if (!input.skipPreflight) {
      reporter.updatePreparing("checking environment…");
      const review = resolveTeams(config).review;
      const preflight = await runPreflight({
        executor: config.executor.provider,
        reviewers: expandSeatSpecs(review.seats).map((s) => ({ provider: reviewerProviderForSeat(s.provider) ?? s.provider, transport: s.transport })),
        projectPath,
      });
      if (!preflight.ok) {
        printPreflight(preflight);
        throw new Error("Preflight failed. Fix the issues above, then re-run.");
      }
    }

    const sessionId = input.resumeSessionId ?? createId();
    const goal = input.prompt;
    const events: EngineEvent[] = [];
    let onQuestionEvent: (event: EngineEvent) => void = () => undefined;
    try {
      log = await EventLog.open(projectPath, sessionId);
    } catch (error) {
      console.error(`[assentor] session log disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    sink = new SeatEventSink({
      sessionId,
      log,
      redactSecrets: config.security.redactSecrets,
      onEvent: (event) => {
        if (input.retro) events.push(event);
        reporter.onEngineEvent(event);
        noteEvent(reporter, event);
        onQuestionEvent(event);
        try {
          input.onEngineEvent?.(event);
        } catch (error) {
          console.error(`[assentor] event listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
    const emit = (draft: EngineEventDraft) => void sink!.emit(draft);
    if (!input.resumeSessionId) emit({ type: "session.estimate", sessionId, data: toRunEstimate(estimate) });

    reporter.updatePreparing("starting seats…");
    const worktrees = new WorktreeManager({ repoPath: projectPath });
    // One skill session for executors, host asks and negotiation steps (TE-07).
    const skills = new SkillSession(await SkillLibrary.load({ projectPath }), {
      sessionId,
      mode: mode.id,
      enabled: expandSkillPresets(config.skills.enabled),
      emit,
    });
    const { deps, host } = createModeHost({
      config,
      projectPath,
      sessionId,
      goal,
      worktrees,
      prompts: await PromptLibrary.load({ projectPath }),
      skills,
      emit,
      reporter,
      hooks: input.modeHooks ?? {},
      executorModel: resolveExecutorModel(input.executorModel, config.executor.model),
      skipGates: input.skipGates,
      acceptanceCriteria: input.acceptanceCriteria,
    });

    const prepared = prepareModeSession({
      mode: mode.id,
      sessionId,
      goal,
      autonomy,
      config,
      deps,
      worktrees,
      signal: abort.signal,
      emit,
      host,
      skills,
      ...(input.resumeSessionId ? { resume: true } : {}),
    });
    const unwired = prepared.spec?.stages.find((s) => s.kind === "execute" && UNWIRED_STRATEGIES.has(s.strategy ?? ""));
    if (unwired) throw new Error(`stage "${unwired.id}": execute strategy "${unwired.strategy}" is not wired into assentor run yet`);
    if (!input.resumeSessionId) {
      // Written once the session validated, so a refused run leaves no record to resume.
      const root = sessionPaths(projectPath, sessionId).root;
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, RUN_FILE), JSON.stringify({ mode: mode.id, goal }), "utf8");
    }
    const questions = createAnswerLoop({
      io: input.modeHooks?.questions ?? terminalQuestionIO(),
      answer: (id, text) => prepared.answer(id, text),
      approveStage: (stageId) => prepared.approve(stageId),
      cancel: (reason) => {
        reporter.note(`cancelling: ${reason}`);
        abort.abort();
      },
      promptOpen: (open) => reporter.holdOutput(open),
      log: (line) => reporter.note(line),
    });
    onQuestionEvent = questions.onEvent;

    reporter.ready();
    reporter.note(`session id: ${sessionId}`);
    reporter.note(`mode: ${mode.id} · autonomy: ${autonomy} · project: ${projectPath}`);
    let result: ModeRunResult;
    try {
      result = await prepared.run();
    } finally {
      questions.close();
    }

    if (input.retro && result.status !== "cancelled" && !abort.signal.aborted) {
      await runRetro({ projectPath, sessionId, goal, config, events, askSeat: host.askSeat!, reporter, signal: abort.signal });
    }
    if (result.status === "completed") await worktrees.cleanup(sessionId).catch(() => undefined);
    reporter.printUsage();
    reporter.note(`${mode.title}: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`);
    if (result.status !== "completed" && RESUMABLE.has(mode.id) && result.status !== "failed") {
      reporter.note(`Resume with: assentor resume ${sessionId}`);
    }
    return {
      result: { taskId: sessionId, status: result.status, ...(result.reason ? { reason: result.reason } : {}) },
      config,
    };
  } finally {
    detachInterrupt();
    await sink?.close();
    await log?.close({ timeoutMs: 5_000 }).catch(() => undefined);
    reporter.dispose();
  }
}

/** The saved mode run for `sessionId`, when it was started with `run --mode` (else undefined). */
export async function readModeRun(projectPath: string, sessionId: string): Promise<{ mode: string; goal: string } | undefined> {
  if (!isId(sessionId)) return undefined;
  try {
    const raw = await fs.readFile(path.join(sessionPaths(path.resolve(projectPath), sessionId).root, RUN_FILE), "utf8");
    return RunRecordSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** `assentor resume <id>` for a mode session; autonomy is the one given now (the session re-applies the floor). */
export async function resumeModeTask(input: Omit<RunAssentorInput, "prompt" | "modeId"> & { sessionId: string; record: { mode: string; goal: string } }) {
  const mode = getMode(input.record.mode);
  if (!mode) throw new Error(`Session ${input.sessionId} was run in an unknown mode "${input.record.mode}".`);
  if (!RESUMABLE.has(mode.id)) {
    throw new Error(`Mode ${mode.id} cannot resume a session; start a new run with: assentor run --mode ${mode.id} "…"`);
  }
  return runModeTask({ ...input, prompt: input.record.goal, modeId: mode.id, resumeSessionId: input.sessionId });
}

/** One line per event the user should see that the reporter does not print itself. */
function noteEvent(reporter: RunReporter, event: EngineEvent): void {
  const data = event.data as Record<string, unknown>;
  if (event.type === "seat.error") reporter.note(`✗ ${event.seatId}: ${String(data.message ?? "")}`);
  // Budget warnings are printed by the reporter itself.
  else if (event.type === "session.warning" && data.kind !== "budget") reporter.note(`warning: ${String(data.message ?? "")}`);
  else if (event.type === "seat.spawned") reporter.note(`seat ${event.seatId}: ${String(data.provider)}/${String(data.model)} (${String(data.role)})`);
}

interface HostInput {
  config: AssentorConfig;
  projectPath: string;
  sessionId: string;
  goal: string;
  worktrees: WorktreeManager;
  prompts: PromptLibrary;
  /** Negotiation steps ask through it; `prepareModeSession` wraps executors and `host.askSeat` with the same session. */
  skills?: SkillSession;
  emit: (draft: EngineEventDraft) => void;
  reporter: RunReporter;
  hooks: ModeRunHooks;
  executorModel?: string;
  skipGates?: boolean;
  acceptanceCriteria?: string[];
}

/** Exported for tests. Stage runner deps and host services for one mode session. */
export function createModeHost(input: HostInput): { deps: StageRunnerDeps; host: ModeHostServices } {
  const { config, projectPath, sessionId, hooks, reporter } = input;
  const scheduler = createSeatScheduler(config.limits, { sessionId, emit: input.emit });
  const executorTeam = resolveTeams(config).executor;
  /** Live output listeners per executor this host made (pair's navigator). */
  const outputs = new WeakMap<Executor, Set<(chunk: ExecutorOutputChunk) => void>>();

  /**
   * Token use of one CLI turn (TE-01), read from its output. Exactly one source per turn: edit
   * executors' results (below), read-only executors' asks, and `askSeat` replies (through the
   * caller's `reportUsage`, so the scheduler also budgets it). Text-format CLIs (the reviewer
   * transport runs claude with `--output-format text`, codex, opencode) and API seats print no
   * usage, so they report nothing yet (API usage: TE-05).
   */
  const emitTokens = (seat: Seat, raw: string | undefined, stageId?: string): void => {
    const usage = raw ? cliUsage(raw) : undefined;
    if (!usage) return;
    const { turns, costUsd, ...tokens } = usage;
    input.emit({
      type: "seat.tokens",
      sessionId,
      seatId: seat.id,
      ...(stageId ? { stageId } : {}),
      data: { ...tokens, turns, ...(costUsd !== undefined ? { costUsd } : {}) },
    });
  };

  /** A free-form ask with the CLI started in `cwd` (a read-only seat runs in its task's worktree). */
  const ask = async (seat: Seat, prompt: string, signal: AbortSignal, cwd: string, stageId?: string): Promise<string> => {
    const text = hooks.askSeat
      ? await hooks.askSeat({ seat, prompt, signal, reportUsage: () => undefined })
      : await askSeatText(config, projectPath, cwd, seat, prompt, signal);
    emitTokens(seat, text, stageId);
    return text;
  };
  const askSeat: NonNullable<ModeHostServices["askSeat"]> = async (request) => {
    const text = hooks.askSeat
      ? await hooks.askSeat(request)
      : await askSeatText(config, projectPath, projectPath, request.seat, request.prompt, request.signal);
    const usage = cliUsage(text);
    if (usage) request.reportUsage(usage);
    return text;
  };

  const seatsFor = (stage: StageSpec): readonly Seat[] => {
    if (!stage.team) {
      if (stage.kind === "review") return expandSeatSpecs(resolveTeams(config).review.seats);
      return expandSeatSpecs(executorTeam.seats).map((s) => (input.executorModel ? { ...s, model: input.executorModel } : s));
    }
    const team = Object.hasOwn(config.teams, stage.team) ? config.teams[stage.team] : undefined;
    if (!team) throw new Error(`unknown team "${stage.team}" (defined: ${Object.keys(config.teams).join(", ") || "(none)"})`);
    return expandSeatSpecs(team.seats, { teamName: stage.team });
  };

  /** The stage's seat: Lead passes the seat itself, other controllers its id; else the team's first edit seat. */
  const seatOf = (stage: StageSpec): Seat => {
    const given = stage.options.seat as Seat | undefined;
    if (given && typeof given === "object" && typeof given.id === "string") return given;
    const seats = seatsFor(stage);
    const id = stage.options.seatId;
    const seat = typeof id === "string" ? seats.find((s) => s.id === id) : (seats.find((s) => s.permissions === "edit") ?? seats[0]);
    if (!seat) throw new Error(`stage "${stage.id}": no seat${typeof id === "string" ? ` "${id}"` : ""} in team "${stage.team ?? "executor"}"`);
    return seat;
  };

  const seatExecutor = (seat: Seat, stage: StageSpec): Executor => {
    const listeners = new Set<(chunk: ExecutorOutputChunk) => void>();
    const send = (chunk: ExecutorOutputChunk) => listeners.forEach((listener) => listener(chunk));
    // Fail closed: only an "edit" seat gets an edit-capable executor (a hook's included); any other
    // seat answers through the read-only reviewer transport.
    if (seat.permissions !== "edit") {
      const executor = readOnlyExecutor(seat, (s, prompt, signal, cwd) => ask(s, prompt, signal, cwd, stage.id));
      outputs.set(executor, listeners);
      return executor;
    }
    let executor = hooks.seatExecutor?.(seat, stage);
    if (!executor) {
      const provider = normalizeExecutorProvider(seat.provider);
      const plain = executorEmitsPlainText(provider);
      const model = seat.model && seat.model !== "AUTO" ? seat.model : undefined;
      if (provider === "mock") executor = new MockExecutor({ name: seat.displayName });
      else if (isSelectableExecutorProvider(provider)) {
        executor = buildExecutorRegistry({
          onOutput: (chunk, stream) => {
            if (plain && stream === "stdout") send({ text: chunk });
          },
          onStatus: (status) => {
            reporter.onExecutorStatus(status);
            if (status.activity !== "thinking" && status.activity !== "running") send({ text: `${status.activity}: ${status.detail}\n`, toolCall: true });
          },
          timeoutMs: config.limits.maxRuntimeMinutes * 60_000,
          ...(model ? { model } : {}),
        }).get(provider);
      }
      if (!executor) throw new Error(`seat "${seat.id}": provider ${seat.provider} cannot run as an agent (no executor CLI for it)`);
      executor = withAssentorGitignore(executor);
    }
    executor = countingTokens(executor, (result) => emitTokens(seat, result.rawOutput, stage.id));
    outputs.set(executor, listeners);
    return executor;
  };

  const reviewerFor = (stage: StageSpec | undefined, tiebreak: Parameters<StageRunnerDeps["createReviewer"]>[1]): Reviewer => {
    let built: Promise<Reviewer> | undefined;
    // Reviewers are built on first use (API keys are read then); the stage runner wants one now.
    const get = () =>
      (built ??= (async () => {
        const team = stage?.team && Object.hasOwn(config.teams, stage.team) ? { name: stage.team, team: config.teams[stage.team]! } : undefined;
        const { members, backends, reviewStrategy, teamMode } = await createMembersFromBackends({
          config,
          projectPath,
          prompt: input.goal,
          ...(team ? { team } : {}),
          onStatus: (message) => reporter.onReviewerStatus(message),
        });
        if ((reviewStrategy === "SINGLE" && !teamMode) || members.length <= 1) return members[0]!;
        const policy = stage?.options.policy;
        return new PanelReviewer({
          name: `panel:${team?.name ?? "review"}`,
          reviewers: members,
          goal: input.goal,
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          ...panelPolicyOptions(config, backends),
          ...((REVIEW_POLICIES as readonly string[]).includes(policy as string) ? { policy: policy as ReviewPolicy } : {}),
          ...tiebreak,
        });
      })());
    return {
      name: `panel:${stage?.team ?? "review"}`,
      review: async (turn) => (await get()).review(turn),
      continue: async (turn) => (await get()).continue(turn),
    };
  };

  const stepAsk = input.skills ? withSkillsAsk(askSeat, input.skills) : askSeat;
  const deps: StageRunnerDeps = {
    projectPath,
    scheduler,
    seatsFor,
    runStep: async ({ seat, step, vars, readOnly, worktreePath, signal, reportUsage }) => {
      if (!readOnly) throw new Error(`negotiation step ${step} edits files; the CLI host runs read-only steps only`);
      // Planning and judging steps never edit, so they never get project skills (builder seats on edit only).
      const reply = await stepAsk({ seat: { ...seat, permissions: "read-only" }, prompt: input.prompts.render(step, packStepVars(vars, config.context?.budgetTokens) as Record<string, never>), signal, reportUsage });
      void worktreePath;
      const json = extractJsonCandidate(reply);
      return json.ok ? json.data : reply;
    },
    createExecutor: (stage) => {
      if (stage.strategy === TDD_STRATEGY_ID) {
        const seats = selectTddSeats(seatsFor(stage));
        if (typeof seats === "string") throw new Error(`tdd: ${seats}`);
        return createTddExecutor({
          manager: input.worktrees,
          sessionId,
          scheduler,
          testWriter: { seat: seats.testWriter, executor: seatExecutor(seats.testWriter, stage) },
          coder: { seat: seats.coder, executor: seatExecutor(seats.coder, stage) },
          options: stage.options,
          verification: config.verification,
          install: config.worktrees.install,
          emit: input.emit,
          ...(roleBudget(config.context?.budgetTokens, "coder") ? { contextBudgetTokens: roleBudget(config.context?.budgetTokens, "coder")! } : {}),
          decideTestChange: reviewerTestChangeDecision(reviewerFor(undefined, {}), projectPath),
        });
      }
      if (UNWIRED_STRATEGIES.has(stage.strategy ?? "")) {
        throw new Error(`execute strategy "${stage.strategy}" is not wired into assentor run yet`);
      }
      return seatExecutor(seatOf(stage), stage);
    },
    createReviewer: (stage, tiebreak) => reviewerFor(stage, tiebreak),
    contract: buildContract(input.goal, input.acceptanceCriteria),
    budgetLimits: {
      maxRounds: config.limits.maxRounds,
      maxMessages: config.limits.maxMessages,
      maxToolCalls: config.limits.maxToolCalls,
      maxRuntimeMs: config.limits.maxRuntimeMinutes * 60_000,
    },
    supervisor: {
      verification: config.verification,
      ...(input.skipGates ? { skipGates: true } : {}),
      onEvent: (event) => reporter.onEvent(event),
    },
  };

  const host: ModeHostServices = {
    askSeat,
    prompts: input.prompts,
    roster: hooks.roster ?? (() => cliRoster(config)),
    watchExecutorOutput: (executor, onChunk) => {
      const listeners = outputs.get(executor);
      if (!listeners) return () => undefined;
      listeners.add(onChunk);
      return () => listeners.delete(onChunk);
    },
  };
  return { deps, host };
}

/** `executor` whose every turn's result (completed, failed or interrupted) is passed to `onResult` first. */
function countingTokens(executor: Executor, onResult: (result: ExecutorResult) => void): Executor {
  const seen = async (pending: Promise<ExecutorResult>) => {
    const result = await pending;
    onResult(result);
    return result;
  };
  return {
    get name() {
      return executor.name;
    },
    capabilities: () => executor.capabilities(),
    run: (task) => seen(executor.run(task)),
    continue: (next) => seen(executor.continue(next)),
    cancel: (taskId) => executor.cancel(taskId),
    ...(executor.setModel ? { setModel: (model: string) => executor.setModel!(model) } : {}),
    ...(executor.interrupt ? { interrupt: () => executor.interrupt!() } : {}),
  };
}

/** A read-only seat as an executor: one free-form ask in the task's directory; no session to continue. */
function readOnlyExecutor(seat: Seat, ask: (seat: Seat, prompt: string, signal: AbortSignal, cwd: string) => Promise<string>): Executor {
  const running = new Map<string, AbortController>();
  return {
    name: seat.displayName,
    capabilities: () => ({ canEditFiles: false, canRunCommands: false, canContinueSession: false, supportsScreenshots: false }),
    run: async (task) => {
      const stop = new AbortController();
      running.set(task.taskId, stop);
      try {
        const text = await ask(seat, task.prompt, stop.signal, task.projectPath);
        if (stop.signal.aborted) return { status: "cancelled", summary: "cancelled" };
        return { status: "completed", summary: text, rawOutput: text };
      } catch (error) {
        if (stop.signal.aborted) return { status: "cancelled", summary: "cancelled" };
        const message = error instanceof Error ? error.message : String(error);
        return { status: "failed", summary: message, error: message };
      } finally {
        running.delete(task.taskId);
      }
    },
    continue: async () => ({ status: "failed", summary: "a read-only seat cannot continue a session", error: "not supported" }),
    cancel: async (taskId) => running.get(taskId)?.abort(),
  };
}

/**
 * One free-form prompt on a seat, read-only: CLI seats through the reviewer
 * transport (read-only flags only), API seats through the provider's generate.
 */
async function askSeatText(config: AssentorConfig, projectPath: string, cwd: string, seat: Seat, prompt: string, signal: AbortSignal): Promise<string> {
  const model = seat.model && seat.model !== "AUTO" ? seat.model : undefined;
  if (seat.provider === "gemini" || seat.provider === "openai") {
    const apiModel = model ?? [config.models[seat.provider], config.models.default].find((m) => m && m !== "AUTO");
    if (!apiModel) throw new Error(`seat "${seat.id}": set a model on the seat or models.${seat.provider} for free-form prompts`);
    const key = await resolveProviderApiKey(seat.provider, projectPath);
    if (!key?.secret) throw new Error(`seat "${seat.id}": no ${seat.provider} API key`);
    const provider = seat.provider === "gemini" ? new GeminiProvider() : createOpenAIProvider();
    // shortcut: generate takes no signal, so a cancel stops waiting but the HTTP request runs to its timeout; pass a signal through AIRequest when the providers take one.
    const call = provider.generate({ model: apiModel, prompt, key: { id: `${key.source}-${seat.provider}`, provider: seat.provider, name: key.name, secret: key.secret }, timeoutMs: ASK_TIMEOUT_MS });
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    return (await Promise.race([call, aborted])).text;
  }
  const adapter = resolveCliAdapter(reviewerProviderForSeat(seat.provider) ?? seat.provider);
  if (adapter === "mock") throw new Error(`seat "${seat.id}": a mock seat cannot answer free-form prompts`);
  const transport = new ProcessCliTransport({ adapter, ...(model ? { model } : {}) });
  const result = await transport.run({ prompt, cwd, timeoutMs: ASK_TIMEOUT_MS, signal });
  if (signal.aborted) throw new Error("cancelled");
  if (result.timedOut) throw new Error(`${adapter} CLI timed out`);
  if (result.code !== 0 && !result.stdout.trim()) throw new Error(result.stderr.trim() || `${adapter} CLI exited with code ${result.code}`);
  return result.stdout;
}

const BINARY: Record<(typeof SEAT_CLI_PROVIDERS)[number], BinaryTool> = {
  "claude-code": "claude",
  codex: "codex",
  antigravity: "agy",
  cursor: "cursor",
  qwen: "qwen",
  opencode: "opencode",
};

/**
 * Who Lead may hire: every catalogued model of an installed CLI.
 * shortcut: "installed" counts as authenticated (no login probe); a logged-out CLI fails when the agent runs. Upgrade with a doctor-style auth check.
 */
function cliRoster(config: AssentorConfig) {
  const catalog = new CliModelCatalog({ readOnly: true });
  const items = SEAT_CLI_PROVIDERS.flatMap((provider) => catalog.list(provider));
  const installed = new Map(SEAT_CLI_PROVIDERS.map((p) => [p, Boolean(locateBinary(BINARY[p], { persist: false }))]));
  return buildRoster({
    catalog: items,
    availability: items.map((item) => ({
      provider: item.provider,
      model: item.id,
      installed: installed.get(item.provider as (typeof SEAT_CLI_PROVIDERS)[number]) ?? false,
      authenticated: installed.get(item.provider as (typeof SEAT_CLI_PROVIDERS)[number]) ?? false,
      freeSlots: config.limits.concurrency[item.provider] ?? 2,
    })),
    capabilities: DEFAULT_CAPABILITIES,
    policy: RosterPolicySchema.parse({}),
  });
}

/** `--retro`: the review team's first seat reads the session record; its bullets go to .assentor/memory/lessons.md. Never fails the run. */
async function runRetro(input: {
  projectPath: string;
  sessionId: string;
  goal: string;
  config: AssentorConfig;
  events: EngineEvent[];
  askSeat: NonNullable<ModeHostServices["askSeat"]>;
  reporter: RunReporter;
  /** The session's cancel; Ctrl+C during the retro stops it. */
  signal: AbortSignal;
}): Promise<void> {
  try {
    const seat = expandSeatSpecs(resolveTeams(input.config).review.seats)[0];
    if (!seat) throw new Error("no review seat to run the retro");
    const prompts = await PromptLibrary.load({ projectPath: input.projectPath });
    const retro = { ...buildRetroInput(input.events) };
    if (!retro.goal) retro.goal = input.goal;
    const reply = await input.askSeat({
      seat: { ...seat, role: "retro" },
      prompt: prompts.render("retro", retroVariables(retro)),
      // The ask itself times out after ASK_TIMEOUT_MS (CLI and API transports).
      signal: input.signal,
      reportUsage: () => undefined,
    });
    const lessons = reply.split("\n").filter((line) => /^\s*[-*]\s+/.test(line));
    const written = await appendLessons(input.projectPath, input.sessionId, lessons);
    input.reporter.note(written ? `retro: ${lessons.length} lesson(s) added to .assentor/memory/lessons.md` : "retro: no lessons");
  } catch (error) {
    input.reporter.note(`retro skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
