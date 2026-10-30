import { createHash, randomBytes } from "node:crypto";
import { promises as fs, realpath } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveVerificationCommands } from "../../config/detect-commands.js";
import type { AssentorConfig } from "../../config/schema.js";
import type { Seat } from "../../core/seats.js";
import { createEmptyContract } from "../../core/task-contract.js";
import { ReviewStatus } from "../../core/types.js";
import type { EngineEventDraft } from "../../protocol/events.js";
import { runShellCommand } from "../../process/run-shell.js";
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorResult,
  ExecutorTask,
} from "../../providers/executors/types.js";
import type { Reviewer } from "../../providers/reviewers/types.js";
import type { RunVerificationCommand } from "../../review/verification-gates.js";
import { redactSecrets } from "../../security/redact.js";
import type { SeatScheduler } from "../../seats/scheduler.js";
import type { SeatKey, WorktreeManager } from "../../worktrees/index.js";
import { parseTddOptions } from "./config.js";
import { detectTamper, isTestFile, lockTests, normalizePath } from "./tamper.js";

/**
 * TDD mode's execute stage (T02B-11): `strategy: "tdd"` on an execute stage, with the usual review
 * stage after it. Like best-of-n (T02-06) it is an `Executor`: the host returns `createTddExecutor(...)`
 * from `StageRunnerDeps.createExecutor(stage)` for that strategy, and the Supervisor drives it
 * (run → verification → review → continue). A host that ignores the strategy runs the stage as plain
 * solo, without any gate.
 *
 * One `run` (a fresh round from the target's tip, in one worktree):
 * 1. the test-writer writes tests. It may only add or change test files (`isTestFile`); touching
 *    anything else, deleting a test, or making no change ends the round. The changed test files are
 *    locked (`lockTests`) and their bytes are remembered;
 * 2. Gate A, in that worktree (the base commit plus only the new tests): the test command must FAIL
 *    (red). Passing means the tests check nothing new and ends the round. Exit codes 124/126/127
 *    (timeout, not runnable, not found) are not "red";
 * 3. the coder implements. Gate B: the test command must pass; while it does not, the coder runs
 *    again (up to `maxCoderAttempts`) with the failing output;
 * 4. tamper check, after each coder run: a locked test whose bytes changed, or that is gone, is
 *    tampered (`detectTamper`). Tampering ends the round: nothing is applied, even when Gate B is
 *    green. The one way out is an explicit **test change request**: the coder leaves the test alone
 *    and ends its message with `TEST-CHANGE-REQUEST: <path> | <reason>` for each file. If it changed
 *    a locked test anyway, every changed file must have such a line, and `decideTestChange` (a
 *    reviewer; see `reviewerTestChangeDecision`) must approve the actual before/after. Without a
 *    request, without `decideTestChange`, or on a "no", the round is blocked;
 * 5. only then is the worktree applied to the target (`WorktreeManager.applyTo`) and the Supervisor's
 *    own gates and the review panel run on the result.
 *
 * `continue` (the review asked for changes) skips steps 1-2: a coder-only round on the target's
 * tip, against the tests locked by the first round. Locks live in this executor instance; a new
 * instance (resume) starts over with the writer, and Gate A then finds the already-applied tests
 * green.
 *
 * A blocked round returns `failed` with a "TDD blocked: ..." summary and the raw gate output in
 * `rawOutput`; the summary carries no output of the tests (the Supervisor retries a failure whose text
 * mentions a timeout or a network error, which would rerun the writer). Its worktree is kept and
 * marked failed. The host removes it at session end (`manager.cleanup`).
 *
 * Seat events: each seat that starts (`seat.status editing`) ends with exactly one `seat.done` or
 * `seat.error`. Gates emit `tdd.gate` (A and B) and `gate.result` (`gate: "tamper"`).
 *
 * Cancel: `cancel(taskId)` aborts the round: scheduler jobs stop, seat executors are cancelled, the
 * running gate command is killed, and `cancel` resolves when the round has settled.
 *
 * Host duties: install dependencies in the worktree before the gates run (they run there), keep
 * test-run artifacts in .gitignore (`applyTo` commits what is in the worktree; new files created by
 * the gates are reported as a warning), and the Supervisor's `projectPath` must be the repository top
 * level.
 *
 * Known limit: only files the test-writer changed are locked. A coder can still weaken tests through
 * shared helpers or fixtures it did not lock, or through the test runner's config.
 */

