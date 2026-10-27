# Phase 0 — Foundations

Goal of the phase: introduce seats, teams and seat-scoped events **without changing any existing behavior**. After Phase 0, `assentor run` with an old config behaves exactly as v0.3.19.

Phase exit criteria:
- [ ] All existing tests green on ubuntu, macOS, Windows (T00-08).
- [ ] Old configs (no `teams`) produce identical runs; snapshot test in T00-02.
- [ ] Every supervisor event also exists as a seat-scoped event in `.assentor/sessions/<id>/events.ndjson`.

---

### T00-01 · Seat / Team / Session contract + event envelope
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** M · **Depends:** —

**Goal** — Define the shared types every later task builds on. Contract only: types, zod schemas, doc comments, tiny pure helpers. No runtime wiring.

**Context to read**
- `docs/plans/app-and-multi-model.md` §3, §4.6
- `docs/plans/desktop-app-system-design.md` §4
- `src/orchestrator/supervisor.ts:83-170` (current `SupervisorEvent`)
- `src/protocol/messages.ts`, `src/config/schema.ts`, `src/executors/providers.ts`, `src/review/backends.ts`

**Allowed files**
- create: `src/core/seats.ts`, `src/protocol/events.ts`, `tests/unit/seat-contract.test.ts`
- modify: `src/core/index.ts`, `src/protocol/index.ts`, `src/index.ts` (exports only)

**Deliverables**
1. `SeatProvider` — union of CLI providers (`claude-code`, `codex`, `antigravity`, `cursor`, `qwen`, `opencode`, `mock`) and API providers (`gemini`, `openai`), with `transport: "cli" | "api"` and a validator for allowed combinations (reuse `transportsForProvider` semantics).
2. `SeatRole` (string id referencing a prompt; built-ins enumerated as constants, user ids allowed).
3. `SeatPermissions = "read-only" | "edit"`.
4. `SeatSpecSchema` (config shape: provider, transport, model, role, promptRef?, count 1–8, permissions, name?, budget?) and `Seat` (runtime: `id`, `displayName` e.g. `Opus#2`, resolved fields, `worktreePath?`, `sessionId?`).
5. `TeamSchema`, `StageKind = "plan" | "negotiate" | "execute" | "review"`, `StageSpec`, `SessionSpec` (types only; runner comes in T02-09).
6. `expandSeatSpecs(specs): Seat[]` — deterministic ids and display names (`<ModelShort>#<n>`; collision-free across providers).
7. `SeatStatus` enum: `queued | starting | thinking | writing | tool | editing | waiting | rate_limited | done | failed | dissent`.
8. `EngineEvent` envelope `{ seq, sessionId, seatId?, stageId?, at, type, data }` + zod schema + `EngineEventType` catalog (plan §4.6) with a typed `data` map per type.
9. `fromSupervisorEvent(event, ctx): EngineEventDraft` mapping for every existing `SupervisorEventType` (used by T00-07).

**Status: ✅ done.** Shipped as `src/core/seats.ts`, `src/protocol/events.ts`, `src/orchestrator/engine-events.ts`, `tests/unit/seat-contract.test.ts`. Decisions:
- The mapping lives in `src/orchestrator/engine-events.ts` (not `protocol/`), so the protocol layer has no engine imports (needed for the T04-01 split).
- Producers create `EngineEventDraft` (no `seq`, optional `at`); only the event log assigns `seq`.
- `SeatSpec.transport` is optional (provider default applied in `expandSeatSpecs`); `permissions` defaults to `read-only`; `role` defaults to `general`.
- Display names are always numbered (`Opus#1` even when count is 1); ids are path-safe slugs (`opus-1`, or `<team>.opus-1` with a team prefix).
- Legacy events keep all their fields and add `data.legacyType`.

**Constraints**
- No behavior change; nothing imports these from existing runtime code yet.
- Keep `data` payloads JSON-serializable; no class instances.
- Document every exported type — Haiku tasks will implement against these comments.

