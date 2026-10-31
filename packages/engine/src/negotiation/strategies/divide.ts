import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createEmptyContract } from "../../core/task-contract.js";
import type { Seat } from "#assentor/protocol/seats.js";
import type { EngineEventDraft } from "#assentor/protocol/events.js";
import type { Executor, ExecutorCapabilities, ExecutorResult, ExecutorTask } from "../../providers/executors/types.js";
import type { SeatScheduler } from "../../seats/scheduler.js";
import { worktreeBranch, type ApplyStrategy, type SeatKey, type WorktreeManager } from "../../worktrees/index.js";
import { runNegotiation, type SeatStepRunner } from "../engine.js";
import { NegotiationCancelledError, type NegotiationStrategy } from "../strategy.js";

/**
 * Divide & conquer (T02-08), as an `Executor` like best-of-n: the host's
 * `createExecutor(stage)` returns `createDivideExecutor(...)` for an execute
 * stage whose `strategy` is `"divide"`, and the Supervisor drives it (run →
 * verification → review → continue). It is not in the negotiation registry: it
 * needs executors and worktrees, which `NegotiationContext` does not offer.
 *
 * One `run`/`continue` is one round, from the target's tip:
 * 1. Plan: a one-step negotiation (`runNegotiation`, so the ask goes through the
 *    scheduler and is persisted) asks the planner seat for `divide-plan`. The
 *    reply is validated with `SplitPlanSchema`; an empty plan, a bad path, an
 *    unknown or cyclic dependency, or two parts owning overlapping paths fails
 *    the round before any worktree exists.
 * 2. An integration worktree and, per part, a worktree cut from the integration
 *    branch (so a dependent part sees the merged work it depends on). Worktree
 *    seat ids are `<round tag>-int` / `<round tag>-p-<part>`, new every round,
 *    so a retry or `continue` never collides with an earlier round.
 * 3. Parts run in dependency waves. Every part runs through `scheduler.run`
 *    (provider caps, budgets, `partTimeoutMs`, one attempt), at most one part
 *    per worker seat at a time.
 * 4. After a part completes, every file it changed (renames at both ends) must
 *    be inside its `ownedPaths`, and any symlink it added must stay inside the
 *    worktree, or the part fails. `applyTo(..., { allowedPaths })` repeats the
 *    ownership check on the exact tip it merges, so a write made after the
 *    check is refused too.
 * 5. After each wave its parts are merged into the integration worktree in plan
 *    order. A failed part is never applied and ends the round after its wave.
 * 6. Only when every part is merged is the integration branch applied to the
 *    target (`"main"` or a task worktree seat), all or nothing. A partial
 *    integration never counts as success and never reaches the target.
 *
 * Results: `completed` only when everything landed. A merge conflict (inside the
 * integration worktree or at the target) is `failed` with the instructions in
 * `summary`/`error` plus a `session.warning` (`kind: "divide.conflict"`), like
 * best-of-n: the Supervisor only stops on failed/timeout/cancelled and would
 * otherwise review an unchanged target. Nothing is forced and every worktree is
 * kept. A failed or seat-cancelled part, a rejected plan, a refusal or an
 * exhausted session budget is `failed`; a cancel of the round is `cancelled`.
 * Before the final apply the integration worktree's symlinks are checked once
 * more (nothing writes there, so a late write in a part cannot race it).
 *
 * Cancel: `cancel(taskId)` aborts the round; scheduler jobs stop and their
 * executors are cancelled, and `cancel` resolves when the round has settled.
 * Every part that started gets exactly one terminal seat event. The plan ask
 * runs with the round's signal, so (as in best-of-n) cancelling a round also
 * calls `scheduler.cancelAll`.
 *
 * Nothing is ever deleted here. Failed or unfinished worktrees are marked
 * failed (kept); applied ones are left to `WorktreeManager.cleanup`.
 */

// ---------------------------------------------------------------------------
// Split plan
// ---------------------------------------------------------------------------

