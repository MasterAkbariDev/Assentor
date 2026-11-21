import { promises as fs } from "node:fs";
import { EventLog, EventLogLockedError, RunLockedError, acquireRunLock, isSessionLogLocked, type RunLock } from "../events/log.js";
import { sessionPaths } from "../persistence/paths.js";
import { createId, isId } from "../core/ids.js";
import type { ModeDefinition } from "../modes/registry.js";
import { ModeValidationError, prepareModeSession, type ModeSessionInput, type PreparedModeSession } from "../modes/session.js";
import type { ControllerCommand } from "../modes/registry.js";
import { WorktreeError, WorktreeManager } from "../worktrees/manager.js";
import type { Autonomy } from "../core/run-mode.js";
import { AUTONOMY_LEVELS, safeParseEngineEvent, type EngineEventDraft } from "#assentor/protocol/events.js";
import { RpcErrorCode, type RpcResult, type SessionSummary } from "#assentor/protocol/rpc.js";
import { RpcError, scrubPaths, type RpcServer } from "./server.js";

/**
 * Write-side handlers: `session.*`, `seat.*`, `worktree.*` (T04-05).
 *
 * - Sessions are started through `prepareModeSession` (never a second launcher). The
 *   host (the CLI/serve process) supplies the deps, config and worktrees through
 *   `SessionHost`; this module owns only the lifecycle, the event log and the abort signal.
 * - Worktrees are addressed by (sessionId, seatId) and found in the manager's manifest;
 *   a client never supplies a path. `apply`/`discard` need `confirm: true` (a contract literal).
 * - `seat.stop`/`setModel` (FU-12) reach the session's live executors through
 *   `PreparedModeSession.stopSeat`/`setSeatModel` (the registry lives in `prepareModeSession`).
 * - `session.pause`/`resume`, `seat.inject`/`restart` (FU-18a) act at turn boundaries through
 *   `PreparedModeSession.pause`/`resume`/`injectSeat`/`restartSeat`.
 * - All of them reach only sessions in this engine's map, i.e. ones this process runs (and
 *   holds the event-log lock for); a session run elsewhere is unknown here (InvalidParams).
 */

/** What `prepareModeSession` needs besides the fields this module owns. */
export type SessionLaunch = Omit<ModeSessionInput, "mode" | "sessionId" | "goal" | "title" | "signal" | "emit" | "resume"> & {
  /** A definition for a mode not in the registry (tests); the requested id is used otherwise. */
  mode?: ModeDefinition;
};

export interface SessionHost {
  /**
   * Builds deps/config for one session. May lower, never raise, the requested autonomy.
   * Skills (TE-07): serve's host should return `skills: await SkillLibrary.load({ projectPath })`
   * here (a library: the session id does not exist yet, `prepareModeSession` makes the session).
   */
  launch(request: {
    mode: string;
    goal: string;
    autonomy?: Autonomy;
    sessionId: string;
    emit: (draft: EngineEventDraft) => void;
  }): SessionLaunch | Promise<SessionLaunch>;
}

export interface SessionControlOptions {
  projectPath: string;
  host?: SessionHost;
  /** Default: a manager for `projectPath`. */
  worktrees?: WorktreeManager;
  /** Same scan `sessions.list` uses. */
  list: () => Promise<SessionSummary[]>;
  /** Highest autonomy a session may start with, whatever the host or client asks for. */
  maxAutonomy?: Autonomy;
  /** A created session that is not started within this time is dropped. Default 10 min. */
  createdTtlMs?: number;
  /** The native host is closing and will no longer accept requests. */
  signal?: AbortSignal;
}

type LiveState = "created" | "running" | "cancelling";
interface Live {
  prepared: PreparedModeSession;
  abort: AbortController;
  state: LiveState;
  log?: EventLog;
  /** Task-level run lock (FU-15), held from start until the run settles. */
  runLock?: RunLock;
  /** Approval question ids (dynamic) and stage ids (static) the session is waiting on. */
  approvals: Set<string>;
  title: string;
  /** Drops a never-started session; cleared on start or cancel. */
  expiry?: NodeJS.Timeout;
}

const MAX_LIVE_SESSIONS = 32;
const MAX_EXPORT_EVENTS = 5_000;
const MAX_EXPORT_CHARS = 1024 * 1024;
const MAX_DIFF_CHARS = 512 * 1024;
const CREATED_TTL_MS = 10 * 60_000;

