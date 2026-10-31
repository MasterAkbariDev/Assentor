import { EventLog, EventLogLockedError, readSessionEvents } from "../events/log.js";
import { createId, isId } from "../core/ids.js";
import type { ModeDefinition } from "../modes/registry.js";
import { ModeValidationError, prepareModeSession, type ModeSessionInput, type PreparedModeSession } from "../modes/session.js";
import { WorktreeError, WorktreeManager } from "../worktrees/manager.js";
import type { Autonomy } from "../core/run-mode.js";
import type { EngineEventDraft } from "#assentor/protocol/events.js";
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
 * - `session.pause`/`resume` and all `seat.*` answer `NotSupported`: the engine has no pause,
 *   no static-session resume through `prepareModeSession`, and no registry that reaches a
 *   live Supervisor or executor from a session id.
 */

/** What `prepareModeSession` needs besides the fields this module owns. */
export type SessionLaunch = Omit<ModeSessionInput, "mode" | "sessionId" | "goal" | "title" | "signal" | "emit" | "resume"> & {
  /** A definition for a mode not in the registry (tests); the requested id is used otherwise. */
  mode?: ModeDefinition;
};

export interface SessionHost {
  /** Builds deps/config for one session. May lower, never raise, the requested autonomy. */
  launch(request: { mode: string; goal: string; autonomy?: Autonomy }): SessionLaunch | Promise<SessionLaunch>;
}

export interface SessionControlOptions {
  projectPath: string;
  host?: SessionHost;
  /** Default: a manager for `projectPath`. */
  worktrees?: WorktreeManager;
  /** Same scan `sessions.list` uses. */
  list: () => Promise<SessionSummary[]>;
}

type LiveState = "created" | "running" | "cancelling";
interface Live {
  prepared: PreparedModeSession;
  abort: AbortController;
  state: LiveState;
  log?: EventLog;
  /** Approval question ids (dynamic) and stage ids (static) the session is waiting on. */
  approvals: Set<string>;
  title: string;
}

const MAX_LIVE_SESSIONS = 32;
const MAX_EXPORT_EVENTS = 5_000;
const MAX_DIFF_CHARS = 512 * 1024;

const invalid = (message: string) => new RpcError(RpcErrorCode.InvalidParams, message);
const rejected = (message: string) => new RpcError(RpcErrorCode.Rejected, scrubPaths(message));
const unsupported = (what: string, why: string) => () => {
  throw new RpcError(RpcErrorCode.NotSupported, `${what} is not supported yet: ${why}`);
};

export function registerSessionControlMethods(server: RpcServer, options: SessionControlOptions): RpcServer {
  const { projectPath } = options;
  const manager = options.worktrees ?? new WorktreeManager({ repoPath: projectPath });
  const sessions = new Map<string, Live>();

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

  const summaryOf = async (sessionId: string): Promise<RpcResult<"session.get">["session"]> => {
    const live = sessions.get(sessionId);
    const found = (await options.list()).find((s) => s.id === sessionId);
    if (!found && !live) throw invalid("unknown session");
    return { ...(found ?? { id: sessionId, title: live!.title, hasLiveLog: false, lastSeq: 0 }), ...(live ? { live: live.state } : {}) };
  };

  const finish = async (sessionId: string, live: Live, run: Promise<unknown>) => {
    const emit = emitFor(live);
    try {
      await run;
    } catch (error) {
      emit({ type: "session.failed", sessionId, data: { status: "failed", reason: error instanceof Error ? error.message : String(error) } });
    }
    sessions.delete(sessionId);
    await live.log?.close().catch(() => undefined);
  };

  server.registerAll({
    "session.create": async ({ mode, goal, title, autonomy }) => {
      if (!options.host) throw new RpcError(RpcErrorCode.NotSupported, "session.create is not supported yet: this engine has no session host");
      if (sessions.size >= MAX_LIVE_SESSIONS) throw rejected("too many live sessions; cancel or finish one first");
      const launch = await options.host.launch({ mode, goal, ...(autonomy ? { autonomy } : {}) });
      const sessionId = createId();
      const abort = new AbortController();
      const live = { abort, state: "created", approvals: new Set(), title: title?.trim() || goal.trim().split("\n")[0]!.slice(0, 80) } as Live;
      try {
        live.prepared = prepareModeSession({
          ...launch,
          mode: launch.mode ?? mode,
          sessionId,
          goal,
          ...(title ? { title } : {}),
          signal: abort.signal,
          emit: emitFor(live),
        });
      } catch (error) {
        if (error instanceof ModeValidationError) throw invalid(error.message);
        throw asRpcError(error);
      }
      sessions.set(sessionId, live);
      return { sessionId, mode: live.prepared.mode.id, autonomy: live.prepared.autonomy };
    },

    "session.start": async ({ sessionId }) => {
      const live = liveOf(sessionId);
      if (live.state !== "created") throw rejected(`session is already ${live.state}`);
      try {
        live.log = await EventLog.open(projectPath, sessionId);
      } catch (error) {
        throw error instanceof EventLogLockedError ? rejected("another process owns this session's event log") : asRpcError(error);
      }
      live.state = "running";
      void finish(sessionId, live, live.prepared.run());
      return { sessionId, live: live.state };
    },

    "session.pause": unsupported("session.pause", "the engine has no pause; cancel the session instead"),
    "session.resume": unsupported("session.resume", "a static session has no prepared resume path and there is no pause"),

    "session.cancel": ({ sessionId }) => {
      const live = liveOf(sessionId);
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
      const events = await readSessionEvents(projectPath, sessionId, fromSeq);
      return { events: events.slice(0, MAX_EXPORT_EVENTS) as unknown as Array<Record<string, unknown>>, truncated: events.length > MAX_EXPORT_EVENTS };
    },

    "seat.setModel": unsupported("seat.setModel", "no registry reaches a live Supervisor from a session id (Supervisor.requestModelChange exists)"),
    "seat.inject": unsupported("seat.inject", "the engine has no way to inject text into a running seat"),
    "seat.stop": unsupported("seat.stop", "no registry reaches a live executor from a session id"),
    "seat.restart": unsupported("seat.restart", "no registry reaches a live executor from a session id"),

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
      try {
        return await manager.applyTo("main", key, {
          strategy,
          ...(message ? { message } : {}),
          ...(allowedPaths ? { allowedPaths } : {}),
        });
      } catch (error) {
        throw asRpcError(error);
      }
    },

    "worktree.discard": async ({ sessionId, seatId, force }) => {
      const key = await seatKey(sessionId, seatId);
      if (sessions.has(sessionId)) throw rejected("the session is live; cancel it before discarding its worktrees");
      try {
        await manager.discard(key, { force: force === true });
      } catch (error) {
        throw asRpcError(error);
      }
      return { ok: true as const };
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
