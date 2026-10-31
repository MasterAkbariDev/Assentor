# Engine RPC (`packages/engine/src/rpc/`)

JSON-RPC 2.0 between the engine and its clients (CLI/TUI in process, the Tauri sidecar over stdio, the web UI over `assentor serve`). The `session.*` / `seat.*` / `worktree.*` methods (T04-05) include `write` ones (see **Write access**).

| File | What it is |
|---|---|
| `packages/protocol/src/rpc.ts` (`#assentor/protocol/rpc.js`) | The contract (`RpcMethods`): per method `access`, params/result zod schemas; error codes, notification shapes. Browser-safe. |
| `packages/protocol/src/rpc-client.ts` (`#assentor/protocol/rpc-client.js`) | `RpcClient` — typed `call` (method, params and result from the contract), notifications, `subscribeEvents`, `onClose`. Browser-safe; **the web UI imports this**. |
| `server.ts` | `RpcServer` (method registry, `register` / `registerAll`) and `RpcConnection` (one per client: write gate, validation, error mapping, serialized writer). |
| `engine.ts` | `createEngineRpcServer({ projectPath })` — registers every engine method (the core ones with `registerAll`: the example to copy). |
| `library.ts` | `registerLibraryMethods` — read-only `prompt.list`, `prompt.get`, `team.list`, `models.catalog`. |
| `session-control.ts` | `registerSessionControlMethods` — `session.*`, `seat.*`, `worktree.*` (see **Session control**). |
| `sessions.ts` | `sessions.list`, `events.subscribe` / `events.unsubscribe` (read-only; never locks or repairs the log). |
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

Default-deny. A connection runs a method whose `access` is not exactly `"read"` only if its transport opened it with `server.connect(send, { allowWrite: true })`; otherwise it answers `-32002 WriteNotAllowed` (a notification is dropped) without validating params or calling the handler.

| Transport | Writes |
|---|---|
| in-process (`createInProcessTransport`) | allowed (same process) |
| stdio (`serveStdio`) | allowed (the parent process that spawned the engine) |
| WebSocket (`assentor serve`) | **refused** until T04-03 adds write auth |

## Read-only library methods (`library.ts`)

| Method | Params | Result |
|---|---|---|
| `prompt.list` | none | `prompts` (id, title, role, description?, source `builtin`/`user`/`project`, `overridden`) and `errors` (file relative to its layer directory, message) |
| `prompt.get` | `{ id }` | id, title, role, source, `frontMatter`, `body`. Unknown id: `InvalidParams` |
| `team.list` | none | `teams` (config teams expanded to seats, plus `legacy-review` when `modes.review` is unset) and `modes` (team names) |
| `models.catalog` | `{ provider }` | `entries` (id, label, source) from the model cache only; never runs discovery |

Results never contain absolute paths, key ids or vault data.

## Session control (`session-control.ts`)

`session.create` needs a `SessionHost` (`createEngineRpcServer({ sessionHost })`) that returns the `prepareModeSession` deps for a request; without one it answers `-32003 NotSupported`. Sessions run through `prepareModeSession` (no second launcher); `create` validates and starts nothing, `start` opens the event log and runs.

| Method | Access | Delegates to |
|---|---|---|
| `session.create` / `start` | write | `prepareModeSession` / `PreparedModeSession.run` + `EventLog` |
| `session.cancel` | write | aborts the session signal (settles open questions and approval gates) |
| `session.approve` `{ id, decision }` | write | `approve(id)` / `answer(id, "deny")`; static gates cannot be denied |
| `session.list` / `get` / `export` | read | the `sessions.list` scan, live state, `readSessionEvents` (5,000 events max) |
| `worktree.diff` | read | `WorktreeManager.diff` (diff text cut at 512 KiB) |
| `worktree.apply` / `discard` | write | `applyTo("main")` / `discard`; both need `confirm: true`; discard refuses a live session's worktree |
| `session.pause` / `resume`, `seat.setModel` / `inject` / `stop` / `restart` | write | **not supported yet** (`-32003`): no engine pause, no static resume via `prepareModeSession`, no registry from a session id to a live Supervisor or executor |

Worktrees are addressed by `(sessionId, seatId)` and looked up in the manager's manifest; a client never sends a path. `-32004 Rejected` means the engine understood and refused (wrong state, git refusal).

## Rules

- No `read` method may write, delete or start anything. Write methods stay off `serve` until T04-03 adds write auth.
- Events are delivered in `seq` order. A client that reconnects (`onDisconnect`) resubscribes with `fromSeq` = the last `seq` it applied. On `events.resync_required` it does the same from `lastSeq` for `log_replaced` / `slow_consumer`, and after a backoff for `io_error`; `unreadable_log` (a line over the limit) is terminal (show an error, don't loop).
- Frames over 1 MiB are rejected (`-32600`). Internal error messages have absolute paths replaced by `<path>`.
- Memory per subscription is bounded by one read chunk (64 KiB by default): a slow client falls behind on the file instead of growing a queue.
