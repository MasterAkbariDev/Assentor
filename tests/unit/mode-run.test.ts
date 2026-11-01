import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionEvents, type EngineEvent } from "../../packages/engine/src/index.js";
import { createMockLead, type MockLeadStep } from "../../packages/engine/src/modes/lead/mock.js";
import type { RosterEntry } from "../../packages/engine/src/modes/roster.js";
import type { Executor, ExecutorTask } from "../../packages/engine/src/providers/executors/types.js";
import { resumeAssentorTask, runAssentorTask } from "../../packages/cli/src/cli/commands.js";
import { runModeTask, type ModeRunHooks } from "../../packages/cli/src/cli/mode-run.js";
import type { QuestionIO } from "../../packages/cli/src/cli/mode-questions.js";

// `assentor run --mode <id>` end to end through the CLI command function, with mock seats.

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();

const GOAL = "Add x to module a";
const ROSTER: RosterEntry[] = [
  { provider: "mock", model: "cheap", label: "cheap", strengths: ["coding"], speed: "fast", cost: "low", freeSlots: 2 },
];
/** One reply that fits every negotiation step's schema (zod drops the other keys). */
const STEP_REPLY = JSON.stringify({
  proposal: "Use plan A",
  changes: "",
  critiques: [],
  ranking: ["Proposal A"],
  agree: true,
  preferred: "Proposal A",
  confidence: 0.9,
  answer: "A",
  sources: [],
  winner: "Proposal A",
  reasons: ["fine"],
  consensus: true,
});
const ro = (role: string) => ({ provider: "mock", role, permissions: "read-only" });
const ed = (role: string) => ({ provider: "mock", role, permissions: "edit" });

let repo: string;
let userDir: string;
const savedUserDir = process.env.ASSENTOR_USER_DIR;

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mode-run-")));
  userDir = await fs.mkdtemp(path.join(os.tmpdir(), "mode-run-user-"));
  process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
  await git(repo, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "assentor@test");
  await git(repo, "config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(repo, ".gitignore"), ".assentor/\n");
  await fs.mkdir(path.join(repo, "a"));
  await fs.writeFile(path.join(repo, "a", "base.txt"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
});

afterEach(async () => {
  if (savedUserDir === undefined) delete process.env.ASSENTOR_USER_DIR;
  else process.env.ASSENTOR_USER_DIR = savedUserDir;
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(userDir, { recursive: true, force: true });
});

async function writeConfig(extra: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(repo, ".assentor"), { recursive: true });
  const config = { git: { checkpoints: false }, executor: { provider: "mock" }, reviewers: [{ provider: "mock" }], ...extra };
  await fs.writeFile(path.join(repo, ".assentor", "config.yaml"), JSON.stringify(config), "utf8");
}

/** A terminal that answers every prompt with the next scripted line; `asked` keeps the prompts. */
function terminal(answers: string[], endWhenOut = false): QuestionIO & { asked: string[] } {
  const input = new PassThrough();
  const asked: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      const text = String(chunk);
      if (text.includes("? ")) {
        asked.push(text.trim());
        const next = answers.shift();
        if (next !== undefined) setImmediate(() => input.write(`${next}\n`));
        else if (endWhenOut) setImmediate(() => input.end());
      }
      done();
    },
  });
  return { input, output, interactive: true, asked };
}
const noTerminal = (): QuestionIO => ({ input: new PassThrough(), output: new PassThrough(), interactive: false });

/**
 * Through `runAssentorTask` (the CLI command function). `direct`: through `runModeTask`, past the
 * `available` check, for modes whose routing is wired but which stay unavailable (lead, pair,
 * redteam, tdd, swarm, debug: no dependency install in new worktrees yet).
 */
async function run(modeId: string, hooks: ModeRunHooks = {}, over: Record<string, unknown> = {}, direct = false) {
  const events: EngineEvent[] = [];
  const { result } = await (direct ? runModeTask : runAssentorTask)({
    projectPath: repo,
    prompt: GOAL,
    modeId: modeId as never,
    skipPreflight: true,
    skipGates: true,
    onEngineEvent: (e) => void events.push(e),
    modeHooks: { questions: noTerminal(), ...hooks },
    ...over,
  });
  return { result, events, of: (type: string) => events.filter((e) => e.type === type) };
}

