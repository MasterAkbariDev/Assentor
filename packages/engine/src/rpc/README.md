# Engine RPC (`packages/engine/src/rpc/`)

JSON-RPC 2.0 between the engine and its clients (CLI/TUI in process, the Tauri sidecar over stdio, the web UI over `assentor serve`). Reads, plus the `write` methods listed under **Handlers** and the `session.*` / `seat.*` / `worktree.*` mutations (T04-05) (see **Write access**).

| File | What it is |
|---|---|
| `packages/protocol/src/rpc.ts` (`#assentor/protocol/rpc.js`) | The contract (`RpcMethods`): per method `access`, params/result zod schemas; error codes, notification shapes. Browser-safe. |
| `packages/protocol/src/rpc-client.ts` (`#assentor/protocol/rpc-client.js`) | `RpcClient` — typed `call` (method, params and result from the contract), notifications, `subscribeEvents`, `onClose`. Browser-safe; **the web UI imports this**. |
| `server.ts` | `RpcServer` (method registry, `register` / `registerAll`) and `RpcConnection` (one per client: write gate, validation, error mapping, serialized writer). |
| `engine.ts` | `createEngineRpcServer({ projectPath })` — registers every engine method (the core ones with `registerAll`: the example to copy). |
| `handlers/` | `registerHandlerMethods` (T04-04): `prompts.ts`, `teams.ts`, `playbooks.ts`, `settings.ts`, `env.ts`. |
| `library.ts` | `registerLibraryMethods` — read-only `prompt.list`, `prompt.get`, `skill.list`, `skill.get`, `team.list`, `models.catalog`. |
| `session-control.ts` | `registerSessionControlMethods` — `session.*`, `seat.*`, `lead.*`, `worktree.*` (see **Session control**). |
| `sessions.ts` | `sessions.list`, `events.subscribe` / `events.unsubscribe` (read-only; never locks or repairs the log). |
| `engine.ts` → `usage.get` | `{ sessionId }` → the session's usage ledger (`UsageReportSchema`, TE-01): totals by seat / stage / model, retries, budget warnings. Streams the log (`usage/read.ts`): unreadable lines are skipped and counted (`skippedLines`), reading stops after 1,000,000 lines (`truncated`); a missing log is an all-zero report. Token counts come from `seat.tokens`: scheduler jobs that report usage, solo-run executor turns (seat sink) and mode-run executor turns and asks (`cli/mode-run.ts`) whose CLI prints a usage line (Claude Code stream-json; see `usage/cli-usage.ts`), interrupted turns included. Since TE-05 also API seats (OpenAI-compatible `usage`, Gemini `usageMetadata`, cached tokens included) and Claude Code reviewer/ask turns (`--output-format json`), per member seat in a panel. Text-format output (codex, opencode, cursor/antigravity reviewers) reports nothing. |
| `transports.ts` | `createInProcessTransport(server)`, `serveStdio(server, { input, output })` (NDJSON). |
| `browser.ts` | Old browser entry, kept as a re-export of the two protocol files. Never import `index.ts` from a browser (it pulls in `node:fs`). |

## Adding a method

1. Add `"area.verb": { access: "read", params, result }` to `RpcMethods` in `packages/protocol/src/rpc.ts`. Use `.strict()` objects so unknown params are rejected. Anything that writes, deletes or starts something is `access: "write"`.
2. Write the handlers in your own module and register them from `engine.ts` (as `library.ts` does):
   ```ts
   export function registerAreaMethods(server: RpcServer, options: { projectPath: string }): RpcServer {
     return server.registerAll({
       "area.verb": async (params, { connection }) => {
         // params is already validated and typed from the contract
         return { ... }; // checked against the result schema
       },
     });
   }
   ```
3. Throw `new RpcError(RpcErrorCode.InvalidParams, "…")` for a client mistake; any other throw becomes `-32603 Internal error` (message only, no stack).
4. For streams, send `connection.notify(method, params)` and `await` it (that is the backpressure), and stop work in `connection.onClose(...)`.
5. Test it through `createInProcessTransport` + `RpcClient` (see `tests/unit/rpc-core.test.ts`). `client.call("area.verb", …)` is typed from the contract: wrong params fail typecheck.

## Write access