const PART_ID_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const FORBIDDEN_PATH_CHARS = /[*?[\]{}\\\0]/;
const MAX_PARTS_LIMIT = 16;
/** Root files that change how git treats every other path; a plan must opt in to own them. */
const ROOT_GIT_FILES = new Set([".gitattributes", ".gitmodules", ".gitignore"]);
/** Normalize a repo-relative path: no `./`, no empty segments, no trailing slash. */
export const DividePathSchema = z.string().transform((raw, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${message}: ${JSON.stringify(raw)}` });
    return z.NEVER;
  };
  const text = raw.trim();
  if (text === "") return fail("empty path");
  if (FORBIDDEN_PATH_CHARS.test(text)) return fail("globs, backslashes and control characters are not allowed in ownedPaths");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) return fail("ownedPaths must be repo-relative");
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return fail("a path must name a file or directory, not the repository root");
  if (segments.includes("..")) return fail("'..' is not allowed in ownedPaths");
  const first = segments[0]!.toLowerCase();
  if (first === ".git" || first === ".assentor") return fail(`${first} cannot be owned`);
  return segments.join("/");
});

export const SubtaskSchema = z.object({
  id: z.string().max(24).regex(PART_ID_RE, "id must be letters, digits and dashes"),
  description: z.string().trim().min(1).max(8000),
  ownedPaths: z.array(DividePathSchema).min(1, "a subtask must own at least one path").max(50),
  dependsOn: z.array(z.string()).max(MAX_PARTS_LIMIT).default([]),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

const segmentsOf = (p: string) => p.toLowerCase().split("/");

/** True when `a` equals `b` or one contains the other (segment-wise, case-insensitive). */
export function pathsOverlap(a: string, b: string): boolean {
  const sa = segmentsOf(a);
  const sb = segmentsOf(b);
  const n = Math.min(sa.length, sb.length);
  return sa.slice(0, n).every((segment, i) => segment === sb[i]);
}

/** True when `file` is one of `owned` or inside one of its directories (exact case). */
export function isOwned(file: string, owned: readonly string[]): boolean {
  return owned.some((p) => file === p || file.startsWith(`${p}/`));
}

/**
 * Dependency waves: wave 1 has no dependencies, wave n needs only earlier
 * waves; plan order inside a wave. Parts left over form a cycle.
 */
export function planWaves(parts: ReadonlyArray<Pick<Subtask, "id" | "dependsOn">>): {
  waves: string[][];
  cyclic: string[];
} {
  const done = new Set<string>();
  const waves: string[][] = [];
  let rest = [...parts];
  while (rest.length > 0) {
    const ready = rest.filter((part) => part.dependsOn.every((dep) => done.has(dep)));
    if (ready.length === 0) break;
    waves.push(ready.map((part) => part.id));
    ready.forEach((part) => done.add(part.id));
    rest = rest.filter((part) => !done.has(part.id));
  }
  return { waves, cyclic: rest.map((part) => part.id) };
}

export function buildSplitPlanSchema(options: { allowRootGitFiles?: boolean } = {}) {
  return z
  .object({
    subtasks: z.array(SubtaskSchema).min(1, "the plan is empty: the planner returned no subtasks").max(MAX_PARTS_LIMIT),
  })
  .superRefine((plan, ctx) => {
    const issue = (path: Array<string | number>, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subtasks", ...path], message });
    const parts = plan.subtasks;
    // A path that failed normalization is already reported; the checks below need valid ones.
    if (parts.some((part) => part.ownedPaths.some((p) => typeof p !== "string"))) return;
    const byId = new Map<string, number>();
    parts.forEach((part, index) => {
      const key = part.id.toLowerCase();
      if (byId.has(key)) issue([index, "id"], `duplicate id "${part.id}"`);
      else byId.set(key, index);
    });
    let depsOk = true;
    parts.forEach((part, index) => {
      part.dependsOn.forEach((dep) => {
        if (!byId.has(dep.toLowerCase())) {
          depsOk = false;
          issue([index, "dependsOn"], `"${part.id}" depends on unknown part "${dep}"`);
        } else if (dep.toLowerCase() === part.id.toLowerCase()) {
          depsOk = false;
          issue([index, "dependsOn"], `"${part.id}" depends on itself`);
        }
      });
    });
    if (depsOk) {
      // Dependencies are matched exactly in scheduling, so normalize their case first.
      const canonical = parts.map((part) => ({
        id: part.id,
        dependsOn: part.dependsOn.map((dep) => parts[byId.get(dep.toLowerCase())!]!.id),
      }));
      const { cyclic } = planWaves(canonical);
      if (cyclic.length > 0) issue([], `dependency cycle among ${cyclic.join(", ")}`);
    }
    if (!options.allowRootGitFiles) {
      parts.forEach((part, index) => {
        for (const p of part.ownedPaths) {
          if (ROOT_GIT_FILES.has(p.toLowerCase())) {
            issue([index, "ownedPaths"], `"${part.id}" owns ${p}, which changes how git treats every other path; allow it with the allowRootGitFiles option`);
          }
        }
      });
    }
    for (let i = 0; i < parts.length; i += 1) {
      for (let j = i + 1; j < parts.length; j += 1) {
        for (const a of parts[i]!.ownedPaths) {
          for (const b of parts[j]!.ownedPaths) {
            if (pathsOverlap(a, b)) {
              issue([j, "ownedPaths"], `"${parts[j]!.id}" and "${parts[i]!.id}" own overlapping paths ("${b}" and "${a}")`);
            }
          }
        }
      }
    }
  });
}

export const SplitPlanSchema = buildSplitPlanSchema();
export type SplitPlan = z.infer<typeof SplitPlanSchema>;

const formatIssues = (error: z.ZodError) =>
  error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");


// ---------------------------------------------------------------------------
// Options and dependencies
// ---------------------------------------------------------------------------

export const DIVIDE_STRATEGY_ID = "divide";

const OptionsSchema = z
  .object({
    /** Seat that writes the plan. Default: first seat with role `planner`, else the first seat of the team. */
    planner: z.string().optional(),
    /** Most parts a plan may have. */
    maxParts: z.number().int().min(1).max(MAX_PARTS_LIMIT).default(8),
    /** How the integrated work lands in the target. Default `squash`. */
    apply: z.enum(["merge", "squash", "patch"]).default("squash"),
    /** Per-part deadline for the executor run. */
    partTimeoutMs: z.number().positive().finite().optional(),
    /** Let parts own root `.gitattributes`, `.gitmodules` and `.gitignore`. Default false. */
    allowRootGitFiles: z.boolean().default(false),
  })
  .strict();
export type DivideOptions = z.infer<typeof OptionsSchema>;

/** Validate a stage's `options`. Returns the parsed options or an error message. */
export function parseDivideOptions(
  options: Readonly<Record<string, unknown>>,
  team?: readonly Seat[],
  workerCount?: number,
): DivideOptions | string {
  const parsed = OptionsSchema.safeParse(options);
  if (!parsed.success) return `divide: invalid options: ${formatIssues(parsed.error)}`;
  if (team && parsed.data.planner !== undefined && !team.some((seat) => seat.id === parsed.data.planner)) {
    return `divide: planner seat "${parsed.data.planner}" is not in the team`;
  }
  if (workerCount !== undefined && workerCount < 1) return "divide needs at least one editing seat to implement the parts";
  return parsed.data;
}

export interface DivideWorker {
  /** An editing seat. */
  seat: Seat;
  /** The adapter that runs this seat; it is started with the part's worktree as its project path. */
  executor: Executor;
}

export interface DivideDeps {
  manager: WorktreeManager;
  /** Worktree session id (a UUID, like the session's id). */
  sessionId: string;
  /** Project root; the plan negotiation is persisted under it when given. */
  projectPath?: string;
  scheduler: SeatScheduler;
  /** Model call for the planner's `divide-plan` step (the engine's `SeatStepRunner`). */
  runStep: SeatStepRunner;
  /** Seats that implement parts, one at a time each. */
  workers: readonly DivideWorker[];
  /** Seats the planner is chosen from. Default: the workers' seats. */
  team?: readonly Seat[];
  /** The stage's `options` (see `parseDivideOptions`). */
  options?: Readonly<Record<string, unknown>>;
  /** Where the integrated work lands: `"main"` (default) or the task's own worktree seat, whose branch is also the base. */
  target?: "main" | SeatKey;
  /** Plan negotiation run ids are `<prefix>-<round tag>`; give each stage its own (≤ 40 chars). Default `divide`. */
  runIdPrefix?: string;
  askTimeoutMs?: number;
  /** Seat and negotiation events; must not throw. */
  emit?: (draft: EngineEventDraft) => void;
}

interface PlanOutcome {
  plan?: SplitPlan;
  rejected?: string;
}

/**
 * The one-step negotiation that asks the planner for a split plan. A plan the
 * schema rejects is reported in `out.rejected`, never thrown. Exported so the
 * prompt tests can drive the `divide-plan` ask.
 */
export function createPlanStrategy(
  planner: Seat,
  options: { maxParts: number; allowRootGitFiles?: boolean },
  out: PlanOutcome,
): NegotiationStrategy {
  const schema = buildSplitPlanSchema({ allowRootGitFiles: options.allowRootGitFiles ?? false });
  return {
    id: DIVIDE_STRATEGY_ID,
    validate: () => undefined,
    async run(ctx) {
      const reply = await ctx.askSeat(planner.id, "divide-plan", { goal: ctx.goal, maxParts: options.maxParts }, { readOnly: true });
      let reason: string | undefined;
      if (!reply.ok) {
        reason = `the planner gave no plan: ${reply.error}`;
      } else {
        const parsed = schema.safeParse({ subtasks: reply.data.subtasks });
        if (!parsed.success) reason = `the split plan was rejected: ${formatIssues(parsed.error)}`;
        else if (parsed.data.subtasks.length > options.maxParts) {
          reason = `the split plan was rejected: ${parsed.data.subtasks.length} parts, at most ${options.maxParts} allowed`;
        } else out.plan = parsed.data;
      }
      if (reason) out.rejected = reason;
      const parts = out.plan?.subtasks ?? [];
      return {
        strategy: DIVIDE_STRATEGY_ID,
        decision: parts.map((p) => `${p.id}: ${p.description} [owns ${p.ownedPaths.join(", ")}]`).join("\n"),
        rationale: reason ?? `${parts.length} parts`,
        proposals: parts.map((p) => ({ label: `Part ${p.id}`, seatId: planner.id, text: p.description })),
        dissent: reason ? [{ seatId: planner.id, reason }] : [],
        rounds: 1,
        consensus: { score: reason ? 0 : 1, reached: !reason },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type PartState = "pending" | "ok" | "failed" | "cancelled";

interface PartRun {
  part: Subtask;
  key: SeatKey;
  state: PartState;
  worker?: DivideWorker;
  reason?: string;
  path?: string;
  applied?: boolean;
}

/** Symlinks among `files` whose target resolves outside the worktree or into its `.git` / `.assentor`. */
export async function escapingSymlinks(root: string, files: readonly string[]): Promise<string[]> {
  const realRoot = await fs.realpath(root);
  const bad: string[] = [];
  for (const file of files) {
    const abs = path.join(root, file);
    let link: string;
    try {
      if (!(await fs.lstat(abs)).isSymbolicLink()) continue;
      link = await fs.readlink(abs);
    } catch {
      continue; // deleted or unreadable: nothing to follow
    }
    const resolved = path.resolve(await fs.realpath(path.dirname(abs)), link);
    const rel = path.relative(realRoot, resolved);
    const top = rel.split(path.sep)[0]!.toLowerCase();
    // Out of the worktree, or into git's or Assentor's own state inside it (e.g. `../.git/hooks`).
    if (rel.startsWith("..") || path.isAbsolute(rel) || top === ".git" || top === ".assentor") bad.push(`${file} -> ${link}`);
  }
  return bad;
}

export function createDivideExecutor(deps: DivideDeps): Executor {
  const team = deps.team ?? deps.workers.map((w) => w.seat);
  const parsed = parseDivideOptions(deps.options ?? {}, team, deps.workers.length);
  if (typeof parsed === "string") throw new Error(parsed);
  const options = parsed;
  const planner =
    (options.planner !== undefined ? team.find((s) => s.id === options.planner) : team.find((s) => s.role === "planner") ?? team[0]) ??
    deps.workers[0]!.seat;
  const target = deps.target ?? "main";
  const baseRef = target === "main" ? "HEAD" : worktreeBranch(target);
  const prefix = deps.runIdPrefix ?? DIVIDE_STRATEGY_ID;
  const active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
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

  async function execute(taskId: string, task: Omit<ExecutorTask, "taskId" | "projectPath">): Promise<ExecutorResult> {
    round += 1;
    const tag = `r${round}${randomBytes(4).toString("hex")}`;
    const controller = new AbortController();
    const goal = String(task.contract.goal);
    const runs: PartRun[] = [];
    const integrationKey: SeatKey = { sessionId: deps.sessionId, seatId: `${tag}-int` };
    let integrationCreated = false;
    let budgetStop: string | undefined;

    const fail = (summary: string, error?: string): ExecutorResult => ({ status: "failed", summary, ...(error ? { error } : {}) });
    const cancelled = (): ExecutorResult => ({ status: "cancelled", summary: "divide cancelled" });
    /** Keep everything for inspection: nothing reached the target, so no worktree is disposable. */
    const keepAll = async () => {
      const mark = (key: SeatKey) => deps.manager.markFailed(key).catch(() => undefined);
      if (integrationCreated) await mark(integrationKey);
      await Promise.all(runs.filter((r) => r.path && !r.applied).map((r) => mark(r.key)));
    };
    const finish = async (result: ExecutorResult): Promise<ExecutorResult> => {
      if (result.status !== "completed") await keepAll();
      return result;
    };
    const report = () =>
      runs
        .map((r) => `${r.part.id}: ${r.applied ? "merged" : r.state === "failed" ? `failed (${r.reason})` : r.state === "ok" ? "done, not merged" : r.state === "cancelled" ? "cancelled" : "not run"}`)
        .join("; ");

    const done = (async (): Promise<ExecutorResult> => {
      // --- 1. plan ---------------------------------------------------------
      const out: PlanOutcome = {};
      try {
        await runNegotiation({
          sessionId: deps.sessionId,
          ...(deps.projectPath ? { projectPath: deps.projectPath } : {}),
          runId: `${prefix}-${tag}`,
          strategy: createPlanStrategy(planner, options, out),
          goal,
          seats: [planner],
          scheduler: deps.scheduler,
          runStep: deps.runStep,
          signal: controller.signal,
          emit,
          ...(deps.askTimeoutMs ? { askTimeoutMs: deps.askTimeoutMs } : {}),
        });
      } catch (error) {
        if (error instanceof NegotiationCancelledError && error.reason === "cancelled") return cancelled();
        return fail(`divide: planning failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!out.plan) return fail(`divide: ${out.rejected ?? "no plan"}`);

      const idOf = new Map(out.plan.subtasks.map((p) => [p.id.toLowerCase(), p.id]));
      const parts: Subtask[] = out.plan.subtasks.map((p) => ({ ...p, dependsOn: p.dependsOn.map((d) => idOf.get(d.toLowerCase())!) }));
      const { waves } = planWaves(parts);
      for (const part of parts) {
        runs.push({ part, state: "pending", key: { sessionId: deps.sessionId, seatId: `${tag}-p-${part.id.toLowerCase()}` } });
        emit({
          type: "negotiation.proposal",
          sessionId: deps.sessionId,
          data: { round: 1, label: `Part ${part.id}`, text: `${part.description}\nOwns: ${part.ownedPaths.join(", ")}` },
        });
      }
      const byId = new Map(runs.map((r) => [r.part.id, r]));

      // --- 2. integration worktree ----------------------------------------
      if (controller.signal.aborted) return cancelled();
      let integrationPath: string;
      try {
        integrationPath = (await deps.manager.create(integrationKey, baseRef)).path;
        integrationCreated = true;
      } catch (error) {
        return fail(`divide: could not create the integration worktree: ${error instanceof Error ? error.message : String(error)}`);
      }
      const integrationBranch = worktreeBranch(integrationKey);

      // --- 3. waves ---------------------------------------------------------
      const runPart = async (run: PartRun, worker: DivideWorker): Promise<void> => {
        const { part } = run;
        const seatId = worker.seat.id;
        run.worker = worker;
        let started = false;
        const failPart = (reason: string) => {
          run.state = "failed";
          run.reason = reason;
          seatEvent(seatId, "seat.error", { message: `${part.id}: ${reason}` });
        };
        const cancelPart = () => {
          run.state = "cancelled";
          run.reason = "cancelled";
          if (started) seatEvent(seatId, "seat.done", { ok: false, summary: "cancelled" });
        };
        if (controller.signal.aborted) return cancelPart();
        started = true;
        seatEvent(seatId, "seat.status", { status: "editing", detail: part.id });
        try {
          run.path = (await deps.manager.create(run.key, integrationBranch)).path;
          if (controller.signal.aborted) return cancelPart();
          const others = parts.filter((o) => o.id !== part.id);
          const partTaskId = `${taskId}.${tag}.${part.id}`;
          const mine = `Create or edit only these paths (a directory covers everything under it): ${part.ownedPaths.join(", ")}`;
          const theirs = others.length ? `Other parts are built in parallel and own: ${others.flatMap((o) => o.ownedPaths).join(", ")}. Do not touch those paths.` : undefined;
          const partTask: ExecutorTask = {
            taskId: partTaskId,
            projectPath: run.path,
            contract: { ...createEmptyContract(part.description), constraints: [mine, ...(theirs ? [theirs] : [])] },
            prompt: [
              `You are implementing part ${part.id} of a larger task, in your own git worktree.`,
              `Overall goal: ${goal}`,
              `Your part: ${part.description}`,
              mine,
              ...(theirs ? [theirs] : []),
              ...(part.dependsOn.length ? [`The work of ${part.dependsOn.join(", ")} is already in your worktree.`] : []),
              "Leave your changes in the working tree; they are merged afterwards.",
            ].join("\n"),
          };
          const outcome = await deps.scheduler.run(
            worker.seat,
            async (job) => {
              const stop = () =>
                void Promise.resolve()
                  .then(() => worker.executor.cancel(partTaskId))
                  .catch(() => undefined);
              if (job.signal.aborted) stop();
              else job.signal.addEventListener("abort", stop, { once: true });
              try {
                return await worker.executor.run(partTask);
              } finally {
                job.signal.removeEventListener("abort", stop);
              }
            },
            {
              signal: controller.signal,
              maxAttempts: 1, // a retry would rerun the executor on a half-edited worktree
              ...(options.partTimeoutMs ? { timeoutMs: options.partTimeoutMs } : {}),
            },
          );
          if (!outcome.ok) {
            if (outcome.scope === "session") {
              if (outcome.reason === "budget") budgetStop ??= outcome.error;
              controller.abort(); // cancel or session budget: stop the other parts too
            }
            if (outcome.reason === "cancelled" || controller.signal.aborted) return cancelPart();
            // Worded to stay out of `isRetryableExecutorResult`: a retry would rerun the whole round.
            return failPart(outcome.reason === "timeout" ? `part deadline of ${options.partTimeoutMs} ms exceeded` : `${outcome.reason}: ${outcome.error}`);
          }
          if (controller.signal.aborted) return cancelPart();
          const result = outcome.value;
          if (result.status !== "completed") {
            return failPart(`executor ${result.status}${result.error || result.summary ? `: ${result.error ?? result.summary}` : ""}`);
          }
          const changes = await deps.manager.diff(run.key);
          const outside = changes.files.filter((file) => !isOwned(file, part.ownedPaths));
          if (outside.length > 0) return failPart(`changed files outside its ownedPaths: ${outside.slice(0, 10).join(", ")}`);
          const links = await escapingSymlinks(run.path, changes.files);
          if (links.length > 0) return failPart(`added symlinks that leave the worktree: ${links.slice(0, 5).join(", ")}`);
          run.state = "ok";
          seatEvent(seatId, "seat.done", { ok: true, summary: part.id });
        } catch (error) {
          if (controller.signal.aborted) return cancelPart();
          failPart(error instanceof Error ? error.message : String(error));
        }
      };

      for (const wave of waves) {
        if (controller.signal.aborted) return finish(cancelled());
        const waveRuns = wave.map((id) => byId.get(id)!);
        // Each worker seat takes the next waiting part until the wave is empty (or a part has failed).
        const queue = [...waveRuns];
        let stopped = false;
        await Promise.all(
          deps.workers.map(async (worker) => {
            while (!stopped) {
              const next = queue.shift();
              if (!next) return;
              await runPart(next, worker);
              if (next.state !== "ok") stopped = true;
            }
          }),
        );
        if (budgetStop) return finish(fail(`divide: the session budget ran out (${budgetStop}); nothing was applied to the target. ${report()}`));
        if (controller.signal.aborted) return finish(cancelled());
        // A part that is not `ok` (failed, or cancelled on its own seat) must never be merged.
        const notOk = waveRuns.filter((r) => r.state !== "ok" && r.state !== "pending");
        if (notOk.length > 0) {
          return finish(
            fail(
              `divide: part ${notOk.map((r) => r.part.id).join(", ")} did not complete; nothing was applied to the target. ${report()}`,
              notOk.map((r) => `${r.part.id}: ${r.reason}`).join("; "),
            ),
          );
        }

        // --- 4. merge this wave into the integration worktree, in plan order ---
        for (const run of waveRuns) {
          if (controller.signal.aborted) return finish(cancelled());
          if (run.state !== "ok") continue;
          try {
            const applied = await deps.manager.applyTo(integrationKey, run.key, {
              strategy: "merge",
              message: `divide: ${run.part.id}`,
              allowedPaths: run.part.ownedPaths,
            });
            if (applied.ok) {
              run.applied = true;
              continue;
            }
            const prompt =
              `Part ${run.part.id} conflicts with work already merged (${applied.conflicts.join(", ") || "files unknown"}). ` +
              `Nothing was changed in the integration worktree (${integrationPath}) and nothing reached the target. ` +
              `Resolve it by hand: merge branch ${worktreeBranch(run.key)} (worktree ${run.path}) into ${integrationBranch}, or discard the part, then run the stage again.`;
            emit({
              type: "session.warning",
              sessionId: deps.sessionId,
              data: { kind: "divide.conflict", message: prompt, part: run.part.id, files: applied.conflicts, worktree: run.path, integration: integrationPath },
            });
            // `failed`, not `needs_input`: the Supervisor would run reviews on an unchanged target and call continue() again.
            return finish(fail(`divide: ${prompt} ${report()}`, prompt));
          } catch (error) {
            run.state = "failed";
            run.reason = `merge refused: ${error instanceof Error ? error.message : String(error)}`;
            return finish(fail(`divide: part ${run.part.id} could not be merged; nothing was applied to the target. ${report()}`, run.reason));
          }
        }

        // Nothing writes to the integration worktree, so this check cannot race a late write in a part's worktree.
        const links = await escapingSymlinks(integrationPath, (await deps.manager.diff(integrationKey)).files);
        if (links.length > 0) {
          return finish(fail(`divide: merged work contains symlinks that leave the worktree or point into .git; nothing was applied to the target. ${report()}`, links.slice(0, 5).join(", ")));
        }
      }

      // --- 5. integration branch → target, all or nothing ---------------------
      if (controller.signal.aborted) return finish(cancelled());
      try {
        const landed = await deps.manager.applyTo(target, integrationKey, {
          strategy: options.apply as ApplyStrategy,
          message: `divide: ${goal.split("\n")[0]!.slice(0, 60)}`,
          allowedPaths: parts.flatMap((p) => p.ownedPaths),
        });
        if (!landed.ok) {
          const prompt =
            `The integrated work conflicts with the target (${landed.conflicts.join(", ") || "files unknown"}); the target is unchanged. ` +
            `Merge branch ${integrationBranch} (worktree ${integrationPath}) by hand, then run the stage again.`;
          emit({
            type: "session.warning",
            sessionId: deps.sessionId,
            data: { kind: "divide.conflict", message: prompt, files: landed.conflicts, integration: integrationPath },
          });
          return finish(fail(`divide: ${prompt}`, prompt));
        }
        return {
          status: "completed",
          summary: `divide: ${parts.length} parts in ${waves.length} wave${waves.length === 1 ? "" : "s"} (${waves.map((w) => w.join(" ")).join(" | ")}) merged and applied by ${options.apply}.\n${report()}${landed.warning ? `\nwarning: ${landed.warning}` : ""}`,
        };
      } catch (error) {
        return finish(fail(`divide: applying the integrated work was refused; nothing reached the target. ${report()}`, error instanceof Error ? error.message : String(error)));
      }
    })().catch((error): Promise<ExecutorResult> => finish(fail(`divide: ${error instanceof Error ? error.message : String(error)}`)));

    active.set(taskId, { controller, done });
    try {
      return await done;
    } finally {
      active.delete(taskId);
    }
  }

  return {
    name: DIVIDE_STRATEGY_ID,
    capabilities: (): ExecutorCapabilities => ({
      canEditFiles: true,
      canRunCommands: true,
      canContinueSession: false,
      supportsScreenshots: false,
    }),
    run: (task) => execute(task.taskId, { contract: task.contract, prompt: task.prompt, ...(task.messages ? { messages: task.messages } : {}) }),
    // Every round plans afresh from the target's tip (which already holds earlier rounds), with the feedback in the goal.
    continue: (input) =>
      execute(input.taskId, {
        contract: input.nextPhaseDirective
          ? { ...input.contract, goal: `${input.contract.goal}\n\nFollow-up instructions:\n${input.nextPhaseDirective}` }
          : input.contract,
        prompt: input.nextPhaseDirective ?? input.contract.goal,
        messages: input.messages,
      }),
    async cancel(taskId) {
      const run = active.get(taskId);
      if (run) {
        run.controller.abort();
        await run.done.catch(() => undefined);
      }
    },
  };
}