**Acceptance**
- [ ] Types exported from `src/index.ts`.
- [ ] `expandSeatSpecs` tested: counts, naming, mixed providers, determinism.
- [ ] Every `SupervisorEventType` has a mapping (exhaustiveness checked at compile time).
- [ ] Event schema round-trips through JSON.

---

### T00-02 · Config schema: `teams`, `modes`, legacy mapping
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T00-01

**Status: ✅ done.** Shipped in `3bf3337` with fixes in `5ae96a6` (`src/config/teams.ts`, `src/config/schema.ts`, `tests/unit/config-teams.test.ts`). Re-review passed. Decisions:
- Legacy `gemini` reviewers on `cli` map to `antigravity`, as v0.3.19 ran them.
- An unsupported legacy transport throws a readable error naming the reviewer index and supported transport; no coercion.
- `modes.negotiate.team` is validated in `resolveTeams` as well as `modes.review.team`.
- Review mode uses `policy`, not `strategy`; the plan §3 example was corrected to match `ReviewModeSchema` (`08b8aff`).

**Goal** — Users can declare teams in config. Configs without teams keep working exactly as before by being mapped to equivalent teams.

**Context to read**
- `src/config/schema.ts` (whole file)
- `src/config/load.ts:48-135` (`mergeConfigLayers`, `loadAssentorConfig`)
- `src/core/seats.ts` (from T00-01: `SeatSpecSchema`, `TeamSchema`)
- `tests/unit/cli-config.test.ts` (test style)

**Allowed files**
- modify: `src/config/schema.ts`, `src/config/index.ts` if it exists (exports)
- create: `src/config/teams.ts`, `tests/unit/config-teams.test.ts`

**Spec**
1. In `AssentorConfigSchema` add, after `reviewers`:
   - `teams: z.record(z.string().min(1), TeamSchema).default({})`
   - `modes: z.object({ negotiate: NegotiateModeSchema.optional(), review: ReviewModeSchema.optional() }).default({})`
   where (define in `src/config/teams.ts`):
   - `NegotiateModeSchema = { team: string, strategy: "debate"|"vote"|"best-of-n"|"synthesize"|"divide" default "debate", maxRounds: int 1–10 default 3, consensus: number 0–1 default 0.7 }`
   - `ReviewModeSchema = { team: string, policy: "majority"|"unanimous"|"weighted"|"security-veto"|"adjudicator" default "security-veto", tiebreak: "adjudicator"|"negotiate" default "adjudicator" }`
2. Create `resolveTeams(config): { executor: Team; review: Team }` in `src/config/teams.ts`:
   - If `config.modes.review?.team` is set and exists in `config.teams` → use it for `review`.
   - Otherwise build the review team from `config.reviewers` (one seat per entry, `count: 1`, `permissions: "read-only"`, keep `provider`, `transport`, `model`, `role`, `name`).
   - Executor team: always one seat from `config.executor.provider`, `permissions: "edit"`, `role: "engineer"`.
3. If a mode references a team name that doesn't exist → throw `Error` with message: `Unknown team "<name>" in modes.<mode>. Defined teams: <list or "(none)">`.
4. Do **not** change any existing default or field.

**Acceptance**
- [ ] `parseAssentorConfig({})` output equals the v0.3.19 output plus `teams: {}` and `modes: {}` only.
- [ ] Legacy config with 2 reviewers → review team with 2 read-only seats, same providers/transports/models.
- [ ] Teams with `count: 3` validate; `count: 0` and `count: 9` fail.
- [ ] Unknown team reference throws the exact message.

**Tests** (`tests/unit/config-teams.test.ts`)
- default config shape (no teams) unchanged except new keys
- legacy reviewers → review team mapping
- explicit team used by `modes.review`
- the YAML example from plan §3 parses (paste it as a string, parse with `yaml`)
- invalid counts; unknown team error message

**Out of scope** — using teams at runtime (T01-02), TUI editing, saving teams.

**Escalate if** — `TeamSchema` from T00-01 is missing a field this spec needs, or `mergeConfigLayers` merges records in a way that would merge two teams with the same name field-by-field (ask whether project teams should replace user teams wholesale).

---