const invalid = (message: string) => new RpcError(RpcErrorCode.InvalidParams, message);
const rejected = (message: string) => new RpcError(RpcErrorCode.Rejected, scrubPaths(message));

export function registerSessionControlMethods(server: RpcServer, options: SessionControlOptions): RpcServer {
  const { projectPath } = options;
  const manager = options.worktrees ?? new WorktreeManager({ repoPath: projectPath });
  const sessions = new Map<string, Live>();
  options.signal?.addEventListener("abort", () => {
    for (const [id, live] of sessions) {
      clearTimeout(live.expiry);
      if (live.state === "created") sessions.delete(id);
      live.abort.abort();
    }
  }, { once: true });

  const liveOf = (sessionId: string): Live => {
    const live = isId(sessionId) ? sessions.get(sessionId) : undefined;
    if (!live) throw invalid("no live session with that id in this engine");
    return live;
  };

  /** Worktrees only of the given session, found in the manifest: the client's ids never reach a path. */
  const seatKey = async (sessionId: string, seatId: string) => {
    if (!isId(sessionId)) throw invalid("invalid session id");
    try {
      if (!(await manager.list(sessionId)).some((w) => w.seatId === seatId)) throw invalid("no worktree for that session and seat");
    } catch (error) {
      throw asRpcError(error);
    }
    return { sessionId, seatId };
  };

  const takeRunLock = async (sessionId: string): Promise<RunLock> => {
    try {
      return await acquireRunLock(projectPath, sessionId);
    } catch (error) {
      throw error instanceof RunLockedError ? rejected("another process is running this session") : asRpcError(error);
    }
  };

  /**
   * Worktrees of a session that is running (here or in another process) are not changed from outside.
   * The run lock is held for the whole change, so a CLI resume cannot start in the middle of it.
   */
  const whileIdle = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    if (sessions.has(sessionId)) throw rejected("the session is live; cancel it first");
    const lock = await takeRunLock(sessionId);
    try {
      if (await isSessionLogLocked(projectPath, sessionId)) throw rejected("another process is running this session");
      return await work();
    } finally {
      await lock.release().catch(() => undefined);
    }
  };

  const summaryOf = async (sessionId: string): Promise<RpcResult<"session.get">["session"]> => {
    const live = sessions.get(sessionId);
    const found = (await options.list()).find((s) => s.id === sessionId);
    if (!found && !live) throw invalid("unknown session");
    return { ...(found ?? { id: sessionId, title: live!.title, hasLiveLog: false, lastSeq: 0 }), ...(live ? { live: live.state } : {}) };
  };

  /** Seat and pause control reach only a running session of this engine; `act` returns why it refused. */
  const seatCall = (sessionId: string, act: (prepared: PreparedModeSession) => string | undefined) => {
    const live = liveOf(sessionId);
    if (live.state !== "running") throw rejected(`session is ${live.state}`);
    const refused = act(live.prepared);
    if (refused) throw rejected(refused);
    return { ok: true as const };
  };

  /** Lead controls (FU-18b): a running Lead session of this engine (so its run lock is ours); the controller may refuse. */
  const leadCall = (sessionId: string, command: ControllerCommand) =>
    seatCall(sessionId, (p) => (p.mode.id === "lead" ? p.control(command) : `session is ${p.mode.id} mode, not lead`));

  const finish = async (sessionId: string, live: Live, run: Promise<unknown>) => {
    const emit = emitFor(live);
    try {
      await run;
    } catch (error) {
      emit({ type: "session.failed", sessionId, data: { status: "failed", reason: error instanceof Error ? error.message : String(error) } });
    }
    // Close first: while the entry is live, worktree changes stay refused.
    await live.log?.close().catch(() => undefined);
    await live.runLock?.release().catch(() => undefined);
    sessions.delete(sessionId);
  };

  server.registerAll({
    "session.create": async ({ mode, goal, title, autonomy }) => {
      if (!options.host) throw new RpcError(RpcErrorCode.NotSupported, "session.create is not supported yet: this engine has no session host");
      const checkCap = () => {
        if (sessions.size >= MAX_LIVE_SESSIONS) throw rejected("too many live sessions; cancel or finish one first");
      };
      checkCap();
      const sessionId = createId();
      const abort = new AbortController();
      const live = { abort, state: "created", approvals: new Set(), title: title?.trim() || goal.trim().split("\n")[0]!.slice(0, 80) } as Live;
      const emit = emitFor(live);
      const launch = await options.host.launch({ mode, goal, sessionId, emit, ...(autonomy ? { autonomy } : {}) });
      checkCap(); // other creates may have finished while the host was working
      if (options.signal?.aborted) throw rejected("the engine is shutting down");
      try {
        live.prepared = prepareModeSession({
          // The lowest of what the host, the client and this server's cap allow: never more autonomy than any of them.
          ...launch,
          autonomy: [launch.autonomy, autonomy, options.maxAutonomy].reduce<Autonomy>(
            (low, a) => (a && AUTONOMY_LEVELS.indexOf(a) < AUTONOMY_LEVELS.indexOf(low) ? a : low),
            launch.autonomy,
          ),
          // Applies from the host's own manager, else the one the worktree methods use.
          worktrees: launch.worktrees ?? manager,
          mode: launch.mode ?? mode,
          sessionId,
          goal,
          ...(title ? { title } : {}),
          signal: abort.signal,
          emit,
        });
      } catch (error) {
        if (error instanceof ModeValidationError) throw invalid(scrubPaths(error.message));
        throw asRpcError(error);
      }
      sessions.set(sessionId, live);
      live.expiry = setTimeout(() => {
        if (live.state === "created" && sessions.get(sessionId) === live) {
          sessions.delete(sessionId);
          live.abort.abort();
        }
      }, options.createdTtlMs ?? CREATED_TTL_MS);
      live.expiry.unref();
      return { sessionId, mode: live.prepared.mode.id, autonomy: live.prepared.autonomy };
    },

    "session.start": async ({ sessionId }) => {
      const live = liveOf(sessionId);
      if (live.state !== "created") throw rejected(`session is already ${live.state}`);
      const runLock = await takeRunLock(sessionId);
      let log: EventLog;
      try {
        log = await EventLog.open(projectPath, sessionId);
      } catch (error) {
        await runLock.release().catch(() => undefined);
        throw error instanceof EventLogLockedError ? rejected("another process owns this session's event log") : asRpcError(error);
      }
      // A cancel or expiry during the open wins: do not run an aborted session.
      if (live.state !== "created" || sessions.get(sessionId) !== live || live.abort.signal.aborted || options.signal?.aborted) {
        await log.close().catch(() => undefined);
        await runLock.release().catch(() => undefined);
        throw rejected("the session was cancelled before it started");
      }
      clearTimeout(live.expiry);
      live.runLock = runLock;
      live.log = log;
      live.state = "running";
      void finish(sessionId, live, live.prepared.run());
      return { sessionId, live: live.state };
    },

    "session.pause": ({ sessionId }) => seatCall(sessionId, (p) => p.pause()),
    "session.resume": ({ sessionId }) => seatCall(sessionId, (p) => p.resume()),

    "session.cancel": ({ sessionId }) => {
      const live = liveOf(sessionId);
      clearTimeout(live.expiry);
      if (live.state === "created") {
        sessions.delete(sessionId); // never started: nothing to settle
      }
      live.state = "cancelling";
      // Aborting settles every open question and approval gate; the run then ends "cancelled".
      live.abort.abort();
      return { ok: true as const, live: live.state };
    },

    "session.list": async () => {
      const listed = (await options.list()).map((s) => ({ ...s, ...(sessions.has(s.id) ? { live: sessions.get(s.id)!.state } : {}) }));
      const known = new Set(listed.map((s) => s.id));
      const created = [...sessions].filter(([id]) => !known.has(id)).map(([id, l]) => ({ id, title: l.title, hasLiveLog: false, lastSeq: 0, live: l.state }));
      return { sessions: [...created, ...listed] };
    },

    "session.get": async ({ sessionId }) => {
      if (!isId(sessionId)) throw invalid("invalid session id");
      return { session: await summaryOf(sessionId), pendingApprovals: [...(sessions.get(sessionId)?.approvals ?? [])] };
    },

    "session.approve": ({ sessionId, id, decision }) => {
      const live = liveOf(sessionId);
      if (live.state !== "running") throw rejected(`session is ${live.state}`);
      if (decision === "deny" && live.prepared.mode.kind === "static") {
        throw rejected("a static stage gate can only be approved; cancel the session to refuse it");
      }
      const done =
        live.approvals.has(id) && (decision === "approve" ? live.prepared.approve(id) : live.prepared.answer(id, "deny"));
      if (!done) throw invalid("no pending approval with that id");
      return { ok: true as const };
    },

    "session.export": async ({ sessionId, fromSeq }) => {
      if (!isId(sessionId)) throw invalid("invalid session id");
      await summaryOf(sessionId); // unknown id → InvalidParams
      return readEventsBounded(sessionPaths(projectPath, sessionId).events, fromSeq);
    },

    "seat.setModel": ({ sessionId, seatId, model }) => seatCall(sessionId, (p) => p.setSeatModel(seatId, model)),
    "seat.stop": ({ sessionId, seatId }) => seatCall(sessionId, (p) => p.stopSeat(seatId)),
    "seat.inject": ({ sessionId, seatId, text }) => seatCall(sessionId, (p) => p.injectSeat(seatId, text)),
    "seat.restart": ({ sessionId, seatId }) => seatCall(sessionId, (p) => p.restartSeat(seatId)),

    "worktree.diff": async ({ sessionId, seatId }) => {
      const key = await seatKey(sessionId, seatId);
      try {
        const { diff, ...rest } = await manager.diff(key);
        return { ...rest, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS };
      } catch (error) {
        throw asRpcError(error);
      }
    },

    // The target is always the main checkout; the caller's confirm: true is the approval.
    "worktree.apply": async ({ sessionId, seatId, strategy, message, allowedPaths }) => {
      const key = await seatKey(sessionId, seatId);
      return whileIdle(sessionId, async () => {
        try {
          const result = await manager.applyTo("main", key, {
            strategy,
            ...(message ? { message } : {}),
            ...(allowedPaths ? { allowedPaths } : {}),
          });
          return result.ok ? result : { ...result, message: scrubPaths(result.message) };
        } catch (error) {
          throw asRpcError(error);
        }
      });
    },

    "lead.override": ({ sessionId, taskId, seatId }) => leadCall(sessionId, { kind: "override", taskId, seatId }),
    "lead.pin": ({ sessionId, taskId, model }) => leadCall(sessionId, { kind: "pin", taskId, model }),
    "lead.pause": ({ sessionId }) => leadCall(sessionId, { kind: "pause" }),
    "lead.resume": ({ sessionId }) => leadCall(sessionId, { kind: "resume" }),

    "worktree.discard": async ({ sessionId, seatId, force }) => {
      const key = await seatKey(sessionId, seatId);
      return whileIdle(sessionId, async () => {
        try {
          await manager.discard(key, { force: force === true });
        } catch (error) {
          throw asRpcError(error);
        }
        return { ok: true as const };
      });
    },
  });
  return server;
}

