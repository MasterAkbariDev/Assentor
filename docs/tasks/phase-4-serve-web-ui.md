# Phase 4 — Engine server & Web UI

Phase exit criteria:
- [ ] `assentor app` starts the engine and opens the browser UI on macOS, Windows and Linux.
- [ ] A full negotiate + review session can be started, steered (model switch, inject, pause) and inspected from the browser.
- [ ] Reloading the page mid-session loses nothing (resubscribe from `lastSeq`).

Paths below assume the layout after **T04-01** (`packages/engine`, `packages/protocol`, `packages/cli`, `packages/ui`). UI screen tasks (T04-07…14) all build on the scaffold, store and transport from **T04-06** — read its README first.

### Shared rules for UI tasks (🟢 H)
- Components in `packages/ui/src/features/<feature>/`; one component per file; colocated `*.test.tsx` with Vitest + Testing Library.
- Read state **only** through store selectors from `packages/ui/src/store/` and send actions **only** through `useRpc()`; never `fetch`/WebSocket directly.
- Status icons/labels from `@assentor/ui-shared/status` (T01-06) — never re-define them.
- Every icon has a visible or `aria-label` text; all actions reachable by keyboard; respect `prefers-reduced-motion`.
- Use the design tokens from the scaffold (Tailwind theme) — no hard-coded colors; light + dark must both work.
- Lists that can exceed 200 rows use the virtualized list component from the scaffold.
- No new dependencies except those the card lists.

---

### T04-01 · Monorepo split
**Tier:** 🔴 O · **Review:** O2 · **Size:** L · **Depends:** Phases 0–3 merged

