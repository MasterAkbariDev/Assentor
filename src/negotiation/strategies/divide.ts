import { z } from "zod";
import type { Seat } from "../../core/seats.js";
import { createId } from "../../core/ids.js";
import { createEmptyContract } from "../../core/task-contract.js";
import type { Executor, ExecutorResult } from "../../providers/executors/types.js";
import { worktreeBranch, type SeatKey, type WorktreeManager } from "../../worktrees/manager.js";
import {
  NegotiationCancelledError,
  type NegotiationContext,
  type NegotiationResult,
  type NegotiationStrategy,
} from "../strategy.js";

/**
 * Divide & conquer (T02-08). A planner seat splits the goal into subtasks that
 * own disjoint paths; each subtask runs in its own worktree; the results are
 * merged, in a fixed order, into one integration worktree.
 *
 * Flow and rules (decisions are recorded on the T02-08 card):
 * - Plan: one read-only `divide-plan` ask. The reply is validated with
 *   `SplitPlanSchema`; an empty plan, a bad path, an unknown or cyclic
 *   dependency, or two parts owning overlapping paths rejects the plan before
 *   any worktree exists. The strategy returns a result with `consensus.reached`
 *   false and the reason in `dissent`; it does not throw.
 * - Ownership: `ownedPaths` are plain repo-relative files or directories (no
 *   globs). A directory owns everything under it. Two parts overlap when one
 *   path equals or contains the other (compared case-insensitively). After a
 *   part runs, every file it changed must sit inside its own paths, or the part
 *   fails and is never applied.
 * - Schedule: parts run in waves (a part's wave is one past its latest
 *   dependency). Inside a wave, up to one part per edit seat runs at a time
 *   (seats take parts in plan order). A part's worktree is cut from the
 *   integration branch, so a dependent part sees the work it depends on.
 * - Integration: after each wave, the parts that succeeded are merged into the
 *   integration worktree (`applyTo(..., "merge")`) in plan order. Nothing is
 *   applied to the main checkout; the host decides what happens to the
 *   integration branch. A failed part is never applied. A part that fails ends
 *   the run after its wave (fail fast): the wave's other successes are applied,
 *   later parts are not started.
 * - Conflict: `applyTo` leaves the target clean. The strategy stops, does not
 *   retry or force, keeps every worktree, and emits `seat.status: waiting` for
 *   the integrator seat plus a `session.warning` (`kind: "divide.conflict"`)
 *   that carries the prompt for the user. The integrator seat stays `waiting`.
 * - Cancel: running executors get `cancel(taskId)`; the strategy waits for each
 *   (up to `cancelGraceMs`), gives every started part exactly one terminal seat
 *   event, marks their worktrees failed (so they are kept), and throws
 *   `NegotiationCancelledError`. Nothing is created or merged after the abort.
 * - Nothing is ever discarded or deleted here; `WorktreeManager.cleanup` does that.
 *
 * Parts run through injected `Executor`s, not `ctx.askSeat`, so they bypass the
 * seat scheduler's caps and budgets (the stage graph's Supervisor does too).
 */

// ---------------------------------------------------------------------------
// Split plan
// ---------------------------------------------------------------------------

const PART_ID_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const FORBIDDEN_PATH_CHARS = /[*?[\]{}\\\0]/;
const MAX_PARTS_LIMIT = 16;

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

