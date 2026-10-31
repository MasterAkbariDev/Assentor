# Engine RPC (`packages/engine/src/rpc/`)

JSON-RPC 2.0 between the engine and its clients (CLI/TUI in process, the Tauri sidecar over stdio, the web UI over `assentor serve`). Reads, plus the `write` methods listed under **Handlers** (see **Write access**).

| File | What it is |
|---|---|
| `packages/protocol/src/rpc.ts` (`#assentor/protocol/rpc.js`) | The contract (`RpcMethods`): per method `access`, params/result zod schemas; error codes, notification shapes. Browser-safe. |
| `packages/protocol/src/rpc-client.ts` (`#assentor/protocol/rpc-client.js`) | `RpcClient` — typed `call` (method, params and result from the contract), notifications, `subscribeEvents`, `onClose`. Browser-safe; **the web UI imports this**. |
| `server.ts` | `RpcServer` (method registry, `register` / `registerAll`) and `RpcConnection` (one per client: write gate, validation, error mapping, serialized writer). |
| `engine.ts` | `createEngineRpcServer({ projectPath })` — registers every engine method (the core ones with `registerAll`: the example to copy). |
| `handlers/` | `registerHandlerMethods` (T04-04): `prompts.ts`, `teams.ts`, `playbooks.ts`, `settings.ts`, `env.ts`. |
| `library.ts` | `registerLibraryMethods` — read-only `prompt.list`, `prompt.get`, `team.list`, `models.catalog`. |
| `sessions.ts` | `sessions.list`, `events.subscribe` / `events.unsubscribe` (read-only; never locks or repairs the log). |
| `engine.ts` → `usage.get` | `{ sessionId }` → the session's usage ledger (`UsageReportSchema`, TE-01): totals by seat / stage / model, retries, budget warnings. Reads the log with `readSessionEvents`; a missing log is an all-zero report. |
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
| `team.list` | none | `teams` (config teams expanded to seats, plus `legacy-review` when `modes.review` is unset) and `modes` (team names) |
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

## Rules

- No `read` method may write, delete or start anything. A new `write` method needs the user's sign-off; on `serve` it is reachable only through the write gate above.
- Events are delivered in `seq` order. A client that reconnects (`onDisconnect`) resubscribes with `fromSeq` = the last `seq` it applied. On `events.resync_required` it does the same from `lastSeq` for `log_replaced` / `slow_consumer`, and after a backoff for `io_error`; `unreadable_log` (a line over the limit) is terminal (show an error, don't loop).
- Frames over 1 MiB are rejected (`-32600`). Internal error messages have absolute paths replaced by `<path>`.
- Memory per subscription is bounded by one read chunk (64 KiB by default): a slow client falls behind on the file instead of growing a queue.