const nativeRealpath = promisify(realpath.native);

export const TDD_STRATEGY_ID = "tdd";
export const TEST_CHANGE_REQUEST_TAG = "TEST-CHANGE-REQUEST";

const TEXT_LIMIT = 12_000;
const OUTPUT_LIMIT = 4_000;
/** Timeout, command not executable, command not found: the test command did not say "tests fail". */
const NOT_A_TEST_RESULT = new Set([124, 126, 127]);
const DEFAULT_GATE_TIMEOUT_MS = 5 * 60_000;

export interface TddSeat {
  seat: Seat;
  executor: Executor;
}

export interface TestChangeFile {
  path: string;
  /** The coder's reason from its TEST-CHANGE-REQUEST line. */
  reason: string;
  /** The locked version (truncated). */
  before: string;
  /** The coder's version (truncated); null when the coder deleted the file. */
  after: string | null;
}

export interface TestChangeRequest {
  goal: string;
  files: TestChangeFile[];
}

export interface TestChangeDecision {
  approved: boolean;
  reason?: string;
}

export type TddGateRunner = RunVerificationCommand;

export interface TddDeps {
  manager: WorktreeManager;
  /** Worktree session id (a UUID, like the session's id). */
  sessionId: string;
  scheduler: SeatScheduler;
  /** An `edit` seat with its adapter; started with the worktree as its project path. */
  testWriter: TddSeat;
  /** A different `edit` seat. */
  coder: TddSeat;
  /** The stage's `options` (see `parseTddOptions`). */
  options?: Readonly<Record<string, unknown>>;
  /** Source of the test command when `options.testCommand` is not set. */
  verification?: AssentorConfig["verification"];
  /** Runs the test command; default: a shell. Must honour `signal` (kill the process). */
  runCommand?: TddGateRunner;
  /** Decides test change requests. Absent: every request is refused. */
  decideTestChange?: (request: TestChangeRequest, signal: AbortSignal) => Promise<TestChangeDecision>;
  /** Seat and gate events; must not throw. */
  emit?: (draft: EngineEventDraft) => void;
}

interface Snapshot {
  hash: string;
  text: string;
}

