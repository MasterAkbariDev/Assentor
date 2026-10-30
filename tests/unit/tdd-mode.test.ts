import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createId,
  createTddExecutor,
  expandSeatSpecs,
  getMode,
  listModes,
  MockReviewer,
  ModeValidationError,
  PanelReviewer,
  parseAssentorConfig,
  parseTddOptions,
  parseTestChangeRequests,
  prepareModeSession,
  reviewerTestChangeDecision,
  selectTddSeats,
  WorktreeManager,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type ExecutorTask,
  type StageRunnerDeps,
  type StageSpec,
  type TddDeps,
  type TestChangeRequest,
} from "../../src/index.js";
import { createEmptyContract } from "../../src/core/task-contract.js";
import { runShellCommand } from "../../src/process/run-shell.js";
import { SeatScheduler } from "../../src/seats/index.js";

const exec = promisify(execFile);
// Real git and real shell test commands in temp repos, like strategy-best-of-n.test.ts.
vi.setConfig({ testTimeout: 60_000 });
const SESSION = "44444444-4444-4444-8444-444444444444";
const GOAL = "Add add(a, b) in add.js";
const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-tdd-")));
  dirs.push(dir);
  await git(dir, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "assentor@test");
  await git(dir, "config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n");
  await fs.writeFile(path.join(dir, "README.md"), "demo\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const [writerSeat, coderSeat] = expandSeatSpecs([
  { provider: "mock", model: "writer", role: "test-writer", permissions: "edit" },
  { provider: "mock", model: "coder", role: "engineer", permissions: "edit" },
]) as [ReturnType<typeof expandSeatSpecs>[0], ReturnType<typeof expandSeatSpecs>[0]];

const TEST_FILE = "tests/add.test.js";
const TEST_ADD = `const { add } = require("../add.js");\nif (add(2, 3) !== 5) { console.error("add(2, 3) was wrong"); process.exit(1); }\n`;
const IMPL = "exports.add = (a, b) => a + b;\n";
const WRONG = "exports.add = (a, b) => a - b;\n";
const WEAK_TEST = "process.exit(0);\n";
/** Red until add.js exists; independent of the test file, so a deleted or moved test cannot fail Gate B. */
const GATE_ON_IMPL = `node -e "require('./add.js')"`;

const done = (summary = "done", extra: Partial<ExecutorResult> = {}): ExecutorResult => ({ status: "completed", summary, ...extra });

interface Scripted extends Executor {
  tasks: ExecutorTask[];
  cancelled: string[];
}

/** An executor that runs `work` in the project path it is given (the worktree). */
function scripted(work: (task: ExecutorTask, call: number) => Promise<ExecutorResult> | ExecutorResult): Scripted {
  const ex: Scripted = {
    name: "scripted",
    tasks: [],
    cancelled: [],
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
    async run(task) {
      ex.tasks.push(task);
      return work(task, ex.tasks.length);
    },
    async continue() {
      throw new Error("seats never continue");
    },
    async cancel(taskId) {
      ex.cancelled.push(taskId);
    },
  };
  return ex;
}

const write = async (task: ExecutorTask, file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(task.projectPath, file)), { recursive: true });
  await fs.writeFile(path.join(task.projectPath, file), text);
};

/** The usual test-writer: one failing test. */
const writer = (text = TEST_ADD, file = TEST_FILE) =>
  scripted(async (task) => {
    await write(task, file, text);
    return done(`wrote ${file}`);
  });

/** A coder that writes `impl` to add.js, and optionally also edits files and appends text to its message. */
const coder = (impl = IMPL, extra: Record<string, string> = {}, message = "implemented add") =>
  scripted(async (task) => {
    await write(task, "add.js", impl);
    for (const [file, text] of Object.entries(extra)) await write(task, file, text);
    return done(message);
  });