**Merged 2026-10-31 (planner, under the owner's standing merge direction):** O2 review PASS; pre-merge fixes in `7a55c91`. Packages `packages/{protocol,ui-shared,engine,cli,ui}`; cross-package imports are `#assentor/<pkg>/…` (root `package.json` `imports` → `dist/`, tsconfig paths, vitest/vite aliases) because npm does not bundle linked workspace packages; `tsc -b --force` builds every package into the same flat `dist/`, so bin, installers and `dist/cli/index.js` are unchanged. Built UI moved to `packages/ui/dist`. Verified: npm pack (873 → 877 files, listed in the review), a scratch consumer of the tarball (node16/nodenext/bundler), identical mock-run output, `assentor serve`. Not done: JSON Schema generation (needs a new dependency), Windows/Linux runs, typed RPC client still in engine (rest of T04-02); root `package.json` repeats every package's dependencies.

**Goal** — Move to `packages/{protocol,engine,cli,ui}` without behavior change; npm package `assentor` still installs the same `assentor` binary.

**Deliverables** — pnpm workspace packages; `protocol` holds zod schemas (events, seats, RPC) + generated JSON Schema; `src/ui-shared/` (T01-06) moves to `packages/ui-shared` published internally as `@assentor/ui-shared` (used by both TUI and web UI); `engine` has no Ink/React deps; `cli` depends on `engine`; build/test scripts at root; install scripts and `bin/assentor` unchanged for users; CHANGELOG entry. Git history preserved via `git mv`.

**Acceptance** — all tests green on 3 OSes; `npm pack` tarball contains the same runtime files; `assentor run` with mock providers identical output.

---

### T04-02 · JSON-RPC core + stdio & in-process transports
**Tier:** 🔴 O · **Review:** O2 · **Size:** M · **Depends:** T04-01

**Status: 🔶 read-only cut done as T04-02p** (`packages/engine/src/rpc/`, single package, ahead of T04-01; planner, O2 two rounds + a final contract fix). Shipped: `packages/protocol/src/rpc.ts` contract (methods `engine.hello`, `sessions.list`, `events.subscribe`, `events.unsubscribe`; notifications `events.event`, `events.resync_required` with reasons `log_replaced`/`io_error`/`slow_consumer` resumable and `unreadable_log` terminal; `RPC_MAX_FRAME_CHARS` 1 MiB), `RpcServer`/`RpcConnection` (zod-validated params and results, JSON-RPC error codes, no batches, paths scrubbed from internal errors, serialized writer = backpressure), `SessionTail` (reads `events.ndjson` from a committed offset in 64 KiB chunks, never buffers more than a chunk for a slow client, never locks or repairs the log), in-process + stdio NDJSON transports, browser-safe `RpcClient` (`packages/engine/src/rpc/browser.ts`) with `subscribeEvents`, `onClose`/`onDisconnect`. Remaining for full T04-02: write methods, typed client generation, move to `packages/engine` in T04-01.

**Deliverables**
1. `RpcServer` with a typed method registry (`method name → zod params/result → handler`) in `packages/engine/src/rpc/`.
2. Transports: in-process (CLI/TUI) and stdio (NDJSON framing; one JSON per line; stderr for logs only) — this is what the Tauri sidecar uses.
3. `events.subscribe(sessionId, fromSeq)` streaming via the EventLog + live tail; backpressure: per-subscriber bounded queue, drop-to-resync (`events.resync_required`) instead of unbounded memory.
4. Handshake `engine.hello → { engineVersion, protocolVersion, capabilities }`.
5. Typed client generator or hand-written typed client in `protocol` for UI use.
6. Handler registration helper + example + README so H tasks (T04-04) only write handlers.

**Acceptance** — conformance tests (invalid JSON, unknown method, schema errors → JSON-RPC error codes), resubscribe gap-free, slow subscriber triggers resync not OOM.

---

### T04-03 · WebSocket transport (`serve`) security
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** M · **Depends:** T04-02

**Status: 🔶 watch-only cut done as T04-03p** (`packages/engine/src/serve/`, `assentor serve`; planner, O2 two rounds with attack scripts, user signed off). Shipped: 127.0.0.1 bind (non-loopback needs `--unsafe-listen` + warning); Host check on every request and Origin check on every upgrade (DNS rebinding, `Origin: null` refused); 256-bit token in the URL fragment, sent as the first WebSocket frame (≤ 512 bytes, text) within 5 s, sha256 + `timingSafeEqual`, never logged; per-socket state so frames after a rejection are ignored, rejected sockets terminated; 5 failures/min → 60 s block per address (on loopback that is every local process — documented); 8 connections; `maxPayload` = `RPC_MAX_FRAME_CHARS`; `closeTimeout` 2 s; sends resolve on `ws.send` callback, a full buffer or a 30 s send sheds the client (`slow_consumer`, then terminate); ping/pong; idle shutdown counting authenticated clients; static UI from `packages/ui/dist` only (realpath containment, no dotfiles) with CSP, nosniff, no-referrer, COOP/CORP, no-store; `sessions.list` single-flight 1 s cache. Not done: keys RPC handlers and any write methods (watch-only), LAN use under `--unsafe-listen --host 0.0.0.0`.

**Write gate (T04-03, built 2026-10-31):** `assentor serve --allow-write` (default off; refused with `--unsafe-listen` or a non-loopback host). A connection gets writes only if it also opts in with `{"auth":"<token>","write":true}` after the Host/Origin checks and from a loopback peer; reply `{"auth":"ok","write":<granted>}`. Writes share a 30 / 10 s limit (`-32003 RateLimited`) and each appends an `rpc.write` audit line (method only) before the handler runs; a failed append refuses it. `engine.hello` lists write methods only on connections granted writes (T04-02 `connection.methodNames`; tested in serve.test.ts). Still open: keys RPC handlers.

**Deliverables** — `assentor serve [--port]`: bind `127.0.0.1` only (refuse `0.0.0.0` unless `--unsafe-listen` + warning); random 256-bit token required on connect; strict `Origin` allow-list (served UI origin only); no CORS wildcard; static UI served from the same origin with CSP; token passed to the browser via URL fragment (not query) and exchanged once; idle shutdown option; rate limiting on auth failures. Also owns the `keys.list/add/delete/check` RPC handlers (Danger #4): secrets are write-only over RPC — `list` returns `{ id, provider, name, healthy }` only.

**Acceptance** — tests: wrong token, missing token, foreign Origin, DNS-rebinding Host header, `0.0.0.0` refusal, token not logged.

---

### T04-04 · RPC handlers: prompts / teams / playbooks / settings
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-02

**Status: ✅ preview cut T04-04p done** (`e6107b4` + `793aaf4`, Haiku #2; Sonnet NEEDS_WORK → fixed). Read-only methods in `packages/engine/src/rpc/library.ts`: `prompt.list`, `prompt.get`, `team.list` (config teams expanded to seats, plus the legacy review team when `modes.review` is unset; config errors → `InvalidRequest "Config problem: …"`, paths scrubbed; never `keyId`), `models.catalog` (a `readOnly` `CliModelCatalog`: reads the cache only, never backs up, discovers or writes). Not in this cut: `prompt.save/fork/preview/validate`, `team.save/delete/validate`, playbooks, `settings.*`, `env.*` (writes or process spawns).

**Goal** — Expose existing library/config functions over RPC.

**Context to read** — `packages/engine/src/rpc/README.md` + example handler (T04-02), `PromptLibrary` (T03-01), `packages/engine/src/config/load.ts` (`loadAssentorConfig`, `saveAssentorConfig`), `packages/engine/src/config/teams.ts`, playbook loader (T03-04), `packages/engine/src/services/app.ts` (`runFullDiagnostics`, `detectExecutors`).

**Allowed files** — create: `packages/engine/src/rpc/handlers/{prompts,teams,playbooks,settings,env}.ts`, matching tests; modify: `packages/engine/src/rpc/handlers/index.ts` (register) and `packages/protocol/src/rpc.ts` (add param/result schemas for these methods only).

**Spec** — methods (params/results as zod in `protocol`):
- `prompt.list`, `prompt.get`, `prompt.save` (user/project scope; refuses `builtin`), `prompt.fork`, `prompt.preview` (render with given vars; returns text or missing vars), `prompt.validate`
- `team.list`, `team.save`, `team.delete` (refuse if referenced by `modes`; error lists references), `team.validate`
- `playbook.list`, `playbook.get`
- `settings.get` (**never** includes secrets; keys appear as `{ id, provider, name, healthy }` only), `settings.save` (non-secret fields)
- `env.doctor`, `env.detectClis`, `models.catalog`, `models.discover` (T01-01)

**Acceptance / Tests** — one test per method via in-process transport; `settings.get` snapshot contains no `secret` field; `prompt.save` to builtin rejected; `team.delete` reference error.

---

### T04-05 · RPC handlers: sessions / seats / worktrees
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T04-02, T02-09

**Deliverables** — `session.create/start/pause/resume/cancel/list/get/approve/export`, `seat.setModel/inject/stop/restart`, `worktree.diff/apply/discard` delegating to `SessionRunner`, `WorktreeManager`; `apply`/`discard` require an explicit `confirm: true` param; all path params validated against project root.

**Reviewer focus** — no path traversal; destructive ops gated; cancellation semantics.

---

### T04-06 · UI scaffold, Transport interface, event store
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T04-02

**Status: ✅ preview cut T04-06p done** (`837c386` + review fixes; Opus review NEEDS_WORK → fixed → PASS). Review fixes: `EngineController` serializes resubscribes (A→B→A can't leak a server subscription), tracks and clears the resync timer, and only starts the `sessions.list` poller on a live client; the frame batcher appends in place, applies at once past 1,000 pending events and uses a timer while the tab is hidden; the build no longer ships a source map. Full T04-06 (Router/Query/Virtual, transport contract suite, other sections) is still open. Earlier note: `packages/ui/` (Vite 7 + React 18 + TS + Zustand, plain CSS with light/dark/system; Tailwind left out — v4 needs a plugin package not on the approved list). `connectWebSocket` (token handshake), `takeToken` (fragment → sessionStorage, stripped from the URL), `createEngineStore` + `createFrameBatcher` (one apply per animation frame, `reduceSeatEvents` shared with the TUI), `EngineController` (hello, `sessions.list` refresh, one subscription for the selected session, reconnect with backoff, resubscribe from `lastSeq`, `unreadable_log` terminal, `io_error` with backoff), app shell (header, session list, placeholder seat list for T04-07p). Engine code is imported only through `@engine/…` browser-safe modules. Tests: store replay = identical state, 6×50 burst in one frame, controller against the real engine (reconnect without gaps, auth rejection stops retries), App shell, token handling. `pnpm build` now also builds `packages/ui/dist`; `pnpm typecheck` checks `packages/ui/` (app without Node types, tests with). Verified by hand: `assentor serve` on a mock run shows the run and its seats live. Not done: Router/Query/Radix/Virtual, transport contract suite, `/dev/fixtures` page, Prompts/Teams/Playbooks/Settings sections.

**Deliverables**
1. `packages/ui`: Vite + React 18 + TS, TanStack Router + Query, Zustand, Tailwind + Radix primitives, TanStack Virtual, Vitest + Testing Library.
2. `Transport` interface (`call`, `subscribe`, `onStatus`) + `WebSocketTransport`; `useRpc()` hook.
3. Event store: per-session `events` reducer reusing `reduceSeatEvents` (T01-06) + negotiation/review reducers; tracks `lastSeq`; auto-resubscribe on reconnect; handles `events.resync_required`.
4. Frame batching: apply incoming events in `requestAnimationFrame`.
5. App shell: sidebar (Sessions, Prompts, Teams, Playbooks, Settings), header with connection status, theme toggle (light/dark/system), toasts, empty states.
6. `packages/ui/README.md` documenting folder conventions, selectors, `useRpc`, test helpers (`renderWithStore`, `mockTransport`, event fixtures) — the H tasks depend on this.
7. Shared **transport contract test suite** (`packages/ui/src/transport/contract.test-suite.ts`) any `Transport` implementation must pass (reused by T05-09).
8. Fixture generator: `fixtures/session-negotiate-review.ndjson` (realistic event stream) used by screen tests and Storybook-like dev page `/dev/fixtures`.

**Acceptance** — reload mid-stream reconstructs identical state from fixture; 6 seats × 50 events/s fixture renders without dropped events.

---

### T04-07 · Session board + SeatCard
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-06

**Status: ✅ preview cut T04-07p done** (`0e4ffe8`, Haiku #1's last card; Sonnet review PASS; planner added in the merge: group titles are `<h2>` and light-mode `--warn` is darkened to #8f5f00 for contrast). `packages/ui/src/features/session-board/` (`SessionBoard`, `SeatCard`, `useNow`) + `packages/ui/src/store/selectors.ts`; groups executor / reviewers (`reviewer-*`, `panel`) / others; one 1 s ticker per board that stops when no seat is live; only `thinking` animates, under reduced-motion. Read-only: no model picker, pause/cancel, budget bar or drawer; no stage rail (stages aren't modelled). Follow-ups: CSS-path test via `import.meta.url`, `React.memo` on `SeatCard`, tests for ticker restart and the "other" group.

**Context to read** — `packages/ui/README.md`, store selectors `selectSession`, `selectSeats`, `selectStages`, `@assentor/ui-shared/status`, fixture `session-negotiate-review.ndjson`, plan §4.6 "Session board".

**Allowed files** — create under `packages/ui/src/features/session-board/`: `SessionBoard.tsx`, `SeatCard.tsx`, `StageRail.tsx`, `ModelPicker.tsx`, tests; modify: route file for `/sessions/$id` only.

**Spec**
1. `StageRail`: stages in order with status (`✓ done`, `● running`, `○ pending`, `✗ failed`) and labels.
2. `SessionBoard`: responsive grid (1 col < 640px, 2 cols < 1024px, 3+ above) of `SeatCard`, grouped by stage role (negotiators / executors / reviewers) with group headers.
3. `SeatCard`: provider name + icon, `displayName`, `ModelPicker` (catalog from `models.catalog`; selecting calls `seat.setModel`; shows "applies after current turn" with an "Apply now" button → `seat.setModel({ immediate: true })` after a confirm dialog), role, status icon + label (animated only for `thinking`, disabled under reduced motion), last output line (monospace, 1 line, ellipsis), elapsed (ticks every second), tokens in/out, cost if known. Click opens the Seat drawer (route param `?seat=<id>`).
4. Header: session title, overall status, budget bar (used/limit with warning colour ≥ 80%), Pause/Resume, Cancel (confirm dialog).

**Tests** — renders fixture: correct number of cards and groups; status change event updates only that card (assert via render count helper from README); model change calls RPC with right params; reduced-motion disables animation class.

---

### T04-08 · Seat drawer
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-06 · **New deps:** `@xterm/xterm`

**Status: ✅ preview cut T04-08p done** (`15ae1c1` + `3e901df`, Haiku #3; Sonnet NEEDS_WORK → fixed). Read-only drawer in `packages/ui/src/features/seat-drawer/`: a seat card (role=button, Enter/Space) opens a non-modal `role=dialog` with tabs Activity (seat's status/tool/done/error/retry/model/verdict events), Output (`outputTail` as text, follows the tail, "Jump to latest") and Info (provider/transport/permissions from `seat.spawned`, times, tokens, ids). Store gains `seatInfo` and `seatEvents` (only `ACTIVITY_EVENT_TYPES`, last 200 per seat). Escape/close restore focus. Not in this cut: pause/stop/restart/inject, Files tab, xterm.

**Allowed files** — `packages/ui/src/features/seat-drawer/*`, its tests.

**Spec**
1. Right-side drawer (full-screen on mobile) with tabs: **Transcript** (structured: messages, tool calls with name + summarized args + file links), **Raw output** (xterm.js read-only, ANSI colours, follows tail unless user scrolled up; "Jump to latest" button), **Files** (files touched + per-file diff link to T04-11), **Info** (provider, model, transport, permissions, worktree path, session id, tokens/cost).
2. Actions: Pause/Resume seat, Stop (confirm), Restart turn (confirm), **Inject message** textarea (Enter sends, Shift+Enter newline) → `seat.inject`.
3. Transcript list virtualized; xterm disposed on unmount.

**Tests** — tab switching; inject sends RPC and clears textarea; stop requires confirm; xterm disposed on unmount (mock).

---

### T04-09 · Negotiation view
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-06

**Status: ✅ preview cut T04-09p done** (`2afd858` + `186ff94`, Haiku; Sonnet review PASS with should-fixes → fixed; merged 2026-10-31). Watch-only, in `packages/ui/src/features/negotiation/`: round tabs, proposals A/B/… side by side, critique threads with citation chips, vote table with Borda totals recomputed per ballot, consensus meter, decision / leading-proposal card, dissent from `seat.error` in negotiate stages only. Gaps that need engine events: proposal authors (`negotiation.proposal` has no seatId), the consensus threshold, the decision rationale and invalid ballots. Store keeps the last 1,000 negotiation events per session.

**Allowed files** — `packages/ui/src/features/negotiation/*`, tests.

**Spec**
1. Round tabs (Round 1…N).
2. Proposals side by side (horizontal scroll on narrow screens), labelled `Proposal A/B/…`; toggle "Reveal authors" (off by default) shows seat names.
3. Critique threads under each proposal (author, evidence citations as chips).
4. Vote tally table (per-seat rankings, Borda totals) when strategy = vote.
5. Consensus meter (0–100%) with threshold marker from session config; final decision card with rationale and **dissent** list highlighted with ⚑.

**Tests** — fixture renders rounds; reveal toggle; dissent visible; meter value matches event.

---

### T04-10 · Review view
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-06

**Status: ✅ preview cut T04-10p done** (`afd1882` + `4e3c050`, Haiku; Sonnet review PASS with should-fixes → fixed; merged 2026-10-31). Watch-only, in `packages/ui/src/features/review/`: reviewer seat rows, findings grouped by file in `rankCorrelatedFindings` order with severity filter (unknown severities kept, under "other") and an "only disagreements" switch (disabled with a reason while agreement isn't recorded), decision banner. `rankCorrelatedFindings` and friends moved to Node-free `packages/engine/src/review/ranking.ts` (re-exported from coordinator.ts) so the UI can import them. Gaps that need engine events: per-reviewer verdict and confidence, `review.finding` with agreement (no emitter yet), panel policy on `review.completed`, reviewer filter; no diff view to link files to.

**Allowed files** — `packages/ui/src/features/review/*`, tests.

**Spec**
1. Per-reviewer verdict row (status icon, seat, model, role, confidence).
2. Findings grouped by file then severity using `rankCorrelatedFindings` order; each shows agreement `3/4` badge, description, evidence, required change; filter by severity/reviewer; "only disagreements" toggle.
3. Final decision banner with policy used (e.g., "security-veto").
4. Clicking a file opens the diff view at that file.

**Tests** — grouping and ordering; filters; agreement badge text.

---

### T04-11 · Diff & worktrees view
**Tier:** 🟢 H · **Review:** S, plus O for apply/discard flow · **Size:** M · **Depends:** T04-06 · **New deps:** `@monaco-editor/react` (lazy-loaded)

**Allowed files** — `packages/ui/src/features/diff/*`, tests.

**Spec**
1. List of worktrees (seat, branch, files changed, gates status).
2. Side-by-side Monaco diff (lazy import; fallback plain unified diff while loading or on load error).
3. Compare mode: pick two candidates (best-of-N) and diff them against each other.
4. Apply / Discard buttons → confirmation dialog that names the target and lists files → RPC with `confirm: true`. Buttons disabled while the session is running a stage that uses that worktree.

**Tests** — dialogs require confirmation; RPC params; fallback renders when Monaco import rejects.

---

### T04-12 · Prompts / Teams / Playbooks editors
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-06 · **New deps:** `@codemirror/*` (markdown, yaml)

**Allowed files** — `packages/ui/src/features/{prompts,teams,playbooks}/*`, tests.

**Spec**
1. Prompts: list with source badges; CodeMirror editor for body + form for front-matter; variable preview panel (fill sample values → `prompt.preview`); Fork, Save (user/project), Reset to built-in; validation errors inline.
2. Teams: table of seats (provider, transport, model picker, role picker from prompts, count stepper 1–8, permissions); live expanded seat names preview (`Opus#1..3`); cost estimate from `estimateSession` (via RPC if exposed, else hide).
3. Playbooks: read-only stage graph view (vertical list with arrows) + "Use playbook" → `session.create`.
4. Unsaved-changes guard on navigation.

**Tests** — fork/save flows; count bounds; unsaved guard.

---

### T04-13 · Settings, Doctor, Onboarding
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-06

**Allowed files** — `packages/ui/src/features/{settings,onboarding}/*`, tests.

**Spec**
1. Settings: CLIs detected (path, version, auth status, "how to log in" command copy button), API keys (list/health only; add/delete via the `keys.*` RPCs from T04-03 — never display secrets after save), budgets & concurrency, theme.
2. Doctor: run `env.doctor`, show ✓/✗ items with fix hints.
3. Onboarding (first run): steps Detect CLIs → Keys (optional) → Pick a playbook → Done. Skippable; stored flag via `settings.save`.

**Tests** — secrets never rendered (assert no input has the saved value after save); onboarding skip persists.

---

### T04-14 · Command palette + keyboard map
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T04-06

**Status: ✅ preview cut T04-14p done** (`df59587` + `dcd69d4`, Haiku; Sonnet review NEEDS_WORK (IME Enter, focus leak) → fixed → PASS; merged 2026-10-31). Watch-only, `packages/ui/src/features/palette/` + `packages/ui/src/keymap.ts`: Ctrl/⌘+K palette (combobox + listbox, IME-safe, focus kept inside, max 50 results) over sessions, recent sessions (in memory) and the views on screen; write actions (`/model`, `/pause`, `/inject`, `/approve`) listed disabled with the reason; `?` keyboard map; ⌘ on macOS, Ctrl elsewhere. Left for the full card: working write actions (need write RPCs), prompts navigation (no prompts view yet), persisted recents.

**Allowed files** — `packages/ui/src/features/palette/*`, `packages/ui/src/keymap.ts`, tests.

**Spec** — `Ctrl/Cmd+K` palette with fuzzy search over: navigate (sessions, prompts…), actions on focused session (`/model <seat> <model>`, `/pause`, `/inject <seat> …`, `/approve`), recent sessions. Keyboard map shown in a `?` help dialog. Platform-aware labels (⌘ on macOS, Ctrl elsewhere).

**Tests** — open/close, fuzzy match, `/model` parses and calls RPC, platform label.

---

### T04-15 · `assentor app` launcher
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T04-03

**Status: ✅ done** (`3b6b113`, Haiku #2; Sonnet review PASS). Files are `packages/cli/src/cli/app.ts` + `tests/unit/cli-app.test.ts`. `assentor app [-p] [--port] [--no-open]` starts `startServe` on port 0 (loopback only), prints the same lines as `serve`, and opens the browser with a pure `browserOpenCommand(platform, url)` (darwin `open`, win32 `cmd /c start ""`, else `xdg-open`), spawned without a shell, detached and unref'd; URLs not matching `^http://127\.0\.0\.1:\d+/(#token=[0-9a-f]+)?$` are refused. Follow-ups done in `f319195` (signal listeners removed after close, `.catch` on `handle.close()`, `--port` validated 0–65535, `runApp` SIGTERM test).

**Allowed files** — `packages/cli/src/cli/app.ts`, register in CLI index, tests.

**Spec**
1. `assentor app [--project <path>] [--no-open] [--port <n>]` starts `serve` (T04-03 API) and prints the URL.
2. Opens the browser cross-platform without a dependency: macOS `open <url>`, Windows `cmd /c start "" "<url>"`, Linux `xdg-open <url>`; use `spawn` with args array (no shell string except the Windows `cmd` form), `detached`, `stdio: "ignore"`, `unref()`. If opening fails, just print the URL.
3. Ctrl+C stops the server gracefully.

**Tests** — opener command chosen per platform (inject platform); `--no-open` doesn't spawn; URL contains token only in the fragment (`#token=`).

---

### T04-16 · Mode picker (new session)
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T04-06, T02B-01, T02B-08

**Allowed files** — `packages/ui/src/features/mode-picker/*`, tests; modify: the new-session route only.

**Spec**
1. Grid of mode cards from `modes.list` RPC: title, one-line description, static/dynamic badge, "edits code" badge, recommended team.
2. Goal textarea; "Suggest" button calls `modes.suggest` (T02B-08 via RPC) and highlights the suggested card with its reasons and alternatives.
3. Autonomy segmented control (Manual / Supervised / Autopilot) with a one-line explanation of each; Autopilot shows a warning when the mode edits code.
4. Team picker + cost estimate (T02-10) before "Start".

**Tests** — suggestion highlight, autonomy warning, start sends `session.create` with mode, autonomy and team.

---

### T04-17 · Lead team board view
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T04-06, T02B-18

**Allowed files** — `packages/ui/src/features/lead-board/*`, tests.

**Spec**
1. Kanban columns from the shared reducer in `@assentor/ui-shared/lead` (T02B-18): Backlog / Assigned / In progress / In review / Accepted / Rejected; cards show task title, owner seat (status icon + model), reassign/escalation counters.
2. **Lead log** panel: every `lead.action` with reason and ✓/✗ validation result; filter to refused actions.
3. **Org chart**: lead node → seat nodes with live status icons (simple vertical tree, no graph library).
4. Controls: approve integration (confirm dialog listing tasks/files), override assignment (pick seat/model → RPC), pin a model for a task, pause/resume lead.
5. Clicking a card opens that task's reports and the owner's Seat drawer.

**Tests** — columns from fixture stream; refused-actions filter; approve requires confirm; override sends RPC.

**Status: preview cut T04-17p** (watch-only, branch `claude/card-t04-17p`). Points 1, 2, 3 and the seat-drawer part of 5 are in `packages/ui/src/features/lead-board/` (`LeadBoard`, `LeadOrgChart`, `LeadLog`), shown for a run whose `mode.selected` is `lead`. Shared reducer (`packages/ui-shared/src/lead.ts`) extended, not forked: six web stages (`leadStages`: Backlog, Assigned, In progress, In review, Accepted, Rejected), owner seat id, reassign and escalation counters, and `actions` (every lead action; `log` stays the terminal's last five). The refused-only switch is a native checkbox with `role="switch"`. Not in this cut: point 4 (approve, override, pin, pause/resume; the server has no write RPCs) and the task's reports in point 5.