/** Why a round did not land. `detail` is raw gate output, kept out of the summary. */
class TddBlocked extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** `TEST-CHANGE-REQUEST: <path> | <reason>` lines of a coder's message, by lower-cased normalized path. */
export function parseTestChangeRequests(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const line = /^[ \t>*-]*TEST[-_ ]CHANGE[-_ ]REQUEST[ \t]*:[ \t]*(.+?)[ \t]*\|[ \t]*(.+?)[ \t]*$/gim;
  for (const match of text.matchAll(line)) {
    found.set(normalizePath(match[1]!.replace(/^[`'"]|[`'"]$/g, "")).toLowerCase(), match[2]!);
  }
  return found;
}

/** `decideTestChange` backed by a reviewer: PASS approves, anything else (or an error) refuses. */
export function reviewerTestChangeDecision(
  reviewer: Reviewer,
  projectPath: string,
): NonNullable<TddDeps["decideTestChange"]> {
  let calls = 0;
  return async (request) => {
    calls += 1;
    const content = request.files
      .map(
        (f) =>
          `File: ${f.path}\nCoder's reason: ${f.reason}\n--- locked version ---\n${f.before}\n--- coder's version ---\n${f.after ?? "(deleted)"}`,
      )
      .join("\n\n=====\n\n");
    const turn = await reviewer.review({
      taskId: `tdd-test-change-${calls}`,
      projectPath,
      round: 1,
      contract: createEmptyContract(
        [
          "Decide a TDD test change request. The tests below were written first and locked; the coder asks to change them.",
          "Answer PASS only if the change is justified (the test was wrong or contradicts the task) and does not weaken, skip or remove coverage just to make the code pass.",
          "Answer NEEDS_WORK or BLOCKED to refuse it.",
          `Task: ${request.goal}`,
        ].join("\n"),
      ),
      artifacts: [{ id: "test-change-request", type: "test-change-request", content }],
    });
    const result = turn.result;
    if (result?.status === ReviewStatus.Pass) {
      return { approved: true, reason: result.summary };
    }
    return { approved: false, reason: result?.summary ?? turn.error ?? "the reviewer gave no verdict" };
  };
}

export function createTddExecutor(deps: TddDeps): Executor {
  const parsed = parseTddOptions(deps.options ?? {});
  if (typeof parsed === "string") throw new Error(parsed);
  const options = parsed;
  const { testWriter, coder } = deps;
  if (testWriter.seat.id === coder.seat.id) {
    throw new Error("tdd: the test-writer and the coder must be different seats");
  }
  for (const s of [testWriter, coder]) {
    if (s.seat.permissions !== "edit") throw new Error(`tdd: seat ${s.seat.id} must have edit permission`);
  }
  const runCommand: TddGateRunner = deps.runCommand ?? runShellCommand;
  const active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  /** Locked tests (path → bytes at lock time) of the last round that landed. */
  let locked = new Map<string, Snapshot>();
  let round = 0;

  const emit = (draft: EngineEventDraft) => {
    try {
      deps.emit?.(draft);
    } catch {
      // Observability must never break the run.
    }
  };
  const seatEvent = (seatId: string, type: "seat.status" | "seat.done" | "seat.error", data: Record<string, unknown>) =>
    emit({ type, sessionId: deps.sessionId, seatId, data } as EngineEventDraft);
  const event = (type: "tdd.gate" | "gate.result" | "session.warning", data: Record<string, unknown>) =>
    emit({ type, sessionId: deps.sessionId, data } as EngineEventDraft);

  /** Starts a seat's visible work and guarantees exactly one terminal event, whatever `fn` does. */
  async function withSeat<T>(seat: Seat, detail: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    seatEvent(seat.id, "seat.status", { status: "editing", detail });
    try {
      const value = await fn();
      seatEvent(seat.id, "seat.done", { ok: true, summary: detail });
      return value;
    } catch (error) {
      if (signal.aborted) seatEvent(seat.id, "seat.done", { ok: false, summary: "cancelled" });
      else seatEvent(seat.id, "seat.error", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** One seat run through the scheduler; resolves with a completed result or throws. */
  async function runSeat(
    s: TddSeat,
    task: ExecutorTask,
    controller: AbortController,
  ): Promise<ExecutorResult> {
    const outcome = await deps.scheduler.run(
      s.seat,
      async (job) => {
        const stop = () =>
          void Promise.resolve()
            .then(() => s.executor.cancel(task.taskId))
            .catch(() => undefined);
        if (job.signal.aborted) stop();
        else job.signal.addEventListener("abort", stop, { once: true });
        try {
          return await s.executor.run(task);
        } finally {
          job.signal.removeEventListener("abort", stop);
        }
      },
      {
        signal: controller.signal,
        maxAttempts: 1, // a retry would rerun the executor on a half-edited worktree
        ...(options.seatTimeoutMs ? { timeoutMs: options.seatTimeoutMs } : {}),
      },
    );
    if (!outcome.ok) {
      if (outcome.scope === "session") controller.abort(); // cancel or session budget: stop the round
      throw new Error(`${outcome.reason}: ${outcome.error}`);
    }
    if (controller.signal.aborted) throw new Error("cancelled");
    if (outcome.value.status !== "completed") {
      throw new Error(`${outcome.value.status}: ${outcome.value.error ?? outcome.value.summary}`);
    }
    return outcome.value;
  }

  async function testCommand(worktree: string, files: readonly string[]): Promise<string> {
    const base =
      options.testCommand ?? (await resolveVerificationCommands(worktree, deps.verification?.commands)).test;
    if (!base) {
      throw new TddBlocked(
        "no test command: set modes.tdd.testCommand or verification.commands.test (none was detected)",
      );
    }
    return base.includes("{files}") ? base.replaceAll("{files}", files.map(quoteArg).join(" ")) : base;
  }

  /** Runs the test command in the worktree. Files the command leaves behind are added to `warnings`. */
  async function gate(
    key: SeatKey,
    worktree: string,
    files: readonly string[],
    signal: AbortSignal,
    warnings: string[],
  ): Promise<{ code: number; output: string }> {
    const command = await testCommand(worktree, files);
    const before = (await deps.manager.diff(key)).files;
    const result = await runCommand(command, worktree, {
      timeoutMs: options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      signal,
    });
    if (signal.aborted) throw new Error("cancelled");
    const grown = (await deps.manager.diff(key)).files.filter((f) => !before.includes(f));
    if (grown.length > 0) {
      warnings.push(`the test command created ${grown.join(", ")} (applyTo would commit them; ignore them in .gitignore)`);
    }
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return { code: result.code, output: redactSecrets(text.slice(-OUTPUT_LIMIT)).text };
  }

  async function read(worktree: string, file: string): Promise<(Snapshot & { text: string }) | undefined> {
    try {
      const bytes = await fs.readFile(path.join(worktree, file));
      return { hash: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8").slice(0, TEXT_LIMIT) };
    } catch {
      return undefined;
    }
  }

  /** Locked files whose bytes differ from the lock, or that are gone. */
  async function changedLocks(worktree: string, locks: ReadonlyMap<string, Snapshot>): Promise<string[]> {
    const changed: string[] = [];
    for (const [file, snapshot] of locks) {
      if ((await read(worktree, file))?.hash !== snapshot.hash) changed.push(file);
    }
    return changed;
  }

  function coderPrompt(goal: string, files: readonly string[]): string {
    return [
      "TDD, step 2 of 2: make the failing tests pass.",
      `Task:\n${goal}`,
      `The tests are already written and locked. Do not modify, rename, delete or skip any of them:\n${files.map((f) => `- ${f}`).join("\n")}`,
      "Change only what the implementation needs; do not commit.",
      `If a locked test is wrong, leave it as it is and end your final message with one line per file: ${TEST_CHANGE_REQUEST_TAG}: <path> | <reason>. A reviewer decides; a test you change without that is rejected.`,
    ].join("\n\n");
  }

  async function execute(
    taskId: string,
    task: Pick<ExecutorTask, "contract" | "prompt" | "messages">,
    projectPath: string,
    continuing: boolean,
  ): Promise<ExecutorResult> {
    const top = await nativeRealpath(await deps.manager.topLevel());
    const given = await nativeRealpath(projectPath).catch(() => path.resolve(projectPath));
    const same = process.platform === "win32" ? given.toLowerCase() === top.toLowerCase() : given === top;
    if (!same) {
      return {
        status: "failed",
        summary: `tdd: the project path ${given} is not the repository top level ${top} (a monorepo subpackage?); worktrees are created per repository`,
      };
    }
    if (!continuing || locked.size === 0) locked = new Map();
    const writing = locked.size === 0;
    round += 1;
    const key: SeatKey = {
      sessionId: deps.sessionId,
      seatId: `tdd-r${round}${randomBytes(4).toString("hex")}`,
    };
    const controller = new AbortController();
    const warnings: string[] = [];
    const notes: string[] = [];
    let created = false;

    const body = async (): Promise<ExecutorResult> => {
      const worktree = (await deps.manager.create(key, "HEAD")).path;
      created = true;
      const locks = new Map(locked);

      if (writing) {
        const files = await withSeat(testWriter.seat, "tdd: test-writer", controller.signal, async () => {
          await runSeat(
            testWriter,
            {
              taskId: `${taskId}.${testWriter.seat.id}`,
              projectPath: worktree,
              contract: task.contract,
              prompt: [
                "TDD, step 1 of 2: write the tests only.",
                `Task:\n${task.prompt}`,
                `Add or change test files (patterns: ${options.testPatterns.join(", ")}) that describe the behaviour the task asks for. Do not implement it and do not touch any other file, so the tests fail now; do not delete tests; do not commit. End with the list of test files.`,
              ].join("\n\n"),
            },
            controller,
          );
          const diff = await deps.manager.diff(key);
          if (diff.files.length === 0) throw new TddBlocked("the test-writer made no changes");
          const other = diff.files.filter((f) => !isTestFile(f, options.testPatterns));
          if (other.length > 0) {
            throw new TddBlocked(`the test-writer changed files that are not tests: ${other.slice(0, 10).join(", ")}`);
          }
          const files = lockTests(diff.files, options.testPatterns);
          for (const file of files) {
            const snapshot = await read(worktree, file);
            if (!snapshot) throw new TddBlocked(`the test-writer deleted or moved the test ${file}`);
            locks.set(file, snapshot);
          }

          // Gate A: the worktree is the base commit plus only the new tests, so the tests must fail here.
          const a = await gate(key, worktree, files, controller.signal, warnings);
          const red = a.code !== 0 && !NOT_A_TEST_RESULT.has(a.code);
          event("tdd.gate", { gate: "A", passed: red, exitCode: a.code, files });
          if (!red) {
            throw new TddBlocked(
              a.code === 0
                ? "Gate A: the new tests already pass on the base commit (no red), so they test nothing new"
                : `Gate A: the test command could not give a result (exit ${a.code})`,
              a.output,
            );
          }
          notes.push(`Gate A red (exit ${a.code}) for ${files.length} locked test file(s): ${files.join(", ")}`);
          return files;
        });
      } else {
        for (const [file, snapshot] of locks) {
          if ((await read(worktree, file))?.hash !== snapshot.hash) {
            throw new TddBlocked(`the locked test ${file} differs from its lock in the checkout this round started from`);
          }
        }
        notes.push(`continued with ${locks.size} locked test file(s)`);
      }

      const coderResult = await withSeat(coder.seat, "tdd: coder", controller.signal, async () => {
        let feedback = "";
        for (let attempt = 1; attempt <= options.maxCoderAttempts; attempt += 1) {
          const result = await runSeat(
            coder,
            {
              taskId: `${taskId}.${coder.seat.id}.a${attempt}`,
              projectPath: worktree,
              contract: task.contract,
              prompt: coderPrompt(task.prompt, [...locks.keys()]) + feedback,
              ...(task.messages ? { messages: task.messages } : {}),
            },
            controller,
          );
          const b = await gate(key, worktree, [...locks.keys()], controller.signal, warnings);
          event("tdd.gate", { gate: "B", passed: b.code === 0, exitCode: b.code, attempt });

          const changed = await changedLocks(worktree, locks);
          const tamper = detectTamper({ lockedTests: [...locks.keys()], coderChangedFiles: changed });
          event("gate.result", { gate: "tamper", passed: tamper.ok, tampered: tamper.tampered });
          if (!tamper.ok) {
            // Approved for this check only: relocked at the new content, so a later change needs a new approval.
            const approvedChanges = await settleTamper(result, tamper.tampered, worktree, locks, task.prompt, controller.signal, b.output);
            if (!detectTamper({ lockedTests: tamper.tampered, coderChangedFiles: tamper.tampered, approvedChanges }).ok) {
              throw new TddBlocked("tamper check: a changed locked test was not approved", b.output);
            }
            notes.push(`approved test change(s): ${approvedChanges.join(", ")}`);
          }
          if (b.code === 0) {
            notes.push(`Gate B green (coder attempt ${attempt}); tamper check ok`);
            return result;
          }
          feedback = `\n\nGate B failed (exit ${b.code}); the tests still do not pass. Test output:\n${b.output}\nFix the implementation; do not change the locked tests.`;
          if (attempt === options.maxCoderAttempts) {
            throw new TddBlocked(
              `Gate B: the tests still fail after ${attempt} coder attempt(s) (exit ${b.code})`,
              b.output,
            );
          }
        }
        throw new Error("unreachable");
      });

      if (controller.signal.aborted) throw new Error("cancelled");
      const applied = await deps.manager.applyTo("main", key, {
        strategy: options.apply,
        message: `assentor: tdd (${options.apply})`,
      });
      if (!applied.ok) {
        throw new TddBlocked(`applying the result conflicts in ${applied.conflicts.join(", ") || "the target"}: ${applied.message}`);
      }
      locked = locks;
      if (applied.warning) warnings.push(applied.warning);
      return {
        status: "completed",
        summary: [`tdd: ${notes.join("; ")}; applied by ${options.apply}`, ...warnings.map((w) => `warning: ${w}`), coderResult.summary].join("\n"),
        ...(coderResult.sessionId ? { sessionId: coderResult.sessionId } : {}),
        ...(coderResult.messages ? { messages: coderResult.messages } : {}),
        ...(coderResult.rawOutput ? { rawOutput: coderResult.rawOutput } : {}),
      };
    };

    /**
     * Locked tests changed by the coder. Each needs a TEST-CHANGE-REQUEST line in the coder's message
     * and the reviewer's approval of the actual change; otherwise the round is blocked. An approved
     * file is then locked at its new content.
     */
    async function settleTamper(
      result: ExecutorResult,
      tampered: string[],
      worktree: string,
      locks: Map<string, Snapshot>,
      goal: string,
      signal: AbortSignal,
      gateOutput: string,
    ): Promise<string[]> {
      const list = tampered.join(", ");
      const requests = parseTestChangeRequests(`${result.summary}\n${result.rawOutput ?? ""}`);
      const unrequested = tampered.filter((f) => !requests.has(f.toLowerCase()));
      const lockOf = (file: string) => [...locks].find(([p]) => p.toLowerCase() === file.toLowerCase())!;
      if (unrequested.length > 0) {
        throw new TddBlocked(`tamper check: the coder changed locked tests without a test change request: ${unrequested.join(", ")}`, gateOutput);
      }
      if (!deps.decideTestChange) {
        throw new TddBlocked(`tamper check: the coder asked to change locked tests (${list}) but nobody can approve it`, gateOutput);
      }
      const files: TestChangeFile[] = [];
      for (const file of tampered) {
        const [lockedPath, snapshot] = lockOf(file);
        files.push({
          path: lockedPath,
          reason: requests.get(file.toLowerCase())!,
          before: snapshot.text,
          after: (await read(worktree, lockedPath))?.text ?? null,
        });
      }
      let decision: TestChangeDecision;
      try {
        decision = await deps.decideTestChange({ goal, files }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new TddBlocked(`tamper check: the test change request could not be decided (${error instanceof Error ? error.message : String(error)})`, gateOutput);
      }
      if (signal.aborted) throw new Error("cancelled");
      if (!decision.approved) {
        throw new TddBlocked(`tamper check: the test change request for ${list} was refused${decision.reason ? `: ${decision.reason}` : ""}`, gateOutput);
      }
      for (const f of files) {
        const now = await read(worktree, f.path);
        if (now) locks.set(f.path, now);
        else locks.delete(f.path);
      }
      event("session.warning", { kind: "tdd.test_change_approved", message: `test change approved: ${list}` });
      return files.map((f) => f.path);
    }

    const done = (async (): Promise<ExecutorResult> => {
      try {
        return await body();
      } catch (error) {
        // The work stays in its worktree (marked failed) so nothing is lost and nothing is force-deleted.
        if (created) await deps.manager.markFailed(key).catch(() => undefined);
        if (controller.signal.aborted) return { status: "cancelled", summary: "tdd cancelled" };
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TddBlocked) {
          return {
            status: "failed",
            summary: `TDD blocked: ${message}`,
            error: `TDD blocked: ${message}`, // the Supervisor reports `error` as the failure reason
            ...(error.detail ? { rawOutput: error.detail } : {}),
          };
        }
        return { status: "failed", summary: `tdd: ${message}`, error: `tdd: ${message}` };
      }
    })();

    active.set(taskId, { controller, done });
    try {
      return await done;
    } finally {
      active.delete(taskId);
    }
  }

  return {
    name: TDD_STRATEGY_ID,
    capabilities: (): ExecutorCapabilities => ({
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: false,
      supportsScreenshots: false,
    }),
    run: (task) =>
      execute(task.taskId, { contract: task.contract, prompt: task.prompt, ...(task.messages ? { messages: task.messages } : {}) }, task.projectPath, false),
    continue: (input) =>
      execute(
        input.taskId,
        { contract: input.contract, prompt: input.nextPhaseDirective ?? input.contract.goal, messages: input.messages },
        input.projectPath,
        true,
      ),
    async cancel(taskId) {
      const run = active.get(taskId);
      if (run) {
        run.controller.abort();
        await run.done.catch(() => undefined);
      }
    },
  };
}

function quoteArg(arg: string): string {
  if (arg.startsWith("-") || /[\r\n]/.test(arg)) {
    throw new TddBlocked(`the test file name ${JSON.stringify(arg)} cannot be passed to the test command safely`);
  }
  if (process.platform === "win32") {
    if (/["%]/.test(arg)) throw new TddBlocked(`the test file name ${JSON.stringify(arg)} cannot be passed to the test command safely`);
    return `"${arg}"`;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