### T00-03 · Model flag for CLI executor recipes
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** —

**Status: ✅ done.** Shipped in `02ef4c1` + `4e12bc8`. Sonnet review PASS, no required changes. Decisions:
- `src/executors/adapters.ts` was added to Allowed files mid-task (the registry builder lives there); only the `model` field and its forwarding changed.
- Precedence: `--executor-model` flag > `config.executor.model` > unset, on both run and resume, via exported `resolveExecutorModel`. Values are trimmed; a blank flag falls back to config; an explicit `AUTO` flag overrides config and passes no model flag.
- Permission/unattended flags unchanged and still first. Follow-ups: a `continue()` model test and a `createExecutor("cursor")` model test — ✅ done in FU-01 (`4f71d0b`).

**Goal** — Executors launched through CLIs can be told which model to use.

**Verified flags (dev machine, 2026-10-24)** — `claude --model <m>`, `codex exec -m <m>` (also `--model`), `agy --model <m>`, `cursor agent --model <m>`. Qwen/OpenCode: **unverified** — leave `modelFlag` undefined for them.

**Context to read**
- `src/providers/executors/cli-print/recipes.ts` (whole)
- `src/providers/executors/cli-print/index.ts:60-200`
- `src/providers/executors/cursor/index.ts:55-110` and `:420-455` (`buildArgs`)
- `src/executors/registry.ts` (`buildExecutorRegistry`)
- `src/cli/commands.ts:67-110` (`createExecutor`), `src/cli/index.ts:69-135` (`run` command)
- `tests/unit/print-cli-executor.test.ts`, `tests/unit/cursor-spawn.test.ts`