/** Session events go to the log once started; approval bookkeeping rides along. */
function emitFor(live: Live): (draft: EngineEventDraft) => void {
  return (draft) => {
    if (draft.type === "user.question" && draft.data.kind === "approval") live.approvals.add(String(draft.data.questionId));
    else if (draft.type === "user.answer") live.approvals.delete(String(draft.data.questionId));
    else if (draft.type === "session.state" && draft.stageId) {
      if (draft.data.to === "waiting") live.approvals.add(draft.stageId);
      else if (draft.data.from === "waiting") live.approvals.delete(draft.stageId);
    }
    void live.log?.append(draft).catch(() => undefined);
  };
}

function asRpcError(error: unknown): Error {
  if (error instanceof RpcError) return error;
  if (error instanceof WorktreeError) return rejected(error.message);
  return error as Error;
}

/**
 * Events with `seq > fromSeq`, read in chunks and stopped at 5,000 events or ~1 MiB of JSON
 * (`truncated` then says more exist). An unterminated last line is an append in progress.
 */
async function readEventsBounded(file: string, fromSeq: number): Promise<RpcResult<"session.export">> {
  const events: Array<Record<string, unknown>> = [];
  let chars = 0;
  let carry = "";
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events, truncated: false };
    throw error;
  }
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder();
    for (let offset = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) return { events, truncated: false };
      offset += bytesRead;
      carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop()!;
      if (carry.length > MAX_EXPORT_CHARS) throw rejected("the event log has a line that is too long to export");
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = safeParseEngineEvent(parseJson(line));
        if (!parsed.success) throw rejected("the event log has an invalid line");
        if (parsed.data.seq <= fromSeq) continue;
        chars += line.length;
        if (events.length >= MAX_EXPORT_EVENTS || chars > MAX_EXPORT_CHARS) return { events, truncated: true };
        events.push(parsed.data as unknown as Record<string, unknown>);
      }
    }
  } finally {
    await handle.close();
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