Default-deny. A connection runs a method whose `access` is not exactly `"read"` only if its transport opened it with `server.connect(send, { allowWrite: true })`; otherwise it answers `-32002 WriteNotAllowed` (a notification is dropped) without validating params or calling the handler. `engine.hello` capabilities list only the methods the connection may call (`RpcConnection.methodNames`).

| Transport | Writes |
|---|---|
| in-process (`createInProcessTransport`) | allowed (same process) |
| stdio (`serveStdio`) | allowed: full trust in its peer, the parent process that spawned the engine (the Tauri shell). Never connect it to a less-trusted peer (a socket, a pipe another user can open, a browser). |
| WebSocket (`assentor serve`) | refused unless serve runs with `--allow-write` (loopback only, never with `--unsafe-listen`) **and** the client's auth frame is `{"auth":"<token>","write":true}`. Then rate limited (30 per 10 s across connections, `-32003 RateLimited`) and each call appends an `rpc.write` line (method name only) to `~/.assentor/audit.jsonl`; a failed audit append refuses the call |

`connect(send, { allowWrite: true, beforeWrite })`: `beforeWrite(method)` runs after params validate and before the handler; throw `RpcError` (or reject) to refuse.

## Read-only library methods (`library.ts`)

| Method | Params | Result |
|---|---|---|
| `prompt.list` | none | `prompts` (id, title, role, description?, source `builtin`/`user`/`project`, `overridden`) and `errors` (file relative to its layer directory, message) |
| `prompt.get` | `{ id }` | id, title, role, source, `frontMatter`, `body`. Unknown id: `InvalidParams` |
| `skill.list` | none | `skills` (name, description, source, `overridden`, roles?/modes?/profiles?, `tokens` = estimated body size) and `errors` (file relative to its layer's skills directory, message) |
| `skill.get` | `{ name }` | the summary plus `frontMatter` and `body`. Unknown name: `InvalidParams` |
| `team.list` | none | `teams` (config teams expanded to seats, each with its saved `spec` for editing; plus `legacy-review` when `modes.review` is unset) and `modes` (team names) |
| `models.catalog` | `{ provider }` | `entries` (id, label, source) from the model cache only; never runs discovery |

The library methods' results never contain absolute paths, key ids or vault data. (`settings.get` lists key ids by design, as `{ id, provider, name, healthy }`, read without touching the vault.)

## Handlers (`handlers/`)

| Method | Access | Notes |
|---|---|---|
| `prompt.save` | write | `scope` is `user` or `project` (never `builtin`); front-matter `id` is kebab-case, the file is `<id>.md`; a file the library rejects is rolled back |
| `prompt.fork` | write | full copy into `scope` as `newId` (default same id = override); refuses to overwrite |
| `prompt.preview` / `prompt.validate` | read | render with variables (`ok:false` + `missing`), problems + variables read |
| `team.save` / `team.delete` | write | user config only (`saveAssentorConfig`, written atomically; saves are serialized in-process); save refuses a name the project config defines; delete refuses a team used by any `modes.*` `*team` key or a playbook stage, `error.data.references` lists them |
| `team.validate` | read | |
| `playbook.list` / `playbook.get` | read | |
| `settings.get` | read | executor, run autonomy, routing, limits, git, artifacts; `keys` are `{ id, provider, name, healthy }` only |
| `settings.save` | write | patch of those fields into the user config; returns the merged settings. `executor.provider` is a selectable executor, `executor.model` a model id (never flag-like). Not settable: reviewers, `binaries`, `verification.commands`, `security`, teams, modes |
| `env.doctor`, `env.detectClis`, `models.discover` | write | call providers / start CLIs; absolute paths replaced by `<path>`, key-like tokens redacted |

## Session control (`session-control.ts`)

`session.create` needs a `SessionHost` (`createEngineRpcServer({ sessionHost })`) that returns the `prepareModeSession` deps for a request; without one it answers `-32004 NotSupported`. Sessions run through `prepareModeSession` (no second launcher); `create` validates and starts nothing, `start` opens the event log and runs.

| Method | Access | Delegates to |
|---|---|---|
| `session.create` / `start` | write | `prepareModeSession` / `PreparedModeSession.run` + `EventLog` |
| `session.cancel` | write | aborts the session signal (settles open questions and approval gates) |
| `session.approve` `{ id, decision }` | write | `approve(id)` / `answer(id, "deny")`; static gates cannot be denied |
| `session.list` / `get` / `export` | read | the `sessions.list` scan, live state, a chunked read of the log (stops at 5,000 events or ~1 MiB, then `truncated: true`) |
| `worktree.diff` | read | `WorktreeManager.diff` (diff text cut at 512 KiB). It takes the manager's repo lock (a `mkdir` under `.assentor/`), so it is not free of side effects on disk |
| `worktree.apply` / `discard` | write | `applyTo("main")` / `discard`; both need `confirm: true` and are refused while the session is live here (including `cancelling`) or its event-log writer lock is held by another live process |
| `seat.stop` `{ sessionId, seatId, confirm: true }` | write | `PreparedModeSession.stopSeat`: `cancel(taskId)` on each of the seat's executor turns in flight (kills the process tree) and `scheduler.cancelSeat` for its jobs. The session itself is not cancelled; the stopped turn ends `cancelled` with error `seat <id> stopped over RPC`, and what follows is the mode's normal failure path: a static stage's Supervisor fails, so the session fails with that reason; pair and swarm end `blocked` ("cancelled"); stopping a TDD stage's first edit seat aborts the whole round, coder included. Only a controller that handles a failed turn itself (e.g. Lead with other seats) keeps going. `-32005` when the seat has nothing running |
| `seat.setModel` `{ sessionId, seatId, model }` | write | `PreparedModeSession.setSeatModel`: `model` is a `ModelIdSchema` id; applied when the seat's next turn starts (`seat.model.changed` `pending: true`, then `pending: false`; `from` is the seat's configured model when it has one). A switch the Supervisor applies itself replaces a pending RPC request. `-32005` for a seat with no executor in this session or one that cannot switch models (`setModel` absent). No interrupt-now variant |
| `lead.override` `{ sessionId, taskId, seatId }` | write | FU-18b, Lead sessions only (`PreparedModeSession.control`). Checked now: `-32005` for an unknown task or seat, or a task that is accepted (integrated included) or split. Queued and applied by the controller at its next decision point (between lead turns), once the task's current run has reported: the task goes to that seat with `reassign`'s board and run checks (roster, busy, retired, dependencies, overlaps; an `in_review` task is rejected first), but not the lead's reassign limit. A later override of the same task replaces a queued one. The result is a `lead.action` `{ action: "override", by: "user", accepted, reason, taskId, seatId }` and a line in the lead's log |
| `lead.pin` `{ sessionId, taskId, model \| null }` | write | the task's next runs use `model` (`ModelIdSchema`; `null` unpins), on the seat the lead picks; the seat itself and other tasks keep their model. Refused (`-32005`) when the model fails the roster check on the task's current seat (provider, `roster.allowedProviders`/`maxCost`, rate limit), or, for a task with no seat yet, when no roster entry has it; each run checks the pinned model on its seat again. The Lead builds a fresh executor per run from the stage's seat, so the pin goes in that seat: the run's turn boundary, like FU-12's `setModel` but without needing an executor that can switch. Saved in `lead.json` at once. `lead.action` `{ action: "pin", by: "user", taskId, model }` |
| `lead.pause` / `lead.resume` `{ sessionId }` | write | Lead-only: the lead takes no new turns and the rest of a turn in flight is refused (`not run: the user paused the lead`, not counted as invalid); agent runs in flight finish and land on the board; queued overrides still apply. `-32005` when already paused / not paused. Saved in `lead.json`: a resumed session starts paused. `lead.action` `{ action: "pause" \| "resume", by: "user" }`; the shared reducer sets `paused` |
| `session.pause` / `resume` `{ sessionId }` | write | `PreparedModeSession.pause`/`resume` (FU-18a): a gate at turn boundaries. Turns in flight finish; every executor turn of the session waits at its start (in the `createExecutor` wrapper) and the scheduler admits no job until resume. `session.paused` / `session.resumed`. A cancel while paused works: held turns end `cancelled`, queued jobs are cancelled. Queued jobs start no timers, so paused time counts against neither their timeout nor a runtime budget; a turn already admitted to a scheduler job that then waits at the gate, and a Supervisor's own wall-clock budget, do keep counting: a long pause can time out a Lead task (its `taskTimeoutMinutes` job timer runs while the turn waits at the gate). Reviewer calls between executor turns are not held. A turn that wakes from the gate, or is about to re-run, after the session was cancelled or ended returns `cancelled` without starting. `-32005` when already paused / not paused |
| `seat.inject` `{ sessionId, seatId, text }` | write | `PreparedModeSession.injectSeat` (FU-18a): `text` is at most 8 KiB of UTF-8, not blank; redacted like reviewer input (`redactSecrets`), queued for the seat and appended to its **next** executor turn (a run's prompt; in a continue, a quoted `warning` from `user` that the continuation prompt shows under its own "Message from the user (data)" header, never as reviewer feedback) inside `<user-message>` blocks with a rule that it is data, not extra authority. The turn in flight is never touched. `seat.injected` with a redacted 80-character preview. `-32005` for a seat with no executor in this session and not named by a static execute stage, or with 8 messages already waiting. Text still queued when the run ends is reported as a `session.warning` `inject_undelivered` (whether a controller calls an idle seat again is not knowable up front) |
| `seat.restart` `{ sessionId, seatId, confirm: true }` | write | `PreparedModeSession.restartSeat` (FU-18a): `interrupt()` on the seat's one executor turn in flight (kills the process tree), then the same call runs once more with the same task and the seat's current model (plus any injected text) inside the wrapper; a run re-runs as a fresh CLI session (`newSession: true`, TE-05) so the killed session is not sent the prompt again, a continue resumes as before. At most 3 restarts per turn; so the controller sees one turn result and the stage does not fail. A result that arrived before the kill is kept. `-32005` for a seat with no turn running, more than one, or an executor without `interrupt` |

Seat and lead control reach only a session that is `running` in this engine (so FU-15's run lock is held by this process; a session another process runs is `-32602`); lead control also answers `-32005` for a session that is not Lead mode. Seat control reaches only a session that is `running` in this engine (`-32005` while created or cancelling; `-32602` once finished or for an unknown id). The registry from seat id to live executor is built in `prepareModeSession`'s `createExecutor` wrapper (every executor of a session but review mode's no-op one) and emptied when the run ends. An executor's seat is the one `seatOfStage` resolves (`options.seat`, `options.seatId`, the first edit seat, else the stage id); a TDD stage's composite executor answers to its first edit seat (stopping it aborts the round), its inner seats to `scheduler.cancelSeat` only.

Seat and pause control reach only a session that is `running` in this engine (so only the process that runs the session, holding its event-log lock, acts on it) (`-32005` while created or cancelling; `-32602` once finished or for an unknown id). The registry from seat id to live executor is built in `prepareModeSession`'s `createExecutor` wrapper (every executor of a session but review mode's no-op one) and emptied when the run ends. An executor's seat is the one `seatOfStage` resolves (`options.seat`, `options.seatId`, the first edit seat, else the stage id); a TDD stage's composite executor answers to its first edit seat (stopping it aborts the round), its inner seats to `scheduler.cancelSeat` only.

Autonomy: a session starts with the lowest of the host's `launch.autonomy`, the client's `autonomy` and `maxAutonomy` (`serve` sets `supervised`, so a browser never starts `autopilot`). Created sessions that are not started within 10 minutes are dropped; at most 32 are live. A host that returns no `worktrees` gets the RPC server's manager, so `worktree.*` and the session see the same manifest. Free-text questions (`ask`) cannot be answered over RPC yet: only approvals can (`session.approve`); cancel the session to release one.

Worktrees are addressed by `(sessionId, seatId)` and looked up in the manager's manifest; a client never sends a path. `-32005 Rejected` means the engine understood and refused (wrong state, git refusal).

## Rules

- No `read` method may write, delete or start anything. A new `write` method needs the user's sign-off; on `serve` it is reachable only through the write gate above.
- Events are delivered in `seq` order. A client that reconnects (`onDisconnect`) resubscribes with `fromSeq` = the last `seq` it applied. On `events.resync_required` it does the same from `lastSeq` for `log_replaced` / `slow_consumer`, and after a backoff for `io_error`; `unreadable_log` (a line over the limit) is terminal (show an error, don't loop).
- Frames over 1 MiB are rejected (`-32600`). Internal error messages have absolute paths replaced by `<path>`.
- Memory per subscription is bounded by one read chunk (64 KiB by default): a slow client falls behind on the file instead of growing a queue.