export const SplitPlanSchema = z
  .object({
    subtasks: z.array(SubtaskSchema).min(1, "the plan is empty: the planner returned no subtasks").max(MAX_PARTS_LIMIT),
  })
  .superRefine((plan, ctx) => {
    const issue = (path: Array<string | number>, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subtasks", ...path], message });
    const parts = plan.subtasks;
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
export type SplitPlan = z.infer<typeof SplitPlanSchema>;

const formatIssues = (error: z.ZodError) =>
  error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");

// ---------------------------------------------------------------------------
// Options and injected capabilities
// ---------------------------------------------------------------------------

const KEY_PREFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const OptionsSchema = z
  .object({
    /** Seat that writes the plan. Default: first seat with role `planner`, else the first seat. */
    planner: z.string().optional(),
    /** Seat shown as `waiting` on a conflict. Default: role `integrator`, else the planner. */
    integrator: z.string().optional(),
    /** Most parts a plan may have. */
    maxParts: z.number().int().min(1).max(MAX_PARTS_LIMIT).default(8),
    /** Worktree seat-id prefix; use a different one for a second divide in the same session. */
    keyPrefix: z.string().max(12).regex(KEY_PREFIX_RE).default("divide"),
  })
  .strict();

export interface DivideDeps {
  /** The worktree manager of the project's main checkout. */
  worktrees: Pick<WorktreeManager, "create" | "diff" | "applyTo" | "markFailed">;
  /** An executor for a part; `run` gets the part's worktree as `projectPath`. One call per part. */
  createExecutor(seat: Seat): Executor;
  /** How long to wait for an executor after `cancel` before giving up on it. Default 5 s. */
  cancelGraceMs?: number;
}

interface Roles {
  planner: Seat;
  integrator: Seat;
  /** Seats that implement parts (permissions `edit`), in team order. */
  workers: Seat[];
}

function resolveRoles(seats: readonly Seat[], options: z.infer<typeof OptionsSchema>): Roles | string {
  const byId = (id: string) => seats.find((seat) => seat.id === id);
  const planner = options.planner !== undefined ? byId(options.planner) : (seats.find((s) => s.role === "planner") ?? seats[0]);
  if (!planner) return options.planner !== undefined ? `planner seat "${options.planner}" is not in the team` : "divide needs a team";
  const integrator =
    options.integrator !== undefined ? byId(options.integrator) : (seats.find((s) => s.role === "integrator") ?? planner);
  if (!integrator) return `integrator seat "${options.integrator}" is not in the team`;
  const workers = seats.filter((seat) => seat.permissions === "edit");
  if (workers.length === 0) return "divide needs at least one seat with edit permissions to implement the parts";
  return { planner, integrator, workers };
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

type PartState = "pending" | "ok" | "failed" | "cancelled";

interface PartRun {
  part: Subtask;
  key: SeatKey;
  state: PartState;
  seat?: Seat;
  reason?: string;
  /** Worktree path once created. */
  path?: string;
  applied?: boolean;
  /** The part produced no change, so nothing was merged. */
  empty?: boolean;
}

const cancelledError = (ctx: NegotiationContext) =>
  ctx.signal.reason instanceof NegotiationCancelledError ? ctx.signal.reason : new NegotiationCancelledError();

function stopIfAborted(ctx: NegotiationContext): void {
  if (ctx.signal.aborted) throw cancelledError(ctx);
}

export function createDivideStrategy(deps: DivideDeps): NegotiationStrategy {
  const strategy: NegotiationStrategy = {
    id: "divide",
    validate(seats, options) {
      const parsed = OptionsSchema.safeParse(options);
      if (!parsed.success) return `invalid divide options: ${formatIssues(parsed.error)}`;
      const roles = resolveRoles(seats, parsed.data);
      return typeof roles === "string" ? roles : undefined;
    },
    async run(ctx) {
      const problem = strategy.validate(ctx.seats, ctx.options);
      if (problem) throw new Error(problem);
      const options = OptionsSchema.parse(ctx.options);
      const roles = resolveRoles(ctx.seats, options) as Roles;
      return runDivide(ctx, deps, options, roles);
    },
  };
  return strategy;
}

async function runDivide(
  ctx: NegotiationContext,
  deps: DivideDeps,
  options: z.infer<typeof OptionsSchema>,
  roles: Roles,
): Promise<NegotiationResult> {
  const dissent: NegotiationResult["dissent"] = [];
  const rejected = (reason: string, seatId?: string): NegotiationResult => {
    dissent.push({ ...(seatId ? { seatId } : {}), reason });
    ctx.emit({ type: "negotiation.consensus", data: { round: 1, score: 0, reached: false } });
    return {
      strategy: "divide",
      decision: "",
      rationale: `no work was started: ${reason}`,
      proposals: [],
      dissent,
      rounds: 1,
      consensus: { score: 0, reached: false },
    };
  };

  // --- 1. plan -------------------------------------------------------------
  stopIfAborted(ctx);
  const reply = await ctx.askSeat(
    roles.planner.id,
    "divide-plan",
    { goal: ctx.goal, maxParts: options.maxParts },
    { readOnly: true },
  );
  if (!reply.ok) return rejected(`the planner gave no plan: ${reply.error}`, roles.planner.id);
  const parsedPlan = SplitPlanSchema.safeParse({ subtasks: reply.data.subtasks });
  if (!parsedPlan.success) return rejected(`the split plan was rejected: ${formatIssues(parsedPlan.error)}`, roles.planner.id);
  const parts = parsedPlan.data.subtasks;
  if (parts.length > options.maxParts) {
    return rejected(`the split plan was rejected: ${parts.length} parts, at most ${options.maxParts} allowed`, roles.planner.id);
  }
  const idOf = new Map(parts.map((part) => [part.id.toLowerCase(), part.id]));
  const normalized = parts.map((part) => ({ ...part, dependsOn: part.dependsOn.map((dep) => idOf.get(dep.toLowerCase())!) }));
  const { waves } = planWaves(normalized);

  const runs = new Map<string, PartRun>(
    normalized.map((part) => [
      part.id,
      { part, state: "pending", key: { sessionId: ctx.sessionId, seatId: `${options.keyPrefix}-p-${part.id.toLowerCase()}` } },
    ]),
  );
  const label = (id: string) => `Part ${id}`;
  normalized.forEach((part) =>
    ctx.emit({
      type: "negotiation.proposal",
      data: { round: 1, label: label(part.id), text: `${part.description}\nOwns: ${part.ownedPaths.join(", ")}` },
    }),
  );

  // --- 2. integration worktree ---------------------------------------------
  stopIfAborted(ctx);
  const integrationKey: SeatKey = { sessionId: ctx.sessionId, seatId: `${options.keyPrefix}-integration` };
  // A failure here (dirty main checkout, name already used) is an environment problem: let it propagate.
  const integration = await deps.worktrees.create(integrationKey);
  const integrationBranch = worktreeBranch(integrationKey);

  // --- 3. waves ------------------------------------------------------------
  const running = new Set<() => void>();
  const onAbort = () => running.forEach((cancel) => cancel());
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const markFailed = (run: PartRun) => deps.worktrees.markFailed(run.key).catch(() => undefined);
  let wavesRun = 0;
  let stoppedReason: string | undefined;
  let conflict: { part: string; files: string[] } | undefined;

  try {
    for (const wave of waves) {
      if (stoppedReason) break;
      stopIfAborted(ctx);
      wavesRun += 1;
      const waveRuns = wave.map((id) => runs.get(id)!);

      for (let i = 0; i < waveRuns.length && !stoppedReason; i += roles.workers.length) {
        stopIfAborted(ctx);
        const chunk = waveRuns.slice(i, i + roles.workers.length);
        await Promise.allSettled(
          chunk.map((run, n) => runPart(ctx, deps, run, roles.workers[n]!, integrationBranch, normalized, running)),
        );
        if (ctx.signal.aborted) {
          await Promise.all(chunk.filter((run) => run.state !== "ok").map(markFailed));
          throw cancelledError(ctx);
        }
        const failed = chunk.filter((run) => run.state === "failed");
        if (failed.length > 0) {
          await Promise.all(failed.map(markFailed));
          stoppedReason = `part ${failed.map((run) => run.part.id).join(", ")} failed`;
        }
      }

      // Integrate this wave's successes in plan order. A failed part is never applied.
      for (const run of waveRuns) {
        if (run.state !== "ok") continue;
        stopIfAborted(ctx);
        try {
          const applied = await deps.worktrees.applyTo(integrationKey, run.key, {
            strategy: "merge",
            message: `divide: ${run.part.id}`,
          });
          if (applied.ok) {
            run.applied = true;
            run.empty = !applied.changed;
            continue;
          }
          conflict = { part: run.part.id, files: applied.conflicts };
          stoppedReason = `merging part ${run.part.id} conflicted`;
        } catch (error) {
          stoppedReason = `merging part ${run.part.id} failed: ${error instanceof Error ? error.message : String(error)}`;
          dissent.push({ label: label(run.part.id), reason: stoppedReason });
        }
        break;
      }
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }

  // --- 4. conflict: hand over to the user ------------------------------------
  if (conflict) {
    const run = runs.get(conflict.part)!;
    const prompt =
      `Part ${conflict.part} conflicts with work already merged (${conflict.files.join(", ") || "files unknown"}). ` +
      `Nothing was changed in the integration worktree (${integration.path}). Resolve it by hand: merge branch ` +
      `${worktreeBranch(run.key)} (worktree ${run.path}) into ${integrationBranch}, or discard the part, then continue.`;
    dissent.push({ label: label(conflict.part), reason: `integration conflict in ${conflict.files.join(", ") || "unknown files"}` });
    ctx.emit({ type: "seat.status", seatId: roles.integrator.id, data: { status: "waiting", detail: prompt } });
    ctx.emit({
      type: "session.warning",
      seatId: roles.integrator.id,
      data: { kind: "divide.conflict", message: prompt, part: conflict.part, files: conflict.files, worktree: run.path, integration: integration.path },
    });
  }

  // --- 5. result -------------------------------------------------------------
  const all = normalized.map((part) => runs.get(part.id)!);
  for (const run of all) {
    if (run.state === "failed") dissent.push({ ...(run.seat ? { seatId: run.seat.id } : {}), label: label(run.part.id), reason: run.reason ?? "failed" });
  }
  const applied = all.filter((run) => run.applied);
  const total = all.length;
  const reached = applied.length === total;
  const line = (title: string, items: string[]) => (items.length ? [`${title}: ${items.join(", ")}`] : []);
  const decision = [
    `Integrated ${applied.length} of ${total} parts into branch ${integrationBranch} (worktree ${integration.path}); the main checkout is untouched.`,
    ...line("Applied, in order", applied.map((run) => run.part.id + (run.empty ? " (no changes)" : ""))),
    ...line("Failed", all.filter((run) => run.state === "failed").map((run) => `${run.part.id} (${run.reason})`)),
    ...line("Done but not applied", all.filter((run) => run.state === "ok" && !run.applied).map((run) => run.part.id)),
    ...line("Not run", all.filter((run) => run.state === "pending").map((run) => run.part.id)),
    ...(stoppedReason ? [`Stopped: ${stoppedReason}.`] : []),
  ].join("\n");
  const rounds = 1 + wavesRun;
  const score = total === 0 ? 0 : applied.length / total;
  ctx.emit({ type: "negotiation.consensus", data: { round: rounds, score, reached } });
  return {
    strategy: "divide",
    decision,
    rationale: `${total} parts in ${waves.length} wave${waves.length === 1 ? "" : "s"} (${waves.map((w) => w.join(" ")).join(" | ")}); ${applied.length} integrated`,
    proposals: all.map((run) => ({
      label: label(run.part.id),
      seatId: run.seat?.id ?? "",
      text: `${run.part.description} [${run.applied ? "applied" : run.state}]`,
    })),
    dissent,
    rounds,
    consensus: { score, reached },
  };
}

/** Run one part in its own worktree. Never throws; the outcome is on `run`. */
async function runPart(
  ctx: NegotiationContext,
  deps: DivideDeps,
  run: PartRun,
  seat: Seat,
  baseRef: string,
  plan: ReadonlyArray<Subtask>,
  running: Set<() => void>,
): Promise<void> {
  run.seat = seat;
  const { part } = run;
  const fail = (reason: string) => {
    run.state = "failed";
    run.reason = reason;
    ctx.emit({ type: "seat.error", seatId: seat.id, data: { message: `${part.id}: ${reason}` } });
  };
  let started = false;
  const cancelled = () => {
    run.state = "cancelled";
    run.reason = "cancelled";
    // Only a part that announced itself needs a terminal event.
    if (started) ctx.emit({ type: "seat.done", seatId: seat.id, data: { ok: false, summary: "cancelled" } });
  };

  if (ctx.signal.aborted) return cancelled();
  started = true;
  ctx.emit({ type: "seat.status", seatId: seat.id, data: { status: "editing", detail: part.id } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const info = await deps.worktrees.create(run.key, baseRef);
    run.path = info.path;
    if (ctx.signal.aborted) return cancelled();

    const executor = deps.createExecutor(seat);
    const taskId = createId();
    const others = plan.filter((other) => other.id !== part.id);
    const task = {
      taskId,
      projectPath: info.path,
      contract: {
        ...createEmptyContract(part.description),
        constraints: [
          `Create or edit only these paths (a directory covers everything under it): ${part.ownedPaths.join(", ")}`,
          ...(others.length ? [`Other parts own these paths; do not touch them: ${others.flatMap((o) => o.ownedPaths).join(", ")}`] : []),
        ],
      },
      prompt: [
        `You are implementing part ${part.id} of a larger task, in your own git worktree.`,
        `Overall goal: ${ctx.goal}`,
        `Your part: ${part.description}`,
        `Create or edit only these paths (a directory covers everything under it): ${part.ownedPaths.join(", ")}`,
        ...(others.length ? [`Other parts are being built in parallel and own: ${others.flatMap((o) => o.ownedPaths).join(", ")}. Do not touch those paths.`] : []),
        ...(part.dependsOn.length ? [`The work of ${part.dependsOn.join(", ")} is already in your worktree.`] : []),
        "Leave your changes in the working tree; the integrator merges them.",
      ].join("\n"),
    };

    const graceExpired = new Promise<"grace">((resolve) => {
      cancel = () => {
        void Promise.resolve()
          .then(() => executor.cancel(taskId))
          .catch(() => undefined);
        timer = setTimeout(() => resolve("grace"), deps.cancelGraceMs ?? 5_000);
      };
    });
    running.add(cancel!);
    if (ctx.signal.aborted) cancel!();

    const execution = (async () => executor.run(task))();
    execution.catch(() => undefined); // an abandoned run must not become an unhandled rejection
    let result: ExecutorResult | "grace";
    try {
      result = await Promise.race([execution, graceExpired]);
    } catch (error) {
      if (ctx.signal.aborted) return cancelled();
      return fail(`executor error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (ctx.signal.aborted || result === "grace") return cancelled();
    if (result.status !== "completed") {
      return fail(`executor ${result.status}${result.error || result.summary ? `: ${result.error ?? result.summary}` : ""}`);
    }

    const changes = await deps.worktrees.diff(run.key);
    const outside = changes.files.filter((file) => !isOwned(file, part.ownedPaths));
    if (outside.length > 0) {
      return fail(`changed files outside its ownedPaths: ${outside.slice(0, 10).join(", ")}`);
    }
    run.state = "ok";
    ctx.emit({ type: "seat.done", seatId: seat.id, data: { ok: true, summary: part.id } });
  } catch (error) {
    if (ctx.signal.aborted) return cancelled();
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (cancel) running.delete(cancel);
    if (timer) clearTimeout(timer);
  }
}