/** An agent that writes `file` in its worktree and reports it as Lead expects. */
const writer = (file: string): Executor => ({
  name: "writer",
  capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
  async run(task: ExecutorTask) {
    await fs.writeFile(path.join(task.projectPath, file), "export const x = 1;\n");
    const report = { taskId: "T1", status: "done", summary: "did it", filesChanged: [file], testsRun: [] };
    return { status: "completed", summary: ["```json", JSON.stringify(report), "```"].join("\n") };
  },
  continue: async () => ({ status: "failed", summary: "no", error: "no" }),
  cancel: async () => undefined,
});

const LEAD_SCRIPT: MockLeadStep[] = [
  {
    actions: [
      { action: "plan_tasks", tasks: [{ id: "T1", title: "Add x", ownedPaths: ["a"], acceptance: ["a/x.ts exports x"] }] },
      { action: "assign", taskId: "T1", seat: { role: "engineer", provider: "mock", model: "cheap", permissions: "edit" } },
    ],
  } as never,
  { actions: [{ action: "review", taskId: "T1" }, { action: "accept", taskId: "T1" }, { action: "integrate", taskIds: ["T1"] }] } as never,
  { actions: [{ action: "finish", summary: "x added" }] } as never,
];

describe("assentor run --mode (mock seats, real CLI command path)", { timeout: 120_000 }, () => {
  it("review: no executor, the configured reviewers judge the work already there", async () => {
    await writeConfig({});
    const { result, of } = await run("review");
    expect(result).toMatchObject({ status: "completed" });
    expect(of("mode.selected")[0]?.data).toMatchObject({ mode: "review", kind: "static" });
    // The session log is the one the run wrote.
    expect((await readSessionEvents(repo, result.taskId)).map((e) => e.type)).toContain("session.completed");
  });

  it("negotiate: each step renders the library prompt for a seat and parses its JSON reply", async () => {
    await writeConfig({ teams: { peers: { seats: [ro("architect"), ro("planner")] } }, modes: { negotiate: { team: "peers", strategy: "debate" } } });
    const prompts: string[] = [];
    const { result } = await run("negotiate", { askSeat: async ({ prompt }) => (prompts.push(prompt), `Here you go:\n${STEP_REPLY}`) });
    expect(result).toMatchObject({ status: "completed" });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).toContain(GOAL);
  });

  it("negotiate: steps get the user's skills (index, trigger, load_skill re-ask) and skill.loaded is logged", async () => {
    await writeConfig({ teams: { peers: { seats: [ro("architect"), ro("planner")] } }, modes: { negotiate: { team: "peers", strategy: "debate" } } });
    for (const [name, extra] of [["module-tips", "autoload:\n  keywords: [module]\n"], ["on-ask", ""]] as const) {
      const dir = path.join(userDir, ".assentor", "skills", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use for ${name}.\n${extra}version: 1\n---\nBODY-${name}\n`);
    }
    const prompts: string[] = [];
    const { result, of } = await run("negotiate", {
      askSeat: async ({ prompt }) => (prompts.push(prompt), prompts.length === 1 ? "load_skill: on-ask" : STEP_REPLY),
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(prompts[0]).toContain("- on-ask: Use for on-ask.");
    expect(prompts[0]).toContain("BODY-module-tips");
    expect(prompts[0]).not.toContain("BODY-on-ask");
    // Seats ask in parallel: the asking seat's re-ask (and only that seat's prompts) carries the body.
    expect(prompts.filter((p) => p.includes("BODY-on-ask")).length).toBeGreaterThanOrEqual(1);
    expect(prompts.filter((p) => !p.includes("BODY-on-ask")).length).toBeGreaterThanOrEqual(2);
    expect(of("skill.loaded").length).toBeGreaterThanOrEqual(3);
  });

  it("lead: plans, hires from the roster, the agent works in a worktree, the terminal approves the landing", async () => {
    await writeConfig({ modes: { lead: { lead: { provider: "mock", model: "lead" } } } });
    const lead = createMockLead(LEAD_SCRIPT);
    const io = terminal(["y"]);
    const { result, of } = await run("lead", { askSeat: lead.askSeat, roster: () => ROSTER, seatExecutor: () => writer("a/x.ts"), questions: io }, {}, true);
    expect(result).toMatchObject({ status: "completed", reason: "x added" });
    expect(io.asked).toEqual([expect.stringContaining("to your branch")]);
    expect(of("user.answer")).toEqual([expect.objectContaining({ data: expect.objectContaining({ answer: "approve" }) })]);
    expect(await git(repo, "show", "HEAD:a/x.ts")).toBe("export const x = 1;");
  });

  it("lead without a terminal: the landing is denied (fail closed) and nothing reaches the branch", async () => {
    await writeConfig({ modes: { lead: { lead: { provider: "mock", model: "lead" } } } });
    const lead = createMockLead(LEAD_SCRIPT);
    const { result, of } = await run("lead", { askSeat: lead.askSeat, roster: () => ROSTER, seatExecutor: () => writer("a/x.ts") }, {}, true);
    // The refused landing goes back to the lead (whose script then runs out); the work never lands.
    expect(result.status).not.toBe("completed");
    expect(of("user.answer")).toEqual([expect.objectContaining({ data: expect.objectContaining({ answer: "deny" }) })]);
    await expect(git(repo, "show", "HEAD:a/x.ts")).rejects.toThrow();
  });

  it("lead resumes through assentor resume with the saved board; a non-resumable mode says so", async () => {
    await writeConfig({ modes: { lead: { lead: { provider: "mock", model: "lead" } } } });
    // The lead seat fails after planning: the session ends blocked with the board saved.
    const first = await run("lead", { askSeat: createMockLead([LEAD_SCRIPT[0]!]).askSeat, roster: () => ROSTER, seatExecutor: () => writer("a/x.ts") }, {}, true);
    expect(first.result.status).toBe("blocked");
    const lead = createMockLead(LEAD_SCRIPT.slice(1));
    const resumed = await resumeAssentorTask({
      projectPath: repo,
      taskId: first.result.taskId,
      modeHooks: { askSeat: lead.askSeat, roster: () => ROSTER, questions: terminal(["approve"]) },
    });
    expect(resumed).toMatchObject({ taskId: first.result.taskId, status: "completed", reason: "x added" });
    expect(lead.prompts[0]).toContain("T1");

    const review = await run("review");
    await expect(resumeAssentorTask({ projectPath: repo, taskId: review.result.taskId })).rejects.toThrow(/Mode review cannot resume/);
  });

  it("cascade: the first tier's team implements and its review team passes it", async () => {
    await writeConfig({
      teams: { cheap: { seats: [ed("engineer")] }, top: { seats: [ed("engineer")] }, r1: { seats: [ro("code-reviewer")] } },
      modes: { cascade: { tiers: [{ team: "cheap", reviewTeam: "r1" }, { team: "top", reviewTeam: "r1" }] } },
    });
    const { result, of } = await run("cascade", { questions: terminal(["y", "y", "y"], true) });
    expect(result.status).toBe("completed");
    expect(of("mode.selected")[0]?.data).toMatchObject({ mode: "cascade" });
  });

  const PLAYBOOK_TEAMS = {
    analysis: { seats: [ro("requirements-analyst"), ro("devils-advocate")] },
    design: { seats: [ro("architect"), ro("planner")] },
    builders: { seats: [ed("engineer"), ed("test-writer"), ed("docs-writer")] },
    reviewers: { seats: [ro("code-reviewer"), ro("security-reviewer")] },
    investigators: { seats: [ro("architect"), ro("test-reviewer"), ro("code-reviewer")] },
    summary: { seats: [ro("summarizer"), ro("devils-advocate")] },
    planning: { seats: [ro("planner"), ro("architect")] },
  };

  it("pipeline: debates run on seats, the build stage's approval gate is answered at the terminal", async () => {
    await writeConfig({ teams: PLAYBOOK_TEAMS });
    const io = terminal(["y"]);
    const { result } = await run("pipeline", { askSeat: async () => STEP_REPLY, questions: io });
    expect(result.status).toBe("completed");
    expect(io.asked).toEqual([expect.stringContaining('Start stage "build"?')]);
  });

  it("pipeline without a terminal: the build gate cannot be approved, so the session is cancelled", async () => {
    await writeConfig({ teams: PLAYBOOK_TEAMS });
    const { result } = await run("pipeline", { askSeat: async () => STEP_REPLY });
    expect(result.status).toBe("cancelled");
  });

  it.each(["explore", "plan"])("%s: read-only playbook runs its debates on the seats", async (mode) => {
    await writeConfig({ teams: PLAYBOOK_TEAMS });
    const { result } = await run(mode, { askSeat: async () => STEP_REPLY });
    expect(result.status).toBe("completed");
  });

  it("pair: the navigator watches through the host and the driver's work lands after approval", async () => {
    await writeConfig({
      teams: { drivers: { seats: [ed("engineer")] }, navigators: { seats: [ro("navigator")] } },
      modes: { pair: { driverTeam: "drivers", navigatorTeam: "navigators", intervalSec: 600 } },
    });
    const navigator: string[] = [];
    const { result } = await run("pair", {
      askSeat: async ({ prompt }) => (navigator.push(prompt), "NO_COMMENT"),
      seatExecutor: () => writer("a/x.ts"),
      questions: terminal(["y", "y"], true),
    }, {}, true);
    expect(result.status).toBe("completed");
    expect(navigator.length).toBeGreaterThan(0);
  });

  it("redteam: the read-only attacker answers through a read-only ask, never an edit executor", async () => {
    await writeConfig({
      teams: { attackers: { seats: [ro("red-team-attacker")] }, builders: { seats: [ed("engineer")] } },
      modes: { redteam: { attackerTeam: "attackers", builderTeam: "builders", maxRounds: 1 } },
      verification: { commands: { test: "true" } },
    });
    const attacker: string[] = [];
    const { result } = await run("redteam", {
      askSeat: async ({ seat, prompt }) => (attacker.push(`${seat.role}:${prompt.slice(0, 20)}`), JSON.stringify({ yield: true, attacks: [] })),
      questions: terminal(["y"]),
    }, {}, true);
    expect(attacker).toEqual([expect.stringMatching(/^red-team-attacker:/)]);
    expect(["completed", "blocked"]).toContain(result.status);
  });

  it("tdd: the host builds the TDD executor for strategy tdd (its gates run)", async () => {
    await writeConfig({
      teams: { tdd: { seats: [ed("test-writer"), ed("engineer")] } },
      modes: { tdd: { team: "tdd", testCommand: "true" } },
    });
    const { result, of } = await run("tdd", {}, {}, true);
    // The mock test-writer changes nothing, so TDD blocks the round: proof its executor ran, not plain solo.
    expect(result.status).not.toBe("completed");
    expect(JSON.stringify(of("seat.status").map((e) => e.data)) + (result.reason ?? "")).toMatch(/test|TDD/i);
  });

  it("swarm: items split from the config run on the worker team", async () => {
    await fs.writeFile(path.join(repo, "a", "one.txt"), "1\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "one");
    await writeConfig({
      teams: { cheap: { seats: [ed("engineer")] } },
      modes: { swarm: { workerTeam: "cheap", files: ["a/one.txt"] } },
      verification: { commands: { test: "true" } },
    });
    const { result, of } = await run("swarm", { questions: terminal(["y", "y"], true) }, {}, true);
    expect(of("mode.selected")[0]?.data).toMatchObject({ mode: "swarm" });
    expect(["completed", "blocked"]).toContain(result.status);
  });

  it("debug: hypothesis seats run in their own worktrees", async () => {
    await writeConfig({
      teams: { hyp: { seats: [{ ...ed("debugger"), count: 2 }] }, fixers: { seats: [ed("engineer")] } },
      modes: { debug: { hypothesisTeam: "hyp", fixTeam: "fixers", reproCommand: "false", maxRounds: 1 } },
    });
    const cwds: string[] = [];
    const reply = JSON.stringify({ hypothesis: "h", experiment: "log", verdict: "refuted", confidence: 0.5, evidence: "none" });
    const { result } = await run("debug", {
      seatExecutor: () => ({
        name: "hyp",
        capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
        run: async (task) => (cwds.push(task.projectPath), { status: "completed", summary: reply }),
        continue: async () => ({ status: "failed", summary: "no", error: "no" }),
        cancel: async () => undefined,
      }),
      questions: terminal(["y"]),
    }, {}, true);
    expect(cwds.length).toBeGreaterThanOrEqual(2);
    for (const cwd of cwds) expect(cwd).not.toBe(repo);
    expect(["completed", "blocked"]).toContain(result.status);
  });

  it("--retro appends the retro seat's lessons to .assentor/memory/lessons.md", async () => {
    await writeConfig({});
    const { result } = await run("review", { askSeat: async () => "- Worked: the mock reviewer passed at once.\nnot a bullet" }, { retro: true });
    expect(result.status).toBe("completed");
    const lessons = await fs.readFile(path.join(repo, ".assentor", "memory", "lessons.md"), "utf8");
    expect(lessons).toContain(`session ${result.taskId}`);
    expect(lessons).toContain("- Worked: the mock reviewer passed at once.");
    expect(lessons).not.toContain("not a bullet");
  });

  it("lead, pair, redteam, tdd, swarm and debug are refused by the CLI until worktrees get dependencies", async () => {
    await writeConfig({});
    for (const id of ["lead", "pair", "redteam", "tdd", "swarm", "debug"]) {
      await expect(run(id)).rejects.toThrow(`Mode ${id} is not available yet.`);
    }
  });

  it("stdin closing at a prompt cancels the session instead of leaving it waiting", async () => {
    await writeConfig({ modes: { lead: { lead: { provider: "mock", model: "lead" } } } });
    const lead = createMockLead(LEAD_SCRIPT);
    // stdin ends (Ctrl+D) when the landing question is shown.
    const io = terminal([], true);
    const { result, of } = await run("lead", { askSeat: lead.askSeat, roster: () => ROSTER, seatExecutor: () => writer("a/x.ts"), questions: io }, {}, true);
    expect(result.status).toBe("cancelled");
    expect(of("user.answer")).toEqual([]);
    await expect(git(repo, "show", "HEAD:a/x.ts")).rejects.toThrow();
  });

  it("a read-only seat never reaches the seatExecutor hook (fail closed on permissions)", async () => {
    await writeConfig({
      teams: { attackers: { seats: [ro("red-team-attacker")] }, builders: { seats: [ed("engineer")] } },
      modes: { redteam: { attackerTeam: "attackers", builderTeam: "builders", maxRounds: 1 } },
      verification: { commands: { test: "true" } },
    });
    const hooked: string[] = [];
    const asked: string[] = [];
    await run("redteam", {
      askSeat: async ({ seat }) => (asked.push(seat.permissions), JSON.stringify({ yield: true, attacks: [] })),
      seatExecutor: (seat) => (hooked.push(seat.permissions), writer("a/x.ts")),
      questions: terminal(["y"]),
    }, {}, true);
    expect(asked).toEqual(["read-only"]);
    expect(hooked).toEqual(["edit"]);
  });

  it("an invalid mode config fails before any work and leaves no session record to resume", async () => {
    await writeConfig({});
    await expect(run("negotiate")).rejects.toThrow(/modes\.negotiate/);
    const sessions = await fs.readdir(path.join(repo, ".assentor", "sessions")).catch(() => []);
    for (const id of sessions) await expect(fs.stat(path.join(repo, ".assentor", "sessions", id, "mode-run.json"))).rejects.toThrow();
  });
});