**Allowed files**
- modify: `recipes.ts`, `cli-print/index.ts`, `cursor/index.ts` (only `CursorExecutorOptions` + `buildArgs`), `src/executors/registry.ts`, `src/executors/adapters.ts` (only `ExecutorRuntimeOptions.model` and forwarding it through the adapter constructors / `buildExecutorRegistry` — added after Haiku's escalation; the original card missed that the registry builder lives here), `src/cli/commands.ts` (only `createExecutor` options + its call sites in `runRun`/resume), `src/cli/index.ts` (only `run`/`resume` options), `src/config/schema.ts` (only `executor` object)
- modify tests: `tests/unit/print-cli-executor.test.ts`, `tests/unit/cursor-spawn.test.ts`

**Spec**
1. `PrintCliRecipe.modelFlag?: string`. Set `"--model"` for `claude-code`, `antigravity`; `"-m"` for `codex`. Leave `qwen`, `opencode` unset.
2. `buildPrintCliArgs(recipe, prompt, { …, model?: string })`: when `model` is a non-empty string, not `"AUTO"`, and `recipe.modelFlag` is set:
   - attached style: push `[modelFlag, model]` right before `-p=<prompt>`
   - positional style: push `[modelFlag, model]` right before the prompt (after `printArgs` and format args) — for codex this lands after `exec`, which is required.
   - when `model` is set but `modelFlag` is not → do **not** add args; return normally (caller warns, see 4).
3. `PrintCliExecutorOptions.model?: string` stored and passed to `buildPrintCliArgs` on both `run` and `continue`.
4. If a model was requested but the recipe has no `modelFlag`, call `onStatus?.({ activity: "warning", detail: "<name> does not support model selection; using CLI default" })` once.
5. Cursor: `CursorExecutorOptions.model?: string`; in `buildArgs`, push `"--model", model` immediately before `...this.extraArgs` when set and not `"AUTO"`.
6. Config: `executor.model: z.string().optional()`. CLI: `assentor run --executor-model <model>` and the same on `resume`; flag overrides config. Thread through `createExecutor(..., { model })` → registry → adapter.

**Acceptance**
- [ ] `claude-code` args contain `--model opus` before the prompt; prompt is still last.
- [ ] `codex` args are `[...unattended, "exec", "--skip-git-repo-check", "-m", "<m>", prompt]`.
- [ ] `antigravity` args contain `--model <m>` before `-p=<prompt>`.
- [ ] `AUTO`, empty string, undefined → no model flag.
- [ ] No-flag recipe + model → warning emitted once, args unchanged.
- [ ] Existing tests pass unchanged.

**Tests** — add cases for each bullet above to the two existing test files.

**Out of scope** — reviewer side (T00-04), model catalogs (T01-01), switching models mid-run (T01-05).

**Escalate if** — any existing test asserts exact arg arrays that your change breaks for the *no-model* case (that means placement is wrong).

---

### T00-04 · Pass `model` through CLI reviewers (bug fix)
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** —

**Status: ✅ done.** Shipped in `932bc38` + `ec249d0`. Sonnet review PASS, no required changes; planner mutation check confirmed the three leak tests fail without the fix. Decisions:
- CLI-transport reviewers use only an explicitly configured model (`backend.model`, `fallback.model`); they never inherit `models.default/gemini/openai`. API reviewers unchanged.
- A CLI fallback with no `fallback.model` passes `"AUTO"` (not undefined), because `createReviewer` does `fallback.model ?? options.model` and would otherwise inherit the primary's model.
- Blank/AUTO add no flag (shared `requestedModel` from `cli-print/recipes.ts`). An injected test transport ignores `model` (test-only path).

**Goal** — A reviewer configured as `{ provider: claude, transport: cli, model: opus }` actually runs Opus. Today `model` is silently dropped for CLI transport.

**Context to read**
- `src/cli/commands.ts:113-200` (`CreateReviewerOptions`, `createReviewer`, `createReviewerTransport`)
- `src/providers/reviewers/cli/index.ts` (whole; `buildCliArgs` at ~line 342)
- `tests/unit/cli-reviewer.test.ts`

**Allowed files**
- modify: `src/providers/reviewers/cli/index.ts`, `src/cli/commands.ts` (only `createReviewerTransport` CLI branch, plus — added after Haiku's escalation — the two reviewer-model resolution call sites so CLI reviewers never inherit `models.default/gemini/openai`), `tests/unit/cli-reviewer.test.ts`

**Spec**
1. Add `model?: string` to the `CliReviewer` constructor options; store it.
2. `buildCliArgs(adapter, prompt, extraArgs, context)` gains `context.model?: string`. When set and not `"AUTO"`:
   - `claude`: insert `"--model", model` after `"--output-format", "text"` and before `...extraArgs`.
   - `cursor`: insert `"--model", model` before `...extraArgs`.
   - `antigravity`: insert `"--model", model` before `...extraArgs`.
3. In `createReviewerTransport`, pass `model: options.model` into `new CliReviewer({...})`.
4. Do not change any other flag. Do not add permission/bypass flags.

**Acceptance**
- [ ] With `MockCliTransport`/captured spawn, args include `--model <m>` for each adapter.
- [ ] `AUTO`/undefined → identical args to today.
- [ ] Fallback reviewer path (`options.fallback.model`) also reaches the CLI reviewer.

**Tests** — extend `tests/unit/cli-reviewer.test.ts` with one case per adapter + AUTO + fallback.

**Out of scope** — adding a Codex reviewer adapter (T01-02).

**Escalate if** — the `CliTransport` abstraction hides args so tests can't observe them (then ask whether to expose `lastCommand` in tests — it exists on the default transport).

---

### T00-05 · Append-only session event log (NDJSON + seq)
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T00-01

**Status: ✅ done.** Shipped in `739cfa6` + `fb04270` (`src/events/log.ts`, `src/events/index.ts`, `sessionPaths` in `src/persistence/paths.ts`, `tests/unit/event-log.test.ts`). Sonnet review PASS; planner required a hardening round. Decisions:
- Single writer per session (one instance, one process); no file lock.
- Tail repair is in place (no temp files): an unterminated valid tail is kept and newline-terminated; an unterminated invalid tail is truncated at the byte offset after the last newline; a complete (newline-terminated) invalid line is never deleted — `open`/`readFrom` throw `Corrupt event log <file>: line N …` with the real file line number.
- A failed append marks the log for tail repair before the next append/read and recomputes `lastSeq` from disk. Delivery is at-least-once: if the write landed but the call threw, that event is kept.
- `append` rejects drafts for another session. `readFrom` re-reads the file (O(n)); add an index only if Phase 4 streaming needs it.

**Goal** — Persist every `EngineEvent` so sessions can be replayed and clients can resume from a sequence number.

**Context to read**
- `src/protocol/events.ts` (T00-01)
- `src/persistence/paths.ts` (`appendJsonl`, `readJsonl`, `ensureAssentorGitignored`, `writeJsonAtomic`)
- `tests/unit/persistence.test.ts`

**Allowed files**
- create: `src/events/log.ts`, `src/events/index.ts`, `tests/unit/event-log.test.ts`
- modify: `src/persistence/paths.ts` (add `sessionPaths(projectPath, sessionId)` only), `src/index.ts` (exports)

**Spec**
1. `sessionPaths(projectPath, sessionId)` → `{ root: .assentor/sessions/<id>, events: <root>/events.ndjson }`. Validate `sessionId` with `isId` from `src/core/ids.ts` (UUID); throw `Error("Invalid session id: <id>")` otherwise. New ids come from `createId()`.
2. `class EventLog`:
   - `static async open(projectPath, sessionId): Promise<EventLog>` — ensures directory + gitignore; reads existing file to recover `lastSeq` (0 if new).
   - `async append(event: EngineEventDraft): Promise<EngineEvent>` — assigns `seq = lastSeq + 1`, `at` default now (ISO), validates with `parseEngineEvent` (both from `src/protocol/events.ts`), appends one line, returns the full event. Appends are **serialized** (internal promise chain) so concurrent callers never interleave or reuse seq.
   - `async readFrom(fromSeq: number): Promise<EngineEvent[]>` — events with `seq > fromSeq`, in order.
   - `get lastSeq(): number`.
3. Tolerate a truncated final line (crash mid-write): skip it when reading, log nothing, and continue numbering after the last valid event.
4. Use `\n` line endings; parse lines with `trimEnd()` so CRLF files also read.

**Acceptance**
- [ ] 100 concurrent `append` calls → seq 1..100 with no gaps or duplicates, file has 100 valid lines.
- [ ] Reopen after writes → `lastSeq` correct; next append continues.
- [ ] Truncated last line ignored.
- [ ] `readFrom(n)` returns exactly the tail.

**Tests** — one per acceptance bullet, using a temp dir (`fs.mkdtemp(os.tmpdir())`), cleaned up in `afterEach`.

**Out of scope** — emitting events from the supervisor (T00-07), streaming to clients (Phase 4).

---

### T00-06 · Output-delta coalescer
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T00-01

**Status: ✅ done.** Shipped in `8d491d8` + `2973e0c`. Sonnet review PASS; planner required an error-routing round. Decisions:
- Timer-path emit errors (sync throws and rejected Promises) go to `onError` (default: one stderr line); nothing throws out of a timer callback. Explicit `push` overflow / `flush(seatId)` rethrow sync errors to the caller.
- `dispose()` is atomic: marks disposed, flushes every seat, clears all timers, then throws the first error or an `AggregateError`. `push` after dispose throws.
- `now` is accepted but unused (timer-driven); empty pushes are no-ops. Callers must pass an `onError` that does not throw (T00-07 does).

**Goal** — Batch high-frequency `seat.output.delta` text per seat into frames so UIs stay smooth.

**Context to read** — `src/protocol/events.ts` (T00-01), desktop design §4.2.

**Allowed files** — create: `src/events/coalescer.ts`, `tests/unit/event-coalescer.test.ts`; modify: `src/events/index.ts` (export) — if T00-05 hasn't landed, create `src/events/index.ts`.

**Spec**
1. `createDeltaCoalescer({ intervalMs = 40, maxChars = 8_192, emit, now?, setTimer?, clearTimer? })` returns `{ push(seatId, text), flush(seatId?), dispose() }`.
2. `push` appends text to that seat's buffer; schedules one timer per seat if none pending.
3. When the timer fires → `emit({ seatId, text })` with the concatenated buffer, buffer cleared.
4. If a seat's buffer exceeds `maxChars` → emit immediately (don't wait for the timer) and cancel its timer.
5. `flush(seatId)` emits that seat now; `flush()` emits all seats; empty buffers never emit.
6. `dispose()` flushes all and clears timers.
7. Inject `now/setTimer/clearTimer` for tests (default to globals); use `vi.useFakeTimers()` in tests.

**Acceptance / Tests**
- [ ] Two seats pushing interleaved text → separate emits, order preserved within a seat.
- [ ] Many pushes within interval → one emit.
- [ ] `maxChars` overflow → immediate emit.
- [ ] `flush`/`dispose` behavior; no emit for empty buffers; no timers left after dispose.

---

### T00-07 · Supervisor emits seat-scoped events
**Tier:** 🔴 O · **Review:** O2 · **Size:** M · **Depends:** T00-01, T00-05 (T00-06 optional)

**Status: ✅ done.** Shipped by the planner. O2 review: round 1 NEEDS_WORK (fixed), round 2 PASS; user signed off. Decisions:
- Instead of `onEngineEvent`/`eventLog`/`seats` on `SupervisorConfig`, one `SeatEventSink` (`src/orchestrator/seat-events.ts`) is passed as `seatEvents` + `seatScope`. It sequences events (via `EventLog` when given), batches output per seat with the coalescer, never throws, and reports its own failures once per kind. `RunSeatEvents` in `commands.ts` wires it for `run` and `resume`; `onEngineEvent` on both inputs gives live events (T01-06 uses it).
- Seats: `executor`, `reviewer-N` (wrapped by `trackReviewerSeat`), and `panel` when there is more than one reviewer; reviewer-scoped legacy events go to `panel`. Every seat is spawned before use. On resume `session.created` is skipped (log not empty) and seats are spawned again — consumers treat `seat.spawned` as insert-or-update.
- Only plain-text executors (codex, opencode, cursor with text output) forward raw stdout as `seat.output.delta`; their per-line "running" status becomes one `writing` status. A repeated identical `seat.status` is dropped together with its tool call (collapses cursor started/completed; two identical back-to-back tool calls count once — T02 budgets must count from the executor, not `seat.tool_call`).
- Mirrored legacy events keep all fields except `rawOutput`, replaced by `rawOutputChars`. Event data is redacted with `redactSecrets` when `security.redactSecrets` is on (per coalesced batch; a secret split across batches can slip — best effort).
- `Supervisor.run` waits at most 2 s for the sink to flush; `RunSeatEvents.close()` at most 5 s. Output kept per seat is capped at 2,000,000 chars with one `output_truncated` warning.
- Follow-ups: command-level test for a successful resume appending to the log; redact on line boundaries; legacy `events.jsonl` is still unredacted (pre-existing).

**Goal** — The existing supervisor run produces `EngineEvent`s with seat ids, persisted via `EventLog`, while the old `onEvent` callback and `RunReporter` keep working unchanged.

**Context to read** — `src/orchestrator/supervisor.ts` (whole), `src/cli/ui/reporter.ts`, `src/cli/commands.ts:460-720`, `src/providers/executors/cursor/stream-status.ts`, `src/providers/executors/cli-print/text-stream.ts`, T00-01 contract.

**Allowed files** — modify: `supervisor.ts`, `commands.ts` (wiring), executor/reviewer adapters only to surface existing status/output callbacks as seat events; create tests `tests/unit/supervisor-seat-events.test.ts`.

**Deliverables**
1. `SupervisorConfig.onEngineEvent?` + optional `eventLog?: EventLog` + `seats?: { executor: Seat; reviewers: Seat[] }` (default: derive single seats from adapter names).
2. Emit `seat.spawned/status/output.delta/tool_call/done/error` from existing executor `onOutput`/`onStatus` and stream-status parsing; reviewer seats from `PanelReviewer` member calls.
3. Every legacy `SupervisorEvent` also emitted via `fromSupervisorEvent` (`src/orchestrator/engine-events.ts`).
4. Persist through `EventLog` when provided; event emission must never throw into the supervisor loop (log and continue).
5. Resume: new events continue the same session log (`seq` keeps increasing).

**Acceptance**
- [ ] Mock executor + 2 mock reviewers run → ordered events with 3 distinct seat ids; legacy reporter output identical (snapshot).
- [ ] Event-log write failure doesn't fail the run.
- [ ] Resume appends to the same log.

**Reviewer focus** — no changes to round/budget/state-machine semantics; ordering guarantees; memory (no unbounded buffers).

---

### T00-09 · Config save must keep `teams`, `modes` and new fields
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** S · **Depends:** T00-02 (and T00-03 for `executor.model`)

**Status: ✅ done.** Shipped by the planner. O2 review PASS; user signed off. Decisions:
- `toSerializable` writes every parsed schema section generically (schema order; `project.path` forced to "."; undefined optionals omitted), so new schema fields are saved automatically. A test asserts every top-level schema key is written and a full round trip is exact.
- `saveAssentorConfig(..., { preserveFromExisting })` keeps listed sections from the file being overwritten; the TUI (`saveGlobalDefaults`) preserves `teams`/`modes` so project-only teams are not copied to `~/.assentor`. An unparseable target file makes the save throw without touching it.
- Follow-ups (pre-existing): the TUI still copies other merged project values (now incl. `executor.model`) to user scope; writes are not atomic; YAML comments/unknown keys are dropped on save.

**Goal** — Saving config from the TUI (`saveAssentorConfig` → `toSerializable` in `src/config/load.ts`) rebuilds the YAML from a fixed list of fields, so it **silently deletes** a user's `teams`, `modes` and (after T00-03) `executor.model`. Danger #10: user config rewrite.

**Deliverables**
1. `toSerializable` writes `teams`, `modes` and `executor.model` (only when set), in a stable order.
2. Round-trip test: parse → save → load yields an equal config for a file containing every schema section, so the next added field without a serializer change fails CI.
3. Saving at user scope must not copy project-only teams into `~/.assentor/config.yaml` (document what the TUI passes today and test it).

**Acceptance** — round-trip test green; a config with teams survives a TUI "Configure → Save".

---

### T00-08 · CI matrix: macOS + Windows + Linux
**Tier:** 🟡 S · **Review:** O · **Size:** S–M · **Depends:** —

**Status: ✅ done, not yet run on GitHub** (`2e8f870`, Sonnet; planner review PASS). `.github/workflows/ci.yml`: matrix ubuntu/macos/windows, `fail-fast: false`, git configured before checkout (`autocrlf false`, `eol lf`, CI identity), same gate on Node 24. Test-only Windows fixes: cli-locator path normalisation; chmod and symlink tests `skipIf(win32)` with reasons; serve traversal test keeps its non-symlink checks on Windows. Unverified until the first CI run: process-group kill tests (event-log-lock, process-tracker, cursor-spawn). Any product fix a Windows run reveals is a separate Danger-list card.

**Goal** — "Works on all OS" is enforced by CI.

**Context to read** — `.github/workflows/ci.yml`, `vitest.config.ts`, tests touching paths/processes (`cli-locator`, `process-tracker`, `cursor-spawn`, `persistence`, `git-artifacts`, `e2e-average`).

**Allowed files** — modify: `.github/workflows/ci.yml`; test files that fail only due to platform assumptions (fix the **test**, not product code). Product-code fixes → separate escalation (they may be Danger-list: process/paths).

**Spec**
1. `strategy.matrix.os: [ubuntu-latest, macos-latest, windows-latest]`, `fail-fast: false`.
2. Ensure git is configured in CI for tests that commit (`git config --global user.email/name`).
3. Windows: set `core.autocrlf false` before checkout; use `shell: bash` only where needed.
4. Keep Node 24 per existing comment.
5. Report per-OS failures in the PR with a short root-cause note each.

**Acceptance**
- [ ] Three green jobs, or failing jobs each have an escalation linked with root cause.
- [ ] No test skipped on an OS without a written reason in the test (`it.skipIf(process.platform === "win32")` + comment).
