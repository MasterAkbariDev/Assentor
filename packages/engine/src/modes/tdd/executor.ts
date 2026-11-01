import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs, realpath } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveVerificationCommands } from "../../config/detect-commands.js";
import type { AssentorConfig } from "../../config/schema.js";
import type { Seat } from "#assentor/protocol/seats.js";
import { buildAutonomousContinuationPrompt, buildSupervisedContinuationPrompt } from "../../orchestrator/phase-steering.js";
import { createEmptyContract } from "../../core/task-contract.js";
import { ReviewStatus } from "../../core/types.js";
import type { EngineEventDraft } from "#assentor/protocol/events.js";
import type { ProtocolMessage } from "#assentor/protocol/messages.js";
import type { RunMode } from "../../core/run-mode.js";
import { runShellCommand } from "../../process/run-shell.js";
import { prepareWorktree } from "../../worktrees/prepare.js";
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
import { packFailureOutput } from "../../context/budget.js";
import { parseTddOptions } from "./config.js";
import { detectTamper, isTestFile, lockTests, normalizePath, RUNNER_CONFIG } from "./tamper.js";

/**
 * TDD mode's execute stage (T02B-11): `strategy: "tdd"` on an execute stage, with the usual review
 * stage after it. Like best-of-n (T02-06) it is an `Executor`: the host returns `createTddExecutor(...)`
 * from `StageRunnerDeps.createExecutor(stage)` for that strategy, and the Supervisor drives it
 * (run → verification → review → continue). A host that ignores the strategy runs the stage as plain
 * solo, without any gate.
 *
 * One `run` (a fresh round from the target's tip, in one worktree). Before the writer starts, the test
 * command is resolved once (so the coder cannot change what it resolves to) and, unless it uses `{files}`,
 * run once on the untouched base: a base that is already red ends the round.
 * 1. the test-writer writes tests. It may only add or change test files (`isTestFile`); touching
 *    anything else, deleting a test, or making no change ends the round. The changed test files are
 *    locked (`lockTests`) and their bytes are remembered;
 * 2. Gate A, in that worktree (the base commit plus only the new tests): the test command must FAIL
 *    (red). Passing means the tests check nothing new and ends the round. Exit codes 124/126/127
 *    (timeout, not runnable, not found) are not "red";
 * 3. the coder implements. Gate B: the test command must pass; while it does not, the coder runs
 *    again (up to `maxCoderAttempts`) with the failing output;
 * 4. tamper check, after each coder run, over every **protected** file: the locked tests, every test file
 *    that existed when the coder started, and the test runner's config (`RUNNER_CONFIG`, ./tamper.ts).
 *    A protected file whose bytes changed, that is gone, or that became a symlink is tampered
 *    (`detectTamper`); so is a **new** test file or runner config file: the tests are already written.
 *    Tampering ends the round: nothing is applied, even when Gate B is
 *    green. The one way out is an explicit **test change request**: the coder leaves the test alone
 *    and ends its message with `TEST-CHANGE-REQUEST: <path> | <reason>` for each file. If it changed
 *    a locked test anyway, every changed file must have such a line, and `decideTestChange` (a
 *    reviewer; see `reviewerTestChangeDecision`) must approve the actual before/after. Without a
 *    request, without `decideTestChange`, or on a "no", the round is blocked;
 * 5. only then is the worktree applied to the target (`WorktreeManager.applyTo`) and the Supervisor's
 *    own gates and the review panel run on the result.
 *
 * `continue` (the review asked for changes) skips steps 1-2: a coder-only round on the target's
 * tip, against the tests locked by the first round, with the review feedback in the coder's prompt.
 * Locks live in this executor instance; a new instance (resume) has none, and `continue` then fails
 * with "locks lost" instead of guessing.
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
 * Known limits: a coder can still weaken tests through helpers or fixtures that are not test files by
 * the patterns, or through config that is not on the `RUNNER_CONFIG` list (config this list does not name); and a process the coder left running could change a test between the tamper check and
 * `applyTo` (not detected: the lock is re-read from the target afterwards).
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
  /** `worktrees.install`: dependency install in each round's worktree before its first gate. Default `auto`. */
  install?: AssentorConfig["worktrees"]["install"];
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
    // JSON-escaped: the coder's text cannot close a fence or pose as the reviewer's instructions.
    const content = request.files
      .map((f) => JSON.stringify({ file: f.path, coderReason: f.reason, lockedVersion: f.before, coderVersion: f.after }, null, 2))
      .join("\n\n");
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
  let rounds = 0;

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

  /** The test command with `{files}` still in it. Resolved once per round, before the coder runs. */
  async function resolveTemplate(worktree: string): Promise<string> {
    const base =
      options.testCommand ?? (await resolveVerificationCommands(worktree, deps.verification?.commands)).test;
    if (!base) {
      throw new TddBlocked(
        "no test command: set modes.tdd.testCommand or verification.commands.test (none was detected)",
      );
    }
    return base;
  }

  const fill = (template: string, files: readonly string[]): string =>
    template.includes("{files}") ? template.replaceAll("{files}", files.map(quoteArg).join(" ")) : template;

  /** Runs the test command in the worktree. Files the command leaves behind are added to `warnings`. */
  async function gate(
    key: SeatKey,
    worktree: string,
    template: string,
    files: readonly string[],
    signal: AbortSignal,
    warnings: string[],
  ): Promise<{ code: number; output: string }> {
    const command = fill(template, files);
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
    return { code: result.code, output: redactSecrets(packFailureOutput(text, OUTPUT_LIMIT) ?? text.slice(-OUTPUT_LIMIT)).text };
  }

  /** A file's bytes (hash) and text. A symlink hashes as its target, so turning a file into a link shows. */
  async function read(worktree: string, file: string): Promise<Snapshot | undefined> {
    try {
      const full = path.join(worktree, file);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) return { hash: `symlink:${await fs.readlink(full)}`, text: "" };
      if (!stat.isFile()) return undefined;
      const bytes = await fs.readFile(full);
      return { hash: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8").slice(0, TEXT_LIMIT) };
    } catch {
      return undefined;
    }
  }

  const isProtected = (file: string) => isTestFile(file, options.testPatterns) || RUNNER_CONFIG.test(normalizePath(file));

  /** Every tracked or untracked (not ignored) file of the worktree. */
  const listFiles = (cwd: string): Promise<string[]> =>
    new Promise((resolve, reject) =>
      execFile(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd, maxBuffer: 256 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout.split("\0").filter(Boolean))),
      ),
    );

  /** The protected files now: all test files and test runner config. */
  async function snapshotProtected(worktree: string): Promise<Map<string, Snapshot>> {
    const guard = new Map<string, Snapshot>();
    for (const file of await listFiles(worktree)) {
      const snapshot = isProtected(file) ? await read(worktree, file) : undefined;
      if (snapshot) guard.set(file, snapshot);
    }
    return guard;
  }

  /** Protected files whose bytes changed or that are gone, plus new test files and new test runner config files. */
  async function changedProtected(worktree: string, guard: ReadonlyMap<string, Snapshot>): Promise<string[]> {
    const changed: string[] = [];
    for (const [file, snapshot] of guard) {
      if ((await read(worktree, file))?.hash !== snapshot.hash) changed.push(file);
    }
    for (const file of await listFiles(worktree)) {
      if (!guard.has(file) && isProtected(file) && (await read(worktree, file))) changed.push(file);
    }
    return changed;
  }

  function coderPrompt(goal: string, files: readonly string[]): string {
    return [
      "TDD, step 2 of 2: make the failing tests pass.",
      `Task:\n${goal}`,
      `The tests are already written and locked. Do not modify, rename, delete or skip any of them:\n${files.map((f) => `- ${f}`).join("\n")}`,
      "Do not change any other existing test file or the test runner's configuration either (package.json, vite/vitest/jest/playwright/cypress config, pytest.ini, pyproject.toml, setup.cfg, tox.ini, conftest.py, Makefile, .gitignore, ...). Do not add new test files either: the tests are already written.",
      "Change only what the implementation needs; do not commit.",
      `If a locked test is wrong, leave it as it is and end your final message with one line per file: ${TEST_CHANGE_REQUEST_TAG}: <path> | <reason>. A reviewer decides; a protected file you change without that is rejected.`,
    ].join("\n\n");
  }

  /** One round. Registers itself in `active` synchronously, so `cancel` works from the first instant. */
  function execute(
    taskId: string,
    task: Pick<ExecutorTask, "contract" | "prompt" | "messages">,
    projectPath: string,
    continuing: boolean,
    followUp = "",
  ): Promise<ExecutorResult> {
    const controller = new AbortController();
    const done = round(controller, taskId, task, projectPath, continuing, followUp);
    active.set(taskId, { controller, done });
    return done.finally(() => {
      if (active.get(taskId)?.done === done) active.delete(taskId);
    });
  }

  async function round(
    controller: AbortController,
    taskId: string,
    task: Pick<ExecutorTask, "contract" | "prompt" | "messages">,
    projectPath: string,
    continuing: boolean,
    followUp: string,
  ): Promise<ExecutorResult> {
    const warnings: string[] = [];
    const notes: string[] = [];
    let key: SeatKey | undefined;

    const body = async (): Promise<ExecutorResult> => {
      const top = await nativeRealpath(await deps.manager.topLevel());
      const given = await nativeRealpath(projectPath).catch(() => path.resolve(projectPath));
      const same = process.platform === "win32" ? given.toLowerCase() === top.toLowerCase() : given === top;
      if (!same) {
        return {
          status: "failed",
          summary: `tdd: the project path ${given} is not the repository top level ${top} (a monorepo subpackage?); worktrees are created per repository`,
        };
      }
      if (controller.signal.aborted) throw new Error("cancelled");
      if (continuing && locked.size === 0) {
        return {
          status: "failed",
          summary: "tdd: locks lost: no round landed in this process (a resume starts a new executor), so there are no locked tests to continue against; start a new session",
          error: "tdd: locks lost; start a new session (resuming cannot restore the locked tests)",
        };
      }
      const writing = !continuing;
      if (writing) locked = new Map();
      rounds += 1;
      const seatKey: SeatKey = { sessionId: deps.sessionId, seatId: `tdd-r${rounds}${randomBytes(4).toString("hex")}` };
      const worktree = (await deps.manager.create(seatKey, "HEAD")).path;
      key = seatKey;
      const prepared = await prepareWorktree(worktree, deps.install, { signal: controller.signal, run: runCommand });
      if (!prepared.ok) {
        if (controller.signal.aborted) throw new Error("cancelled");
        throw new TddBlocked(prepared.reason);
      }
      const locks = new Map(locked);
      const template = await resolveTemplate(worktree);
      let guard: Map<string, Snapshot>;

      if (writing) {
        // A base that is red already would make Gate A meaningless. With {files} Gate A is exact instead.
        if (!template.includes("{files}")) {
          const base = await gate(seatKey, worktree, template, [], controller.signal, warnings);
          if (base.code !== 0) {
            throw new TddBlocked(
              NOT_A_TEST_RESULT.has(base.code)
                ? `base: the test command could not run on the base commit (exit ${base.code})`
                : `base is red: the test command already fails on the base commit (exit ${base.code}); fix it or put {files} in modes.tdd.testCommand`,
              base.output,
            );
          }
        }
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
          const diff = await deps.manager.diff(seatKey);
          if (diff.files.length === 0) throw new TddBlocked("the test-writer made no changes");
          const other = diff.files.filter((f) => !isTestFile(f, options.testPatterns));
          if (other.length > 0) {
            throw new TddBlocked(`the test-writer changed files that are not tests: ${other.slice(0, 10).join(", ")}`);
          }
          const tests = lockTests(diff.files, options.testPatterns);
          for (const file of tests) {
            const snapshot = await read(worktree, file);
            if (!snapshot) throw new TddBlocked(`the test-writer deleted or moved the test ${file}`);
            if (snapshot.hash.startsWith("symlink:")) throw new TddBlocked(`the test-writer made ${file} a symlink`);
            locks.set(file, snapshot);
          }
          return tests;
        });

        // Gate A: the worktree is the base commit plus only the new tests, so the tests must fail here.
        const a = await gate(seatKey, worktree, template, files, controller.signal, warnings);
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
        guard = await snapshotProtected(worktree); // after Gate A: what the test command itself writes is not the coder's
        notes.push(`Gate A red (exit ${a.code}) for ${files.length} locked test file(s): ${files.join(", ")}`);
      } else {
        guard = await snapshotProtected(worktree);
        for (const [file, snapshot] of locks) {
          if (guard.get(file)?.hash !== snapshot.hash) {
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
              prompt: coderPrompt(task.prompt, [...locks.keys()]) + followUp + feedback,
              ...(task.messages ? { messages: task.messages } : {}),
            },
            controller,
          );
          const b = await gate(seatKey, worktree, template, [...locks.keys()], controller.signal, warnings);
          event("tdd.gate", { gate: "B", passed: b.code === 0, exitCode: b.code, attempt });

          const changed = await changedProtected(worktree, guard);
          const tamper = detectTamper({ lockedTests: [...guard.keys(), ...changed], coderChangedFiles: changed });
          event("gate.result", { gate: "tamper", passed: tamper.ok, tampered: tamper.tampered });
          if (!tamper.ok) {
            // Approved for this check only: re-snapshotted at the new content, so a later change needs a new approval.
            const approvedChanges = await settleTamper(result, tamper.tampered, worktree, guard, locks, task.prompt, controller.signal, b.output);
            if (!detectTamper({ lockedTests: tamper.tampered, coderChangedFiles: tamper.tampered, approvedChanges }).ok) {
              throw new TddBlocked("tamper check: a changed protected file was not approved", b.output);
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
      const applied = await deps.manager.applyTo("main", seatKey, {
        strategy: options.apply,
        message: `assentor: tdd (${options.apply})`,
      });
      if (!applied.ok) {
        throw new TddBlocked(
          `applying the result conflicts in ${applied.conflicts.join(", ") || "the target"}`,
          applied.message,
        );
      }
      // Hooks may reformat what landed: later rounds lock the bytes that are in the target now. A file
      // missing there keeps its old lock, so the next round refuses to start.
      for (const file of [...locks.keys()]) {
        const landed = await read(top, file);
        if (landed) locks.set(file, landed);
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
     * Protected files changed by the coder. Each needs a TEST-CHANGE-REQUEST line in the coder's message
     * and the reviewer's approval of the actual change; otherwise the round is blocked. An approved
     * file is then protected at its new content. Reasons and errors go to `detail`, not the summary.
     */
    async function settleTamper(
      result: ExecutorResult,
      tampered: string[],
      worktree: string,
      guard: Map<string, Snapshot>,
      locks: Map<string, Snapshot>,
      goal: string,
      signal: AbortSignal,
      gateOutput: string,
    ): Promise<string[]> {
      const list = tampered.join(", ");
      const requests = parseTestChangeRequests(`${result.summary}\n${result.rawOutput ?? ""}`);
      const unrequested = tampered.filter((f) => !requests.has(f.toLowerCase()));
      if (unrequested.length > 0) {
        throw new TddBlocked(
          `tamper check: the coder or the test command changed protected files (tests or test runner config) without a test change request: ${unrequested.join(", ")}`,
          gateOutput,
        );
      }
      if (!deps.decideTestChange) {
        throw new TddBlocked(`tamper check: the coder or the test command changed protected files (${list}) but nobody can approve it`, gateOutput);
      }
      const files: TestChangeFile[] = [];
      for (const file of tampered) {
        files.push({
          path: file,
          reason: requests.get(file.toLowerCase())!,
          before: guard.get(file)?.text ?? "",
          after: (await read(worktree, file))?.text ?? null,
        });
      }
      let decision: TestChangeDecision;
      try {
        decision = await deps.decideTestChange({ goal, files }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new TddBlocked(
          "tamper check: the test change request could not be decided",
          `${error instanceof Error ? error.message : String(error)}\n${gateOutput}`.trim(),
        );
      }
      if (signal.aborted) throw new Error("cancelled");
      if (!decision.approved) {
        throw new TddBlocked(
          `tamper check: the test change request for ${list} was refused`,
          `${decision.reason ?? ""}\n${gateOutput}`.trim(),
        );
      }
      for (const f of files) {
        const now = await read(worktree, f.path);
        if (now) {
          guard.set(f.path, now);
          if (locks.has(f.path)) locks.set(f.path, now);
        } else {
          guard.delete(f.path);
          locks.delete(f.path);
        }
      }
      event("session.warning", { kind: "tdd.test_change_approved", message: `test change approved: ${list}` });
      return files.map((f) => f.path);
    }

    try {
      return await body();
    } catch (error) {
      // The work stays in its worktree (marked failed) so nothing is lost and nothing is force-deleted.
      if (key) await deps.manager.markFailed(key).catch(() => undefined);
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
    // The review's findings live in `messages`; the coder only sees them if they are in its prompt.
    continue: (input) =>
      execute(
        input.taskId,
        { contract: input.contract, prompt: input.contract.goal, messages: input.messages },
        input.projectPath,
        true,
        continuationText(input.messages, input.mode, input.nextPhaseDirective),
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

/** Review feedback for a continued round, as the CLI executors phrase it. */
function continuationText(messages: ProtocolMessage[], mode: RunMode | undefined, directive: string | undefined): string {
  if (mode === "autopilot") return `\n\n${buildAutonomousContinuationPrompt(messages, directive)}`;
  const steering = directive ? `\n\nNext-phase directive:\n${directive}` : "";
  return `${steering}\n\n${buildSupervisedContinuationPrompt(messages)}`;
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
