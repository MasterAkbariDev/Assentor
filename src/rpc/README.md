# Engine RPC (`src/rpc/`)

JSON-RPC 2.0 between the engine and its clients (CLI/TUI in process, the Tauri sidecar over stdio, the web UI over `assentor serve`). This first cut is **read-only**.

| File | What it is |
|---|---|
| `../protocol/rpc.ts` | The contract: method params/result zod schemas, error codes, notification shapes. Browser-safe. |
| `server.ts` | `RpcServer` (method registry) and `RpcConnection` (one per client: validation, error mapping, serialized writer). |
| `engine.ts` | `createEngineRpcServer({ projectPath })` — registers every engine method. |
| `sessions.ts` | `sessions.list`, `events.subscribe` / `events.unsubscribe` (read-only; never locks or repairs the log). |
| `transports.ts` | `createInProcessTransport(server)`, `serveStdio(server, { input, output })` (NDJSON). |
| `client.ts` | `RpcClient` — typed `call`, notifications, `subscribeEvents`, `onClose`. Browser-safe. |
| `browser.ts` | Browser entry: client + contract only. **The web UI imports this**, never `index.ts` (which pulls in `node:fs`). |

## Adding a method

1. Add `"area.verb": { params, result }` to `RpcMethods` in `src/protocol/rpc.ts`. Use `.strict()` objects so unknown params are rejected.
2. Register a handler in `engine.ts`:
   ```ts
   server.register("area.verb", async (params, { connection }) => {
     // params is already validated and typed
     return { ... }; // checked against the result schema
   });
   ```
3. Throw `new RpcError(RpcErrorCode.InvalidParams, "…")` for a client mistake; any other throw becomes `-32603 Internal error` (message only, no stack).
4. For streams, send `connection.notify(method, params)` and `await` it (that is the backpressure), and stop work in `connection.onClose(...)`.
5. Test it through `createInProcessTransport` + `RpcClient` (see `tests/unit/rpc-core.test.ts`).

## Rules

- No method may write, delete or start anything until the serve security card (T04-03p) and the user allow write methods.
- Events are delivered in `seq` order. A client that reconnects (`onDisconnect`) resubscribes with `fromSeq` = the last `seq` it applied. On `events.resync_required` it does the same from `lastSeq` for `log_replaced` / `slow_consumer`, and after a backoff for `io_error`; `unreadable_log` (a line over the limit) is terminal (show an error, don't loop).
- Frames over 1 MiB are rejected (`-32600`). Internal error messages have absolute paths replaced by `<path>`.
- Memory per subscription is bounded by one read chunk (64 KiB by default): a slow client falls behind on the file instead of growing a queue.
