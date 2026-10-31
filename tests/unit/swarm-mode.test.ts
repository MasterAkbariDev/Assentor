import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandSeatSpecs,
  MockReviewer,
  parseAssentorConfig,
  prepareModeSession,
  WorktreeManager,
  type EngineEventDraft,
  type Executor,
  type ExecutorResult,
  type ExecutorTask,
  type ModeControllerInput,
  type ModeControllerResult,
  type StageSpec,
} from "../../src/index.js";
import type { MockReviewerStep } from "../../src/providers/reviewers/mock/index.js";
import { checkSwarmItems, chunkItems, createSwarmController, swarmProblems, swarmTiers, type SwarmExtras, type SwarmWorkItem } from "../../src/modes/swarm.js";
import { SeatScheduler } from "../../src/seats/index.js";

const exec = promisify(execFile);
// Real git in temp repos, like the debug and best-of-n tests.
vi.setConfig({ testTimeout: 120_000 });
const SESSION = "55555555-5555-4555-8555-555555555555";
const dirs: string[] = [];
const FILES = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];

const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assentor-swarm-")));
  dirs.push(dir);
  await git(dir, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "assentor@test");
  await git(dir, "config", "user.name", "Assentor Test");
  await fs.writeFile(path.join(dir, ".gitignore"), ".assentor/\n");
  for (const f of FILES) await fs.writeFile(path.join(dir, f), `old ${f}\n`);
  await fs.mkdir(path.join(dir, "docs"));
  await fs.writeFile(path.join(dir, "docs/note.md"), "old note\n");
  await fs.symlink("a.txt", path.join(dir, "link.txt"));
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const baseConfig = (swarm: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  parseAssentorConfig({
    teams: {
      cheap: { seats: [{ provider: "mock", model: "c", count: 2, permissions: "edit" }] },
      strong: { seats: [{ provider: "mock", model: "s", permissions: "edit" }] },
    },
    modes: {
      swarm: { workerTeam: "cheap", files: ["*.txt"], batchSize: 2, ...swarm },
      cascade: { tiers: [{ team: "cheap" }, { team: "strong" }] },
    },
    verification: { commands: { test: "gate" } },
    ...extra,
  });

const done = (summary = "done", rawOutput?: string): ExecutorResult => ({ status: "completed", summary, ...(rawOutput ? { rawOutput } : {}) });
const commandSignals: boolean[] = [];
/** The scripted "test suite": fails while any text file in the worktree says BAD. */
const runCommand: NonNullable<SwarmExtras["runCommand"]> = async (_command, cwd, options) => {
  commandSignals.push(options?.signal instanceof AbortSignal);
  const names = (await fs.readdir(cwd)).filter((n) => n.endsWith(".txt"));
  for (const n of names) {
    if ((await fs.readFile(path.join(cwd, n), "utf8").catch(() => "")).includes("BAD")) return { stdout: "", stderr: `BAD found in ${n}`, code: 1 };
  }
  return { stdout: "ok", stderr: "", code: 0 };
};

interface Work {
  itemId: string;
  tier: number;
  file: string;
  cwd: string;
  prompt: string;
}
const edit = async (w: Work, text = "new") => {
  await fs.writeFile(path.join(w.cwd, w.file), `${text} ${w.file}\n`);
  return done(`changed ${w.file}`);
};

interface Setup {
  repo: string;
  events: EngineEventDraft[];
  prompts: Work[];
  manager: WorktreeManager;
  input: ModeControllerInput;
  run(over?: Partial<ModeControllerInput>, extras?: SwarmExtras): Promise<ModeControllerResult>;
}

async function setup(opts: {
  config?: ReturnType<typeof baseConfig>;
  work?: (w: Work) => Promise<ExecutorResult> | ExecutorResult;
  review?: MockReviewerStep[];
  repo?: string;
}): Promise<Setup> {
  const repo = opts.repo ?? (await makeRepo());
  const manager = new WorktreeManager({ repoPath: repo });
  const config = opts.config ?? baseConfig();
  const events: EngineEventDraft[] = [];
  const prompts: Work[] = [];
  const seatsFor = (stage: StageSpec) => expandSeatSpecs(config.teams[stage.team!]!.seats, { teamName: stage.team });
  const createExecutor = (stage: StageSpec): Executor => ({
    name: "mock-executor",
    capabilities: () => ({ canEditFiles: true, canRunCommands: true, canContinueSession: false, supportsScreenshots: false }),
    async run(task: ExecutorTask) {
      const itemId = String(stage.options?.itemId);
      // The prompt names the owned file; the item ids follow the sorted split of a.txt..e.txt.
      const file = FILES[Number(itemId.slice(1)) - 1]!;
      const work: Work = { itemId, tier: stage.id === "swarm-t1" ? 1 : 2, file, cwd: task.projectPath, prompt: task.prompt };
      prompts.push(work);
      return (opts.work ?? edit)(work);
    },
    async continue() {
      throw new Error("never continues");
    },
    async cancel() {},
  });
  const reviewer = new MockReviewer({ steps: opts.review ?? [{ type: "pass" }] });
  const deps = {
    projectPath: repo,
    scheduler: new SeatScheduler({ sessionId: SESSION, backoffBaseMs: 1 }),
    runStep: async () => ({}),
    seatsFor,
    createExecutor,
    createReviewer: () => reviewer,
  } as ModeControllerInput["deps"];
  const input: ModeControllerInput = {
    goal: "replace old with new",
    title: "t",
    autonomy: "autopilot",
    config,
    sessionId: SESSION,
    stages: {} as ModeControllerInput["stages"],
    deps,
    worktrees: manager,
    host: {},
    requestApproval: async () => false,
    ask: async () => undefined,
    resume: false,
    signal: new AbortController().signal,
    emit: (e) => void events.push(e),
  };
  return { repo, events, prompts, manager, input, run: (over = {}, extras = {}) => createSwarmController({ ...input, ...over }, { runCommand, ...extras }).run() };
}

const read = (repo: string, file: string) => fs.readFile(path.join(repo, file), "utf8");
const itemEvents = (s: Setup) => s.events.filter((e) => e.type === "swarm.item").map((e) => e.data as { itemId: string; status: string; tier: number });
const statusesOf = (s: Setup, id: string) => itemEvents(s).filter((e) => e.itemId === id).map((e) => e.status);
async function expectUntouched(s: Setup) {
  for (const f of FILES) expect(await read(s.repo, f)).toBe(`old ${f}\n`);
  expect(await git(s.repo, "log", "--format=%s")).toBe("init");
}

describe("swarm splitter and ownership", () => {
  it("chunks files into items and refuses overlapping, unsafe or duplicate ownership", () => {
    expect(chunkItems(["a", "b", "c"], 2)).toEqual([
      { id: "i1", files: ["a", "b"] },
      { id: "i2", files: ["c"] },
    ]);
    const bad = (items: SwarmWorkItem[]) => {
      const r = checkSwarmItems(items);
      return r.ok ? [] : r.problems.join("\n");
    };
    expect(bad([{ id: "i1", files: ["src"] }, { id: "i2", files: ["src/a.ts"] }])).toContain("overlapping");
    expect(bad([{ id: "i1", files: ["A.ts"] }, { id: "i2", files: ["a.ts"] }])).toContain("overlapping");
    expect(bad([{ id: "i1", files: ["../x"] }])).toContain("'..'");
    expect(bad([{ id: "i1", files: ["/etc/passwd"] }])).toContain("repo-relative");
    expect(bad([{ id: "i1", files: [".git/hooks/pre-commit"] }])).toContain(".git cannot be owned");
    expect(bad([{ id: "i1", files: ["a"] }, { id: "i1", files: ["b"] }])).toContain("duplicate");
    expect(bad([{ id: "i1", files: [] }])).toContain("owns no files");
    expect(bad([])).toContain("no items");
    expect(checkSwarmItems([{ id: "i1", files: ["a"] }, { id: "i2", files: ["b/c"] }]).ok).toBe(true);
  });

  it("validates the config: needs files or grep, known teams with edit seats; tiers follow Cascade", () => {
    expect(swarmProblems(baseConfig())).toEqual([]);
    expect(swarmProblems(parseAssentorConfig({}))).toEqual(["swarm mode needs modes.swarm (workerTeam and files or grep) in the config"]);
    expect(swarmProblems(baseConfig({ files: [] }))).toEqual(["modes.swarm: set files or grep so the swarm knows what to split"]);
    expect(swarmProblems(baseConfig({ workerTeam: "nope" }))).toContain('unknown team "nope" in the swarm tiers');
    expect(swarmProblems(baseConfig({ files: ["../x"] }))[0]).toContain("repo-relative");
    expect(swarmProblems(baseConfig({ unknownKey: 1 }))[0]).toContain("modes.swarm");
    const config = baseConfig();
    expect(swarmTiers(config, "cheap")).toEqual(["cheap", "strong"]);
    expect(swarmTiers(config, "strong")).toEqual(["strong"]);
    expect(swarmTiers(parseAssentorConfig({ modes: { swarm: {} } }), "x")).toEqual(["x"]);
  });
});

describe("swarm mode", () => {
  it("splits by glob, works in separate worktrees, merges in order, lands once, and reports progress", async () => {
    const s = await setup({});
    const result = await s.run();
    expect(result.status).toBe("completed");
    for (const f of FILES) expect(await read(s.repo, f)).toBe(`new ${f}\n`);
    // Not matched by the glob; the symlink and the other files stay as they were.
    expect(await read(s.repo, "docs/note.md")).toBe("old note\n");
    expect(await fs.readlink(path.join(s.repo, "link.txt"))).toBe("a.txt");
    // One squash commit on the user's branch, not one per item.
    expect((await git(s.repo, "log", "--format=%s")).split("\n")).toEqual([expect.stringContaining("swarm: 5 merged"), "init"]);
    expect(s.prompts.map((p) => p.itemId).sort()).toEqual(["i1", "i2", "i3", "i4", "i5"]);
    // Workers are cut from the base commit in their own worktrees, never in main.
    expect(s.prompts.every((p) => p.cwd !== s.repo && p.cwd.includes(".assentor"))).toBe(true);
    // The worker prompt is the swarm-worker template: goal and owned file, nothing else.
    expect(s.prompts[0]!.prompt).toContain("replace old with new");
    expect(s.prompts[0]!.prompt).toContain("a.txt");
    expect(statusesOf(s, "i1")).toEqual(["queued", "running", "merged"]);
    expect(statusesOf(s, "i5")).toEqual(["queued", "running", "merged"]);
    expect((await s.manager.list(SESSION)).length).toBe(0);
    expect(commandSignals.every(Boolean)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(s.repo, ".assentor/sessions", SESSION, "swarm.json"), "utf8")).applied).toBe(true);
  });

  it("splits by grep, and by directory, files per item", async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, "c.txt"), "keep c\n");
    await fs.writeFile(path.join(repo, "e.txt"), "keep e\n");
    await git(repo, "commit", "-qam", "markers");
    const touch = async (w: Work) => {
      for (const f of ["c.txt", "e.txt"]) await fs.writeFile(path.join(w.cwd, f), `touched ${f}\n`);
      return done();
    };
    const s = await setup({ repo, config: baseConfig({ files: [], grep: "^keep ", filesPerItem: 2 }), work: touch });
    expect((await s.run()).status).toBe("completed");
    // Only the two files that match the regex became one item.
    expect(s.prompts.map((p) => p.itemId)).toEqual(["i1"]);
    expect(s.prompts[0]!.prompt).toContain("c.txt, e.txt");
    expect(await read(repo, "c.txt")).toBe("touched c.txt\n");
    expect(await read(repo, "a.txt")).toBe("old a.txt\n");

    const s2 = await setup({ repo: await makeRepo(), config: baseConfig({ files: ["docs"] }), work: (w) => fs.writeFile(path.join(w.cwd, "docs/note.md"), "new note\n").then(() => done()) });
    expect((await s2.run()).status).toBe("completed");
    expect(await read(s2.repo, "docs/note.md")).toBe("new note\n");
  });

  it("refuses an overlapping split before any worker runs, and nothing lands", async () => {
    const s = await setup({});
    const result = await s.run({}, { split: () => [{ id: "i1", files: ["docs"] }, { id: "i2", files: ["docs/note.md"] }] });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("overlapping paths");
    expect(s.prompts).toHaveLength(0);
    await expectUntouched(s);
  });

  it("blocks when the split is empty or over maxItems, without silently dropping files", async () => {
    const empty = await setup({ config: baseConfig({ files: ["nothing/*.zzz"] }) });
    expect((await empty.run()).reason).toContain("no items");
    const many = await setup({ config: baseConfig({ maxItems: 2 }) });
    const result = await many.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("over modes.swarm.maxItems");
    expect(many.prompts).toHaveLength(0);
  });

  it("an item that touches a file it does not own fails, and the next tier does it with the reason", async () => {
    const s = await setup({
      work: async (w) => {
        if (w.itemId === "i2" && w.tier === 1) {
          await fs.writeFile(path.join(w.cwd, "a.txt"), "sneaky\n");
          return done("done");
        }
        return edit(w);
      },
    });
    const result = await s.run();
    expect(result.status).toBe("completed");
    const retry = s.prompts.find((p) => p.itemId === "i2" && p.tier === 2)!;
    expect(retry.prompt).toContain("<previous-attempt>");
    expect(retry.prompt).toContain("changed files it does not own: a.txt");
    expect(await read(s.repo, "a.txt")).toBe("new a.txt\n");
    expect(statusesOf(s, "i2")).toEqual(["queued", "running", "retry", "running", "merged"]);
    // The failed first try was discarded once the item merged.
    expect((await s.manager.list(SESSION)).length).toBe(0);
  });

  it("an item that fails every tier blocks the swarm: nothing is applied and the work is kept", async () => {
    const s = await setup({ work: (w) => (w.itemId === "i3" ? { status: "failed", summary: "no", error: "crashed" } : edit(w)) });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("1 of 5 item(s) failed on every tier");
    expect(result.reason).toContain("i3 (c.txt)");
    await expectUntouched(s);
    const kept = await s.manager.list(SESSION);
    expect(kept.length).toBeGreaterThanOrEqual(3);
    expect(kept.every((w) => w.outcome === "failed" || w.outcome === "applied")).toBe(true);
    expect(kept.filter((w) => w.outcome === "failed").length).toBeGreaterThanOrEqual(3); // both tries of i3 and the integration worktree
    expect(statusesOf(s, "i3")).toEqual(["queued", "running", "retry", "running", "failed"]);
  });

  it("a worker that reports blocked is a failed item", async () => {
    const s = await setup({ config: baseConfig({}, { modes: { swarm: { workerTeam: "strong", files: ["*.txt"] } } }), work: (w) => (w.itemId === "i1" ? done("x", "### Notes\nblocked: the file is generated") : edit(w)) });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("the worker reported it was blocked");
  });

  it("failing gates on a batch send its items up a tier, with the gate output, and nothing bad lands", async () => {
    const s = await setup({
      work: async (w) => {
        if (w.itemId === "i3" && w.tier === 1) return edit(w, "BAD");
        return edit(w);
      },
    });
    const result = await s.run();
    expect(result.status).toBe("completed");
    // Batch 2 (i3, i4) failed together; both were retried on tier 2.
    expect(s.prompts.filter((p) => p.tier === 2).map((p) => p.itemId)).toEqual(["i3", "i4"]);
    expect(s.prompts.find((p) => p.itemId === "i4" && p.tier === 2)!.prompt).toContain("BAD found in c.txt");
    for (const f of FILES) expect(await read(s.repo, f)).toBe(`new ${f}\n`);
  });

  it("a batch the reviewer sends back is judged item by item: the good one lands, only the bad one goes up a tier", async () => {
    // Batch verdict, then i1 on its own, then i2 on its own.
    const s = await setup({
      review: [{ type: "needs_work", summary: "batch is off" }, { type: "pass" }, { type: "needs_work", summary: "too clever", requiredChanges: ["simplify"] }],
    });
    const result = await s.run();
    expect(result.status).toBe("completed");
    expect(s.prompts.filter((p) => p.tier === 2).map((p) => p.itemId)).toEqual(["i2"]);
    expect(s.prompts.find((p) => p.tier === 2)!.prompt).toContain("too clever");
    expect(statusesOf(s, "i1")).toEqual(["queued", "running", "merged"]);
    for (const f of FILES) expect(await read(s.repo, f)).toBe(`new ${f}\n`);
  });

  it("items that change nothing and say why are unchanged and land nothing; the ids are listed", async () => {
    const s = await setup({ work: () => done("x", "### Notes\nunchanged: already fine") });
    const result = await s.run();
    expect(result.status).toBe("completed");
    expect(result.reason).toContain("no item needed a change");
    expect(result.reason).toContain("i1, i2, i3, i4, i5");
    expect(statusesOf(s, "i1")).toEqual(["queued", "running", "unchanged"]);
    await expectUntouched(s);
  });

  it("an item that changes nothing without saying why is retried on the next tier, then fails", async () => {
    const s = await setup({ work: () => done("looks fine") });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("made no change and gave no reason");
    expect(s.prompts.filter((p) => p.tier === 2)).toHaveLength(5);
    expect(s.prompts.find((p) => p.tier === 2)!.prompt).toContain("gave no reason");
    await expectUntouched(s);
  });

  it("an item whose change is too large to review fails instead of being truncated", async () => {
    const s = await setup({
      config: baseConfig({ files: ["a.txt"] }),
      work: (w) => (w.tier === 1 ? fs.writeFile(path.join(w.cwd, w.file), "x".repeat(41_000)).then(() => done()) : edit(w)),
    });
    expect((await s.run()).status).toBe("completed");
    expect(s.prompts[1]!.prompt).toContain("too large to review");
    expect(await read(s.repo, "a.txt")).toBe("new a.txt\n");
  });

  it("checks that already fail stop the swarm before any worker runs", async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, "e.txt"), "BAD\n");
    await git(repo, "commit", "-qam", "red");
    const s = await setup({ repo });
    const result = await s.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("the checks fail before any change");
    expect(s.prompts).toHaveLength(0);
  });

  it.each([
    ["rewrites an owned file", "a.txt", "tampered\n"],
    ["writes a file nobody owns", "stray.txt", "stray\n"],
  ])("a check that %s fails the batch instead of landing unreviewed changes", async (_name, file, text) => {
    const s = await setup({ config: baseConfig({ files: ["a.txt"] }) });
    let calls = 0;
    const meddling: NonNullable<SwarmExtras["runCommand"]> = async (command, cwd, options) => {
      // Call 1 is the baseline; call 2 is the first batch's gate; later ones are left alone.
      if ((calls += 1) === 2) await fs.writeFile(path.join(cwd, file), text);
      return runCommand(command, cwd, options);
    };
    const result = await s.run({}, { runCommand: meddling });
    expect(result.status).toBe("completed");
    expect(s.prompts.map((p) => p.tier)).toEqual([1, 2]);
    expect(s.prompts[1]!.prompt).toContain("the checks changed files in the batch worktree");
    expect(await read(s.repo, "a.txt")).toBe("new a.txt\n");
    await expect(fs.access(path.join(s.repo, "stray.txt"))).rejects.toBeTruthy();
  });

  it("cancel stops the workers, kills commands, applies nothing and keeps the work", async () => {
    const ac = new AbortController();
    const s = await setup({
      work: async (w) => {
        if (w.itemId === "i3") ac.abort();
        return edit(w);
      },
    });
    const result = await s.run({ signal: ac.signal });
    expect(result).toMatchObject({ status: "blocked", reason: "cancelled" });
    await expectUntouched(s);
    const kept = await s.manager.list(SESSION);
    expect(kept.some((w) => w.outcome === "failed")).toBe(true);
  });

  it("resume after a crash keeps the merged batches and runs only the pending items", async () => {
    const ac = new AbortController();
    const first = await setup({
      work: async (w) => {
        if (w.itemId === "i3") ac.abort();
        return edit(w);
      },
    });
    expect((await first.run({ signal: ac.signal })).reason).toBe("cancelled");
    const state = JSON.parse(await fs.readFile(path.join(first.repo, ".assentor/sessions", SESSION, "swarm.json"), "utf8"));
    expect(state.items.map((i: { status: string }) => i.status)).toEqual(["merged", "merged", "pending", "pending", "pending"]);

    const second = await setup({ repo: first.repo });
    const result = await second.run({ resume: true });
    expect(result.status).toBe("completed");
    expect(second.prompts.map((p) => p.itemId)).toEqual(["i3", "i4", "i5"]);
    for (const f of FILES) expect(await read(first.repo, f)).toBe(`new ${f}\n`);
    // Resuming again finds the work applied.
    expect((await second.run({ resume: true })).reason).toContain("already applied");
  });

  it("resume without saved state fails; a lost integration worktree restarts every item", async () => {
    const none = await setup({});
    await expect(none.run({ resume: true })).rejects.toThrow(/nothing to resume/);

    const ac = new AbortController();
    const first = await setup({
      work: async (w) => {
        if (w.itemId === "i3") ac.abort();
        return edit(w);
      },
    });
    await first.run({ signal: ac.signal });
    await first.manager.discard({ sessionId: SESSION, seatId: "sw-int" }, { force: true });
    const second = await setup({ repo: first.repo });
    expect((await second.run({ resume: true })).status).toBe("completed");
    expect(second.prompts.map((p) => p.itemId)).toEqual(["i1", "i2", "i3", "i4", "i5"]);
    expect(second.events.some((e) => e.type === "session.warning")).toBe(true);
  });

  /** First run cancelled at i3, so i1 and i2 are merged into the integration worktree; returns the base commit. */
  async function cancelledAtThird() {
    const ac = new AbortController();
    const first = await setup({
      work: async (w) => {
        if (w.itemId === "i3") ac.abort();
        return edit(w);
      },
    });
    const base = await git(first.repo, "rev-parse", "HEAD");
    await first.run({ signal: ac.signal });
    const stateFile = path.join(first.repo, ".assentor/sessions", SESSION, "swarm.json");
    return { first, base, stateFile, state: JSON.parse(await fs.readFile(stateFile, "utf8")) };
  }

  it("a hard crash while landing: the items that did land are not redone, and worktree names never repeat", async () => {
    const { first, base, stateFile, state } = await cancelledAtThird();
    // What a crash right after the landing leaves behind: the state from before it, and a stale counter.
    for (const item of state.items.slice(0, 2)) item.status = "pending";
    Object.assign(state, { landing: ["i1", "i2"], integrationHead: base, counter: 0 });
    await fs.writeFile(stateFile, JSON.stringify(state));
    const second = await setup({ repo: first.repo });
    const result = await second.run({ resume: true });
    expect(result.status).toBe("completed");
    expect(second.prompts.map((p) => p.itemId)).toEqual(["i3", "i4", "i5"]);
    for (const f of FILES) expect(await read(first.repo, f)).toBe(`new ${f}\n`);
  });

  it("resume finds the integration worktree already applied to your branch and finishes", async () => {
    const { first, stateFile, state } = await cancelledAtThird();
    await first.manager.applyTo("main", { sessionId: SESSION, seatId: "sw-int" }, { strategy: "squash", allowedPaths: ["a.txt", "b.txt"] });
    expect(state.applied).toBe(false);
    const second = await setup({ repo: first.repo });
    const result = await second.run({ resume: true });
    expect(result.reason).toContain("already applied");
    expect(second.prompts).toHaveLength(0);
    expect(JSON.parse(await fs.readFile(stateFile, "utf8")).applied).toBe(true);
  });

  it("an integration worktree that moved outside the swarm is not applied", async () => {
    const { first, stateFile, state } = await cancelledAtThird();
    state.integrationHead = "0".repeat(40);
    await fs.writeFile(stateFile, JSON.stringify(state));
    const second = await setup({ repo: first.repo });
    const result = await second.run({ resume: true });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("changed outside the swarm");
    expect(await read(first.repo, "a.txt")).toBe("old a.txt\n");
  });

  it("a danger-area change needs approval even under autopilot; a no keeps the work", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, ".github/workflows"), { recursive: true });
    await fs.writeFile(path.join(repo, ".github/workflows/ci.yml"), "on: push\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "ci");
    const danger = { config: baseConfig({ files: [".github/workflows/ci.yml"] }), work: (w: Work) => fs.writeFile(path.join(w.cwd, ".github/workflows/ci.yml"), "on: [push, pull_request]\n").then(() => done()) };
    const denied = await setup({ repo, ...danger });
    const requestApproval = vi.fn(async () => false);
    const result = await denied.run({ requestApproval });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("not approved");
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(await read(repo, ".github/workflows/ci.yml")).toBe("on: push\n");
    expect((await denied.manager.list(SESSION)).some((w) => w.outcome === "failed")).toBe(true);
  });

  it("surfaces the apply warning when a commit hook fails after the work landed", async () => {
    const repo = await makeRepo();
    const s = await setup({ repo, config: baseConfig({ files: ["a.txt"] }) });
    // Hooks are shared by every worktree: install it when the gates run, so only the final commit to main meets it.
    const hook = path.join(repo, ".git/hooks/post-commit");
    let calls = 0;
    const installing: NonNullable<SwarmExtras["runCommand"]> = async (command, cwd, options) => {
      if ((calls += 1) === 2) {
        await fs.mkdir(path.dirname(hook), { recursive: true });
        await fs.writeFile(hook, "#!/bin/sh\nkill -9 $PPID\n", { mode: 0o755 });
      }
      return runCommand(command, cwd, options);
    };
    const result = await s.run({}, { runCommand: installing });
    expect(result.status).toBe("completed");
    expect(result.reason).toContain("warning:");
    expect(await read(repo, "a.txt")).toBe("new a.txt\n");
  });

  it("manual asks before each tier starts; a denial runs nothing", async () => {
    const s = await setup({});
    const requestApproval = vi.fn(async () => false);
    const result = await s.run({ autonomy: "manual", requestApproval });
    expect(result).toMatchObject({ status: "blocked", reason: "tier 1 was not approved" });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ stageId: "swarm-t1" }));
    expect(s.prompts).toHaveLength(0);
  });

  it("through the session: supervised asks before applying, and a denial changes nothing", async () => {
    // The session runs the shell for the gates; this temp repo has no real checks.
    const s = await setup({ config: baseConfig({}, { verification: { enabled: false } }) });
    const events: EngineEventDraft[] = [];
    const prepared = prepareModeSession({
      mode: "swarm",
      sessionId: SESSION,
      goal: "replace old with new",
      autonomy: "supervised",
      config: s.input.config,
      deps: s.input.deps,
      worktrees: s.manager,
      emit: (e) => {
        events.push(e);
        if (e.type === "user.question") prepared.answer(String((e.data as Record<string, unknown>).questionId), "deny");
      },
    });
    const result = await prepared.run();
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("apply was not approved");
    expect(events.filter((e) => e.type === "user.question")).toHaveLength(1);
    await expectUntouched(s);
  });
});