/** Hangs until `cancel(taskId)`, like a CLI whose process gets killed. */
function hanging() {
  let release: (r: ExecutorResult) => void = () => undefined;
  const ex = scripted(() => new Promise<ExecutorResult>((resolve) => (release = resolve)));
  const cancel = ex.cancel;
  ex.cancel = async (taskId) => {
    await cancel(taskId);
    release({ status: "cancelled", summary: "killed" });
  };
  return ex;
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Setup {
  repo: string;
  manager: WorktreeManager;
  events: EngineEventDraft[];
  build(testWriter: Executor, theCoder: Executor, extra?: Partial<TddDeps>): Executor;
  run(ex: Executor, taskId?: string): Promise<ExecutorResult>;
}

async function setup(): Promise<Setup> {
  const repo = await makeRepo();
  const manager = new WorktreeManager({ repoPath: repo });
  const events: EngineEventDraft[] = [];
  return {
    repo,
    manager,
    events,
    build: (testWriter, theCoder, extra = {}) =>
      createTddExecutor({
        manager,
        sessionId: SESSION,
        scheduler: new SeatScheduler({ sessionId: SESSION, backoffBaseMs: 1 }),
        testWriter: { seat: writerSeat, executor: testWriter },
        coder: { seat: coderSeat, executor: theCoder },
        options: { testCommand: "node {files}" },
        emit: (e) => void events.push(e),
        ...extra,
      }),
    run: (ex, taskId = "t1") =>
      ex.run({ taskId, projectPath: repo, contract: createEmptyContract(GOAL), prompt: GOAL }),
  };
}

const gates = (events: EngineEventDraft[], kind: "A" | "B") =>
  events.filter((e) => e.type === "tdd.gate" && e.data.gate === kind).map((e) => e.data.passed);
const tamperResults = (events: EngineEventDraft[]) =>
  events.filter((e) => e.type === "gate.result" && e.data.gate === "tamper").map((e) => e.data.passed);

/** Every seat start (one per round) has exactly one terminal event. */
function expectSeatsSettled(events: EngineEventDraft[]): void {
  const started = new Set(events.filter((e) => e.type === "seat.status" && e.data.status === "editing").map((e) => e.seatId));
  for (const seatId of started) {
    const count = (match: (e: EngineEventDraft) => boolean) => events.filter((e) => e.seatId === seatId && match(e)).length;
    const starts = count((e) => e.type === "seat.status" && e.data.status === "editing");
    expect(count((e) => e.type === "seat.done" || e.type === "seat.error"), `terminal events of ${seatId}`).toBe(starts);
  }
}

async function mainIsUntouched(s: Setup): Promise<void> {
  expect(await git(s.repo, "rev-list", "--count", "HEAD")).toBe("1");
  await expect(fs.access(path.join(s.repo, "add.js"))).rejects.toThrow();
  await expect(fs.access(path.join(s.repo, TEST_FILE))).rejects.toThrow();
  expect(await git(s.repo, "status", "--porcelain")).toBe("");
}

async function failedWorktrees(s: Setup): Promise<number> {
  return (await s.manager.list(SESSION)).filter((w) => w.outcome === "failed").length;
}

describe("red, then green", () => {
  it("the tests fail on the base (Gate A), the coder makes them pass (Gate B), tamper check ok, result applied", async () => {
    const s = await setup();
    const w = writer();
    const c = coder();
    const result = await s.run(s.build(w, c));

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Gate A red");
    expect(result.summary).toContain("Gate B green");
    expect(result.summary).toContain("implemented add");
    expect(gates(s.events, "A")).toEqual([true]);
    expect(gates(s.events, "B")).toEqual([true]);
    expect(tamperResults(s.events)).toEqual([true]);
    expect(await fs.readFile(path.join(s.repo, "add.js"), "utf8")).toBe(IMPL);
    expect(await fs.readFile(path.join(s.repo, TEST_FILE), "utf8")).toBe(TEST_ADD);
    expect(await git(s.repo, "rev-list", "--count", "HEAD")).toBe("2");
    expect(await git(s.repo, "status", "--porcelain")).toBe("");
    // The writer and the coder each ran once, in the same worktree, and never in the project itself.
    expect(w.tasks).toHaveLength(1);
    expect(c.tasks).toHaveLength(1);
    expect(w.tasks[0]!.projectPath).toBe(c.tasks[0]!.projectPath);
    expect(w.tasks[0]!.projectPath).not.toBe(s.repo);
    expect(c.tasks[0]!.prompt).toContain(TEST_FILE);
    expectSeatsSettled(s.events);
    expect(s.events.filter((e) => e.type === "seat.done").map((e) => [e.seatId, e.data.ok])).toEqual([
      [writerSeat.id, true],
      [coderSeat.id, true],
    ]);
  });

  it("passes the locked files to the test command, quoted, and runs the suite when there is no placeholder", async () => {
    const s = await setup();
    const commands: Array<{ command: string; cwd: string }> = [];
    const ex = s.build(writer(TEST_ADD, "tests/it's a test.test.js"), coder(), {
      runCommand: async (command, cwd) => {
        commands.push({ command, cwd });
        return runShellCommand(command, cwd);
      },
    });
    const result = await s.run(ex);
    expect(result.status).toBe("completed");
    expect(commands.map((c) => c.command)).toEqual(Array(2).fill(`node 'tests/it'\\''s a test.test.js'`));

    const whole = await setup();
    const seen: string[] = [];
    const suite = whole.build(writer(), coder(), {
      options: { testCommand: "node tests/add.test.js" },
      runCommand: async (command, cwd) => (seen.push(command), runShellCommand(command, cwd)),
    });
    expect((await whole.run(suite)).status).toBe("completed");
    expect(seen).toEqual(Array(2).fill("node tests/add.test.js"));
  });

  it("Gate B red: the coder runs again with the failing output and the second try lands", async () => {
    const s = await setup();
    const c = scripted(async (task, call) => {
      await write(task, "add.js", call === 1 ? WRONG : IMPL);
      return done(`attempt ${call}`);
    });
    const result = await s.run(s.build(writer(), c));
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("coder attempt 2");
    expect(c.tasks[1]!.prompt).toContain("Gate B failed");
    expect(c.tasks[1]!.prompt).toContain("add(2, 3) was wrong");
    expect(gates(s.events, "B")).toEqual([false, true]);
    expectSeatsSettled(s.events);
  });

  it("Gate B stays red: blocked after maxCoderAttempts, nothing applied, the worktree is kept", async () => {
    const s = await setup();
    const c = coder(WRONG);
    const result = await s.run(s.build(writer(), c, { options: { testCommand: "node {files}", maxCoderAttempts: 2 } }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("TDD blocked: Gate B");
    expect(result.rawOutput).toContain("add(2, 3) was wrong");
    expect(result.summary).not.toContain("add(2, 3) was wrong");
    expect(c.tasks).toHaveLength(2);
    await mainIsUntouched(s);
    expect(await failedWorktrees(s)).toBe(1);
    expect(s.events.filter((e) => e.type === "seat.error").map((e) => e.seatId)).toEqual([coderSeat.id]);
    expectSeatsSettled(s.events);
  });
});

describe("Gate A: no red", () => {
  it("tests that already pass on the base end the round before the coder starts", async () => {
    const s = await setup();
    const c = coder();
    const result = await s.run(s.build(writer(WEAK_TEST), c));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("TDD blocked: Gate A");
    expect(result.summary).toContain("no red");
    expect(c.tasks).toHaveLength(0);
    expect(gates(s.events, "A")).toEqual([false]);
    expect(gates(s.events, "B")).toEqual([]);
    await mainIsUntouched(s);
    expect(await failedWorktrees(s)).toBe(1);
    // The writer failed its job: it ends with seat.error, the coder never started.
    expect(s.events.filter((e) => e.type === "seat.error").map((e) => e.seatId)).toEqual([writerSeat.id]);
    expect(s.events.some((e) => e.seatId === coderSeat.id)).toBe(false);
    expectSeatsSettled(s.events);
  });

  it("a test command that cannot run (exit 127) is not red", async () => {
    const s = await setup();
    const c = coder();
    const result = await s.run(s.build(writer(), c, { options: { testCommand: "exit 127" } }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("could not give a result (exit 127)");
    expect(c.tasks).toHaveLength(0);
  });

  it("no test command at all is refused with a way out", async () => {
    const s = await setup();
    // A root-level test file: a tests/ directory would make the detector pick pytest.
    const result = await s.run(s.build(writer("process.exit(1);\n", "x.test.js"), coder(), { options: {} }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("no test command");
  });
});

describe("who may touch which files", () => {
  it("a test-writer that changes a non-test file, or changes nothing, ends the round", async () => {
    const s = await setup();
    const c = coder();
    const sneaky = scripted(async (task) => {
      await write(task, TEST_FILE, TEST_ADD);
      await write(task, "add.js", IMPL);
      return done();
    });
    const result = await s.run(s.build(sneaky, c));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not tests: add.js");
    expect(c.tasks).toHaveLength(0);
    await mainIsUntouched(s);

    const idle = await setup();
    const none = await idle.run(idle.build(scripted(() => done()), coder()));
    expect(none.summary).toContain("the test-writer made no changes");
  });

  it("a test-writer that deletes an existing test ends the round", async () => {
    const s = await setup();
    await fs.mkdir(path.join(s.repo, "tests"));
    await fs.writeFile(path.join(s.repo, "tests/old.test.js"), "process.exit(1);\n");
    await git(s.repo, "add", ".");
    await git(s.repo, "commit", "-q", "-m", "old test");
    const result = await s.run(
      s.build(
        scripted(async (task) => {
          await fs.rm(path.join(task.projectPath, "tests/old.test.js"));
          return done();
        }),
        coder(),
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("deleted or moved the test tests/old.test.js");
  });
});

describe("tamper check", () => {
  it("a weakened test is blocked even though Gate B is green; nothing is applied", async () => {
    const s = await setup();
    const result = await s.run(s.build(writer(), coder(IMPL, { [TEST_FILE]: WEAK_TEST })));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("TDD blocked: tamper check");
    expect(result.summary).toContain(TEST_FILE);
    expect(gates(s.events, "B")).toEqual([true]);
    expect(tamperResults(s.events)).toEqual([false]);
    await mainIsUntouched(s);
    expect(await failedWorktrees(s)).toBe(1);
    expect(s.events.filter((e) => e.type === "seat.error").map((e) => e.seatId)).toEqual([coderSeat.id]);
    expectSeatsSettled(s.events);
  });

  it("a deleted test is blocked", async () => {
    const s = await setup();
    const deleter = scripted(async (task) => {
      await write(task, "add.js", IMPL);
      await fs.rm(path.join(task.projectPath, TEST_FILE));
      return done();
    });
    const result = await s.run(s.build(writer(), deleter, { options: { testCommand: GATE_ON_IMPL } }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("TDD blocked: tamper check");
    await mainIsUntouched(s);
  });

  it("a renamed test is blocked (the old path is gone)", async () => {
    const s = await setup();
    const mover = scripted(async (task) => {
      await write(task, "add.js", IMPL);
      await fs.rename(path.join(task.projectPath, TEST_FILE), path.join(task.projectPath, "tests/renamed.test.js"));
      return done();
    });
    const result = await s.run(s.build(writer(), mover, { options: { testCommand: GATE_ON_IMPL } }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("TDD blocked: tamper check");
  });

  it("changing a locked test needs a request line for that file, a decider and its approval", async () => {
    const asks: TestChangeRequest[] = [];
    const decide = (approved: boolean) => async (request: TestChangeRequest) => {
      asks.push(request);
      return { approved, reason: approved ? "the test was wrong" : "weakens coverage" };
    };
    const request = `done\nTEST-CHANGE-REQUEST: ${TEST_FILE} | the expected value is wrong`;
    const fixed = `const { add } = require("../add.js");\nif (add(2, 2) !== 4) process.exit(1);\n`;
    const edits = { [TEST_FILE]: fixed };

    // No request line: refused without asking anyone.
    const bare = await setup();
    const none = await bare.run(bare.build(writer(), coder(IMPL, edits), { decideTestChange: decide(true) }));
    expect(none.summary).toContain("without a test change request");
    expect(asks).toHaveLength(0);
    await mainIsUntouched(bare);

    // A request, but nobody who can approve it.
    const nobody = await setup();
    const unanswered = await nobody.run(nobody.build(writer(), coder(IMPL, edits, request)));
    expect(unanswered.summary).toContain("nobody can approve it");
    await mainIsUntouched(nobody);

    // A request for another file does not cover this one.
    const other = await setup();
    const wrongFile = await other.run(
      other.build(writer(), coder(IMPL, edits, "TEST-CHANGE-REQUEST: tests/other.test.js | because"), { decideTestChange: decide(true) }),
    );
    expect(wrongFile.summary).toContain("without a test change request");
    expect(asks).toHaveLength(0);

    // Refused by the reviewer.
    const refused = await setup();
    const no = await refused.run(refused.build(writer(), coder(IMPL, edits, request), { decideTestChange: decide(false) }));
    expect(no.status).toBe("failed");
    expect(no.summary).toContain("was refused: weakens coverage");
    await mainIsUntouched(refused);
    expect(asks).toHaveLength(1);

    // Approved: the reviewer saw the real before/after, the new version lands and is locked from then on.
    asks.length = 0;
    const approved = await setup();
    const yes = await approved.run(approved.build(writer(), coder(IMPL, edits, request), { decideTestChange: decide(true) }));
    expect(yes.status).toBe("completed");
    expect(yes.summary).toContain("approved test change(s)");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      goal: GOAL,
      files: [{ path: TEST_FILE, reason: "the expected value is wrong", before: TEST_ADD, after: fixed }],
    });
    expect(await fs.readFile(path.join(approved.repo, TEST_FILE), "utf8")).toBe(fixed);
    expect(approved.events.some((e) => e.type === "session.warning" && e.data.kind === "tdd.test_change_approved")).toBe(true);
  });

  it("a decider that throws blocks the round", async () => {
    const s = await setup();
    const result = await s.run(
      s.build(writer(), coder(IMPL, { [TEST_FILE]: WEAK_TEST }, `TEST-CHANGE-REQUEST: ${TEST_FILE} | because`), {
        decideTestChange: async () => {
          throw new Error("reviewer offline");
        },
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("could not be decided (reviewer offline)");
    await mainIsUntouched(s);
  });

  it("a new test file added by the coder is not tampering", async () => {
    const s = await setup();
    const extra = `const { add } = require("../add.js");\nif (add(0, 0) !== 0) process.exit(1);\n`;
    const result = await s.run(s.build(writer(), coder(IMPL, { "tests/zero.test.js": extra })));
    expect(result.status).toBe("completed");
    expect(await fs.readFile(path.join(s.repo, "tests/zero.test.js"), "utf8")).toBe(extra);
  });
});

describe("continue: a review asked for changes", () => {
  const contract = createEmptyContract(GOAL);
  const next = (s: Setup, ex: Executor, taskId = "t2") =>
    ex.continue({ taskId, projectPath: s.repo, contract, messages: [], nextPhaseDirective: "also handle strings" });

  it("runs only the coder, against the tests locked by the first round", async () => {
    const s = await setup();
    const w = writer();
    const c = scripted(async (task, call) => {
      await write(task, "add.js", call === 1 ? IMPL : `${IMPL}// reviewed\n`);
      return done(`round ${call}`);
    });
    const ex = s.build(w, c);
    expect((await s.run(ex)).status).toBe("completed");
    const second = await next(s, ex);
    expect(second.status).toBe("completed");
    expect(second.summary).toContain("continued with 1 locked test file(s)");
    expect(w.tasks).toHaveLength(1);
    expect(c.tasks).toHaveLength(2);
    expect(c.tasks[1]!.prompt).toContain("also handle strings");
    expect(gates(s.events, "A")).toEqual([true]);
    expect(await fs.readFile(path.join(s.repo, "add.js"), "utf8")).toContain("// reviewed");
    expectSeatsSettled(s.events);
  });

  it("the lock holds in later rounds: a weakened test is blocked", async () => {
    const s = await setup();
    const c = scripted(async (task, call) => {
      await write(task, "add.js", IMPL);
      if (call === 2) await write(task, TEST_FILE, WEAK_TEST);
      return done();
    });
    const ex = s.build(writer(), c);
    expect((await s.run(ex)).status).toBe("completed");
    const second = await next(s, ex);
    expect(second.status).toBe("failed");
    expect(second.summary).toContain("TDD blocked: tamper check");
    expect(await fs.readFile(path.join(s.repo, TEST_FILE), "utf8")).toBe(TEST_ADD);
  });

  it("without a first round there is nothing locked, so continue starts with the test-writer", async () => {
    const s = await setup();
    const w = writer();
    const result = await next(s, s.build(w, coder()));
    expect(result.status).toBe("completed");
    expect(w.tasks).toHaveLength(1);
  });
});

describe("cancel", () => {
  const settled = async (s: Setup, started: () => boolean, ex: Executor) => {
    const running = s.run(ex);
    await until(started);
    await ex.cancel("t1");
    return running;
  };

  it("cancelling while the coder works cancels it, applies nothing and ends every seat", async () => {
    const s = await setup();
    const c = hanging();
    const ex = s.build(writer(), c);
    const result = await settled(s, () => c.tasks.length > 0, ex);
    expect(result.status).toBe("cancelled");
    expect(c.cancelled).toEqual([`t1.${coderSeat.id}.a1`]);
    await mainIsUntouched(s);
    expectSeatsSettled(s.events);
    expect(s.events.filter((e) => e.type === "seat.done").map((e) => [e.seatId, e.data.ok])).toEqual([
      [writerSeat.id, true],
      [coderSeat.id, false],
    ]);
  });

  it("cancelling while the test-writer works leaves the coder unstarted", async () => {
    const s = await setup();
    const w = hanging();
    const c = coder();
    const result = await settled(s, () => w.tasks.length > 0, s.build(w, c));
    expect(result.status).toBe("cancelled");
    expect(c.tasks).toHaveLength(0);
    expectSeatsSettled(s.events);
  });

  it("cancelling during a gate kills the test command (injected runner)", async () => {
    const s = await setup();
    let killed = false;
    let running = false;
    const ex = s.build(writer(), coder(), {
      runCommand: (_command, _cwd, options) =>
        new Promise((resolve) => {
          running = true;
          options?.signal?.addEventListener("abort", () => {
            killed = true;
            resolve({ stdout: "", stderr: "", code: 130 });
          });
        }),
    });
    const result = await settled(s, () => running, ex);
    expect(result.status).toBe("cancelled");
    expect(killed).toBe(true);
    expectSeatsSettled(s.events);
  });

  it("cancelling during a real gate run kills the process tree", async () => {
    const s = await setup();
    const command = `node -e "require('fs').writeFileSync('gate.pid', String(process.pid)); setTimeout(() => {}, 60000)"`;
    const ex = s.build(writer(), coder(), { options: { testCommand: command } });
    const running = s.run(ex);
    const pidFile = async () => {
      for (const w of await s.manager.list(SESSION)) {
        const text = await fs.readFile(path.join(w.path, "gate.pid"), "utf8").catch(() => "");
        if (text) return Number(text);
      }
      return 0;
    };
    await until(async () => (await pidFile()) > 0);
    const pid = await pidFile();
    await ex.cancel("t1");
    expect((await running).status).toBe("cancelled");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
    expectSeatsSettled(s.events);
  });

  it("runShellCommand honours an abort signal", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runShellCommand("sleep 30", process.cwd(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await pending).code).toBe(130);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await runShellCommand("sleep 30", process.cwd(), { signal: controller.signal })).code).toBe(130);
  });
});

describe("invalid config", () => {
  it("parseTddOptions: defaults, and every bad value is named", () => {
    expect(parseTddOptions({})).toMatchObject({ apply: "squash", maxCoderAttempts: 2 });
    expect(parseTddOptions({ testPatterns: ["spec/**"], maxCoderAttempts: 3 })).toMatchObject({ testPatterns: ["spec/**"], maxCoderAttempts: 3 });
    for (const bad of [{ apply: "patch" }, { maxCoderAttempts: 0 }, { maxCoderAttempts: 6 }, { testPatterns: [] }, { testCommand: "" }, { gateTimeoutMs: -1 }, { gate: "x" }]) {
      expect(typeof parseTddOptions(bad)).toBe("string");
    }
  });

  it("createTddExecutor refuses bad options, the same seat twice and a read-only seat", async () => {
    const s = await setup();
    const base = { manager: s.manager, sessionId: SESSION, scheduler: new SeatScheduler({ sessionId: SESSION }) };
    const seat = (executor: Executor, which = writerSeat) => ({ seat: which, executor });
    expect(() => createTddExecutor({ ...base, testWriter: seat(writer()), coder: seat(coder(), coderSeat), options: { apply: "patch" } })).toThrow(/apply/);
    expect(() => createTddExecutor({ ...base, testWriter: seat(writer()), coder: seat(coder(), writerSeat) })).toThrow(/different seats/);
    const [readOnly] = expandSeatSpecs([{ provider: "mock", model: "ro", role: "engineer" }]);
    expect(() => createTddExecutor({ ...base, testWriter: seat(writer()), coder: seat(coder(), readOnly!) })).toThrow(/edit permission/);
  });

  it("a project path that is not the repository top level fails before anything is created", async () => {
    const s = await setup();
    await fs.mkdir(path.join(s.repo, "pkg"));
    const w = writer();
    const result = await s.build(w, coder()).run({ taskId: "t1", projectPath: path.join(s.repo, "pkg"), contract: createEmptyContract(GOAL), prompt: GOAL });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not the repository top level");
    expect(w.tasks).toHaveLength(0);
    expect(await s.manager.list(SESSION)).toEqual([]);
  });

  it("selectTddSeats wants exactly one test-writer and one coder among the edit seats", () => {
    const seats = (...roles: Array<[string, "edit" | "read-only"]>) =>
      expandSeatSpecs(roles.map(([role, permissions], i) => ({ provider: "mock", model: `m${i}`, role, permissions })));
    expect(selectTddSeats(seats(["test-writer", "edit"], ["engineer", "edit"], ["code-reviewer", "read-only"]))).toMatchObject({
      testWriter: { role: "test-writer" },
      coder: { role: "engineer" },
    });
    for (const bad of [
      seats(["engineer", "edit"]),
      seats(["test-writer", "edit"]),
      seats(["test-writer", "edit"], ["engineer", "read-only"]),
      seats(["test-writer", "edit"], ["test-writer", "edit"], ["engineer", "edit"]),
      seats(["test-writer", "edit"], ["engineer", "edit"], ["refactorer", "edit"]),
    ]) {
      expect(typeof selectTddSeats(bad)).toBe("string");
    }
  });

  it("parseTestChangeRequests reads one request per line and ignores the rest", () => {
    const text = [
      "Implemented it.",
      "TEST-CHANGE-REQUEST: tests/a.test.js | expected value is wrong",
      "- test change request: `./tests/B.test.js` | contradicts the task | really",
      "TEST-CHANGE-REQUEST: no reason given",
    ].join("\n");
    expect([...parseTestChangeRequests(text)]).toEqual([
      ["tests/a.test.js", "expected value is wrong"],
      ["tests/b.test.js", "contradicts the task | really"],
    ]);
  });

  it("reviewerTestChangeDecision: PASS approves; anything else refuses", async () => {
    const request: TestChangeRequest = { goal: GOAL, files: [{ path: TEST_FILE, reason: "wrong", before: "a", after: null }] };
    const ask = (reviewer: MockReviewer) => reviewerTestChangeDecision(reviewer, "/tmp/x")(request, new AbortController().signal);
    expect(await ask(new MockReviewer({ steps: [{ type: "pass", summary: "justified" }] }))).toEqual({ approved: true, reason: "justified" });
    expect(await ask(new MockReviewer({ steps: [{ type: "needs_work", summary: "weakens" }] }))).toMatchObject({ approved: false, reason: "weakens" });
    expect(await ask(new MockReviewer({ steps: [{ type: "blocked", summary: "no" }] }))).toMatchObject({ approved: false });
    expect(await ask(new MockReviewer({ steps: [{ type: "custom", error: "offline" }] }))).toEqual({ approved: false, reason: "offline" });
  });
});

describe("the tdd mode", () => {
  const roster = [
    { provider: "mock", model: "writer", role: "test-writer", permissions: "edit" },
    { provider: "mock", model: "coder", role: "engineer", permissions: "edit" },
  ];
  const config = (modes: Record<string, unknown> = { tdd: { team: "tdd", testCommand: "node {files}" } }) =>
    parseAssentorConfig({ teams: { tdd: { seats: roster }, bad: { seats: [roster[1]] } }, modes });

  it("is registered as a static mode with a builder, but not CLI-available yet", () => {
    const mode = getMode("tdd")!;
    expect(mode).toMatchObject({ kind: "static", editsCode: true, available: false });
    expect(typeof mode.buildSession).toBe("function");
    expect(listModes().filter((m) => m.available).map((m) => m.id)).toEqual(["solo"]);
  });

  const problemsOf = (cfg: ReturnType<typeof config>) => {
    try {
      prepareModeSession({
        mode: "tdd",
        sessionId: createId(),
        goal: GOAL,
        autonomy: "supervised",
        config: cfg,
        deps: {} as StageRunnerDeps,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ModeValidationError);
      return (error as ModeValidationError).problems;
    }
    return [];
  };

  it("rejects a missing section, a typo, an unknown team and a team that does not fit", () => {
    expect(problemsOf(config({}))).toEqual(["tdd mode needs modes.tdd with a team (one test-writer seat and one coder seat)"]);
    expect(problemsOf(config({ tdd: { team: "tdd", testComand: "x" } })).join()).toContain("modes.tdd.(section)");
    expect(problemsOf(config({ tdd: { team: "ghosts" } })).join()).toContain('unknown team "ghosts"');
    expect(problemsOf(config({ tdd: { team: "bad" } })).join()).toContain("exactly one edit seat");
    expect(problemsOf(config({ tdd: { team: "tdd", apply: "patch" } })).join()).toContain("modes.tdd.apply");
  });

  it("builds execute(tdd) → review(panel) from modes.tdd; manual autonomy gates the tdd stage", () => {
    const build = (autonomy: "supervised" | "manual") =>
      prepareModeSession({
        mode: "tdd",
        sessionId: createId(),
        goal: GOAL,
        autonomy,
        config: config({ tdd: { team: "tdd", testCommand: "node {files}", maxCoderAttempts: 3 } }),
        // Static modes only touch the deps when they run, apart from the stage checks.
        deps: { projectPath: os.tmpdir(), seatsFor: () => [], scheduler: new SeatScheduler({ sessionId: "s" }) } as unknown as StageRunnerDeps,
      }).spec!.stages;
    expect(build("supervised")).toMatchObject([
      { id: "tdd", kind: "execute", strategy: "tdd", team: "tdd", options: { testCommand: "node {files}", maxCoderAttempts: 3 }, next: "review", requireApproval: false },
      { id: "review", kind: "review", strategy: "panel" },
    ]);
    expect(build("manual").map((s) => s.requireApproval)).toEqual([true, false]);
  });

  /** Full session: Supervisor + panel review around the TDD executor, in a real repo. */
  async function session(coderExecutor: Executor, testWriter: Executor = writer(), reviewer = new MockReviewer({ name: "r" })) {
    const s = await setup();
    const cfg = config();
    const sessionId = createId();
    const seatsFor = (stage: StageSpec) => expandSeatSpecs(cfg.teams[stage.team!]!.seats, { teamName: stage.team });
    const scheduler = new SeatScheduler({ sessionId, backoffBaseMs: 1 });
    const events: EngineEventDraft[] = [];
    const prepared = prepareModeSession({
      mode: "tdd",
      sessionId,
      goal: GOAL,
      autonomy: "supervised",
      config: cfg,
      emit: (e) => void events.push(e),
      deps: {
        projectPath: s.repo,
        scheduler,
        runStep: async () => {
          throw new Error("no negotiation steps in tdd mode");
        },
        seatsFor,
        createExecutor: (stage) => {
          if (stage.strategy !== "tdd") throw new Error(`unexpected strategy ${stage.strategy}`);
          const seats = selectTddSeats(seatsFor(stage)) as Exclude<ReturnType<typeof selectTddSeats>, string>;
          return createTddExecutor({
            manager: s.manager,
            sessionId,
            scheduler,
            testWriter: { seat: seats.testWriter, executor: testWriter },
            coder: { seat: seats.coder, executor: coderExecutor },
            options: stage.options,
            emit: (e) => void events.push(e),
            decideTestChange: reviewerTestChangeDecision(new MockReviewer({ steps: [{ type: "needs_work", summary: "no" }] }), s.repo),
          });
        },
        createReviewer: () => new PanelReviewer({ name: "panel", policy: "majority", reviewers: [reviewer] }),
        supervisor: { skipGates: true },
      },
    });
    return { s, events, run: () => prepared.run() };
  }

  it("end to end through prepareModeSession: red, green, tamper ok, review PASS, result in the project", async () => {
    const { s, events, run } = await session(coder());
    const result = await run();
    expect(result).toMatchObject({ status: "completed", mode: "tdd" });
    expect(events[0]).toMatchObject({ type: "mode.selected", data: { mode: "tdd", kind: "static" } });
    expect(events.at(-1)).toMatchObject({ type: "session.completed" });
    expect(gates(events, "A")).toEqual([true]);
    expect(gates(events, "B")).toEqual([true]);
    expect(await fs.readFile(path.join(s.repo, "add.js"), "utf8")).toBe(IMPL);
    expect(events.filter((e) => e.type === "stage.completed").map((e) => [e.stageId, e.data.outcome])).toEqual([
      ["review", "pass"],
      ["tdd", "pass"],
    ]);
    expectSeatsSettled(events);
  });

  it("end to end: a weakened test fails the session with the tamper reason, and the project is untouched", async () => {
    const { s, events, run } = await session(coder(IMPL, { [TEST_FILE]: WEAK_TEST }, `TEST-CHANGE-REQUEST: ${TEST_FILE} | because`));
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("TDD blocked: tamper check");
    expect(result.reason).toContain("was refused: no");
    expect(events.at(-1)).toMatchObject({ type: "session.failed" });
    await mainIsUntouched(s);
    expectSeatsSettled(events);
  });

  it("end to end: review NEEDS_WORK sends the coder back with the tests still locked", async () => {
    const reviewer = new MockReviewer({ name: "r", steps: [{ type: "needs_work", requiredChanges: ["add a comment"] }] });
    const c = scripted(async (task, call) => {
      await write(task, "add.js", call === 1 ? IMPL : `${IMPL}// commented\n`);
      return done(`round ${call}`);
    });
    const w = writer();
    const { s, run } = await session(c, w, reviewer);
    const result = await run();
    expect(result.status).toBe("completed");
    expect(w.tasks).toHaveLength(1);
    expect(c.tasks).toHaveLength(2);
    expect(await fs.readFile(path.join(s.repo, "add.js"), "utf8")).toContain("// commented");
  });
});
