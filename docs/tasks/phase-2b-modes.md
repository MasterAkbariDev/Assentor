# Phase 2b — Lead (Supervisor), Cascade & more modes

Design: [modes.md](../plans/modes.md). Phase 2b starts after Phase 2's runner (T02-09) and Phase 3's prompt loader (T03-01) land; the Lead/Cascade core does not need the rest of Phase 3.

Phase exit criteria:
- [ ] `assentor run --mode lead "…"`: a Lead seat plans a task board, hires seats from the roster, reads verified reports, escalates at least once, and integrates after approval (mock end-to-end test + one manual run with real CLIs).
- [ ] `assentor run --mode cascade "…"`: normal tasks start on the cheap tier; a task touching a danger area goes straight to the strong tier with approval.
- [ ] `--autonomy manual|supervised|autopilot` works with every mode; old `--mode supervised|autopilot` still works.
- [ ] Auto mode suggests a mode with reasons.

Order: **T02B-01 → (T02B-03, 04, 05, 08, 12, 17 in parallel for Haiku) → T02B-02 → T02B-06/07 → rest.**

---

### T02B-01 · Mode registry, controller contract, autonomy axis
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T02-09, T00-09

**Status: 🔶 type half done as T02B-01a** (planner; O2 NEEDS_WORK → fixed). `src/modes/lead/types.ts` (`TaskIdSchema` git-ref-safe, `OwnedPathSchema` repo-relative, `LeadTaskPlanSchema`/`LeadTaskSchema`, `TaskBoardSchema` (case-insensitive unique ids), `BoardOpSchema`, `AgentReportSchema`, `emptyTaskBoard`), `src/modes/roster.ts` (`CapabilityProfileSchema`, `ProviderAvailability`, `RosterStats`, `RosterScoreboard`, `RosterPolicySchema`, `RosterEntry`, `COST_TIERS`, `costRank`), `src/modes/controller.ts` (`ControllerActionSchema` — 14 actions, `SeatChoiceSchema` with `SeatRoleSchema` + `ModelIdSchema`, `ControllerTurnSchema` ≤ 20 actions, `ControllerContext`). Still to do: deliverables 1, 5, 6, 7 (mode registry, autonomy axis, `modes.<id>` config, new event types) after T02-09. Unblocks T02B-03, T02B-04, T02B-05, T02B-08.

**Goal** — The contract every mode builds on, plus the `mode` / `autonomy` split, without breaking existing flags or configs.

**Deliverables**
1. `src/modes/registry.ts`: `ModeDefinition { id, title, description, kind: "static" | "dynamic", defaultAutonomy, editsCode, buildSession(input) | createController(input), validate(config) }` and a registry with `solo`, `review`, `negotiate` registered (wrapping existing behavior).
2. `src/modes/controller.ts`: dynamic-mode contract — `ControllerAction` zod union (all actions in modes.md §4.2), `ControllerContext` (board, roster, reports, budget, policy, `execute(action)` → `{ accepted, reason }`), `ControllerTurnResult`.
3. `src/modes/lead/types.ts`: `LeadTask`, `TaskBoard`, `AgentReport` zod schemas (modes.md §4.3) — Haiku cards T02B-03/05 implement against these.
4. `src/modes/roster.ts` types: `CapabilityProfile`, `RosterEntry`, `RosterPolicy` — T02B-04 implements.
5. Autonomy: `AUTONOMY_LEVELS = ["manual","supervised","autopilot"]`; `run.mode` stays readable; new `run.autonomy`; `--mode supervised|autopilot` maps to autonomy with a one-line deprecation notice; `--mode <modeId>` selects the mode. Alias `supervisor` → `lead`.
6. Config: generalize `modes` to `modes.<modeId>` records validated by each mode's schema, keeping T00-02's `negotiate`/`review` shapes valid; serializer (T00-09) updated.
7. New event types from modes.md §8 added to `src/protocol/events.ts` (additive) with payload schemas.

**Acceptance** — all existing tests green; `--mode autopilot` and `run.mode: autopilot` behave as before; registry lists 3 modes; config round-trip with `modes.lead`; contract docs good enough for Haiku cards.

---

### T02B-02 · Lead controller (the Supervisor)
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T02B-01, T02B-03, T02B-04, T02B-05, T02-01, T02-02

**Deliverables**
1. `LeadController`: runs lead turns (read-only seat), parses actions, validates each against policy/limits/budget, executes via scheduler/worktrees/review/gates, returns results to the lead next turn.
2. Context compaction: board + latest reports + rolling summary (summarizer seat), bounded size.
3. Limits & safety: `maxSeats`, `maxTasks`, `maxReassignPerTask`, `maxEscalationsPerTask`, `maxLeadTurns`, invalid-action cap → `ask_user`; loop detection on assign/reject cycles.
4. `integrate` only through `WorktreeManager`; approval gate unless autonomy=autopilot **and** `policy.integrate: auto`.
5. Lead failover: lead seat failure pauses with board persisted; resume with a different lead model.
6. Persistence/resume of the board and controller state under the session dir.
7. `MockLead` scripted controller for tests; end-to-end mock test matching the phase exit criterion.
8. `assentor run --mode lead` wiring.

**Reviewer focus** — no action bypasses policy; no unbounded growth; crash/resume; merges gated.

---

### T02B-03 · Agent report parser + claim verification
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T02B-01

**Goal** — Turn an agent's final text into a validated `AgentReport`, and check its claims against reality.

**Context to read** — `src/modes/lead/types.ts` (`AgentReportSchema`), `src/protocol/parse.ts` (`extractJsonCandidate` — reuse it), `src/review/verification-gates.ts` (gate result shapes), modes.md §4.3.

**Allowed files** — create: `src/modes/lead/report.ts`, `tests/unit/lead-report.test.ts`.

**Spec**
1. `parseAgentReport(text: string, taskId: string): { ok: true; report: AgentReport } | { ok: false; error: string; needsRepair: boolean }`
   - Use `extractJsonCandidate` to find JSON (fenced or bare). If the JSON has no `taskId`, fill it from the argument; if it has a different `taskId`, return `ok: false`, `needsRepair: false`, error `report is for task <x>, expected <y>`.
   - Validate with `AgentReportSchema`. On schema failure → `ok: false`, `needsRepair: true`, error lists the zod issue paths.
   - No JSON at all → `needsRepair: true`, error `no JSON report found`.
2. `repairPrompt(error: string): string` — short instruction asking the agent to resend only the JSON report; must include the error text and the required `status` values.
3. `verifyReportClaims(report, evidence: { diffFiles: string[]; gateRuns?: Array<{ command: string; passed: boolean }> }): ClaimCheck[]` where `ClaimCheck = { kind: "file_not_in_diff" | "diff_file_not_reported" | "test_claim_unverified" | "test_claim_contradicted"; detail: string }`
   - Compare paths after normalizing to forward slashes and stripping a leading `./`.
   - A `testsRun` entry is *contradicted* when a gate run has the same command and the opposite `passed`; *unverified* when no gate run has that command.
   - Empty array = all claims check out.

**Tests** — fenced JSON, bare JSON, missing taskId filled, wrong taskId, schema failure, no JSON, Windows-style paths, each ClaimCheck kind, no false positives on a matching report.

---

### T02B-04 · Roster builder
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T02B-01, T01-01

**Goal** — Produce the list of hireable agents the Lead sees each turn.

**Context to read** — `src/modes/roster.ts` (types from T02B-01), `src/models/cli-catalog.ts` (T01-01), `src/core/seats.ts`, modes.md §4.4.

**Allowed files** — create: `src/modes/roster-build.ts`, `src/modes/capabilities.ts`, `tests/unit/roster.test.ts`; modify: `src/modes/roster.ts` (exports only).

**Spec**
1. `DEFAULT_CAPABILITIES: CapabilityProfile[]` keyed by `provider` + model **alias** (`claude-code/opus`, `claude-code/sonnet`, `claude-code/haiku`, `codex/*`, `gemini/*`, `antigravity/*`, `cursor/*`, `mock/*`), each with `strengths` (subset of `coding | reasoning | ui | tests | docs | review`), `speed` (`fast | medium | slow`), `cost` (`low | medium | high`). Mark each entry with a comment "seed — user-editable". Use `*` for "any model of this provider". Only these entries; don't invent model ids.
2. `buildRoster({ catalog, availability, capabilities, scoreboard?, policy }): RosterEntry[]`
   - One entry per (provider, model) from the catalog that is `available` (installed + authenticated) and allowed by `policy.allowedProviders` (if set) and `policy.maxCost` (if set).
   - Capability lookup: exact `provider/model` first, then `provider/*`, else `{ strengths: [], speed: "medium", cost: "medium" }`.
   - Attach `rateLimitedUntil` and `freeSlots` from availability; attach scoreboard stats when present.
   - Sort: available slots desc, then cost asc, then provider/model asc. Deterministic.
3. `formatRosterForPrompt(entries, { maxRows = 25 }): string` — a compact markdown table (`provider/model | strengths | speed | cost | free slots | acceptance rate`), truncated with a final `… N more` row.
4. User overrides: `mergeCapabilities(defaults, overrides)` — overrides replace by key.

**Tests** — filtering by availability/policy, capability fallback order, sort determinism, formatting + truncation, override merge.

---

### T02B-05 · Task board model
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T02B-01

**Goal** — Pure data structure for the Lead's task board.

**Context to read** — `src/modes/lead/types.ts` (`LeadTask`, `TaskBoard`), modes.md §4.2, §4.7.

**Allowed files** — create: `src/modes/lead/board.ts`, `tests/unit/lead-board.test.ts`.

**Spec**
1. `applyBoardOp(board, op): { board; error?: string }` — pure, never mutates input. Ops: `plan` (replace backlog tasks that are not yet assigned; keep others), `assign(taskId, seatId)`, `status(taskId, status)`, `accept(taskId)`, `reject(taskId, reason)`, `reassign(taskId, seatId)`, `split(taskId, tasks[])` (parent becomes `split`, children inherit `dependsOn` of parent).
2. Validation errors (return `error`, board unchanged): unknown task; dependency on unknown task; **dependency cycle** (report the cycle path `A → B → A`); accept of a task not in `in_review`; two **parallel** tasks (neither depends on the other, both not closed) with overlapping `ownedPaths` (prefix match on `/`-separated segments: `src/auth` overlaps `src/auth/x.ts`, not `src/authz`).
3. `readyTasks(board)` — tasks whose dependencies are all `accepted`, not yet assigned.
4. `boardColumns(board)` → `{ backlog, assigned, inProgress, inReview, accepted, rejected }` for UIs.
5. Counters on each task: `reassignCount`, `escalationCount` (incremented by `reassign` and by `status` with `escalated: true` metadata if present in the op).

**Tests** — every op, every error, cycle path text, overlap rules (including the `src/authz` non-overlap), readyTasks, immutability (deep-freeze input in tests).

---

### T02B-06 · Cascade mode
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02B-01, T02B-07, T01-03

**Deliverables** — Mode `cascade`: tiers config (`tiers: [[seatSpec…], …]`), escalation triggers (N NEEDS_WORK rounds, gate failure, low confidence, `blocked` report, reviewer flags danger), never-self-review rule (reviewer tier ≥ implementer tier, different seat), danger tasks start at the top tier with approval, `cascade.escalated` events, records the successful tier for the scoreboard. Mock end-to-end tests for each trigger.

---

### T02B-07 · Danger-area classifier
**Tier:** 🔴 O · **Review:** O2 · **Size:** S · **Depends:** T02B-01

**Deliverables** — `classifyRisk({ taskText, paths?, diff? }) → { level: "normal" | "danger", reasons[] }`; default rules mirror `docs/tasks/README.md` §1 (process spawn/kill, git mutations, permission/bypass flags, secrets/vault/keychain, network listeners/auth, file deletion & path policy, release/signing/CI secrets, user config rewrite) as path globs + keyword patterns; user-extendable via `modes.cascade.dangerAreas`; false-negative-biased tests using this repo's real danger files (`src/process/*`, `src/keys/*`, `src/git/*`, `src/security/*`, `scripts/install*`).

---

### T02B-08 · Auto mode router
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02B-01

**Context to read** — `src/review/complexity.ts` (`TaskComplexityAnalyzer`, `ComplexityAnalysis`), `src/review/plan-explain.ts` (how reasons are phrased), modes.md §6 "Auto".

**Allowed files** — create: `src/modes/auto.ts`, `tests/unit/mode-router.test.ts`.

**Spec**
1. `suggestMode({ task: string, complexity: ComplexityAnalysis, repoFileCount?: number, availableModes: string[] }): { mode: string; confidence: number; reasons: string[]; alternatives: string[] }`
2. Rules, first match wins (case-insensitive keyword match on whole words):
   - `review|audit|check my|look over` → `review`
   - `why|how does|explain|where is|what does` and no imperative build verb → `explore`
   - `plan|design|spec|roadmap|break down` and no build verb → `plan`
   - `rename|migrate|replace all|bump|across (the )?(repo|codebase)|every file` → `swarm`
   - `flaky|intermittent|crash|regression|stack trace|incident` → `debug`
   - `test first|tdd` → `tdd`
   - `complexity.risk` is `high` or `critical` → `cascade`
   - multi-part tasks (≥ 3 numbered/bulleted items, or ≥ 3 sentences containing build verbs) → `lead`
   - otherwise → `solo`
   Build verbs: `add|implement|build|create|fix|refactor|write|update`.
3. If the chosen mode isn't in `availableModes`, fall through to the next matching rule; `solo` is always the final fallback.
4. `confidence`: 0.8 for keyword matches, 0.6 for risk/multi-part, 0.4 for the fallback. `reasons` cite the matched rule in plain words. `alternatives` = up to 2 other modes whose rules also matched.

**Tests** — one per rule, fall-through when unavailable, alternatives, fallback.

---

### T02B-09 · Playbooks: Pipeline, Explore, Plan
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02B-01, T03-01, T03-04

**Allowed files** — create: `playbooks/builtin/{pipeline,explore,plan}.yaml`, `tests/unit/playbooks-modes.test.ts`.

**Spec**
- `pipeline`: stages requirements-analyst → architect → engineer (edit) → test-writer (edit) → review (panel, security-veto) → docs-writer; handoff artifact names in `options.artifact` (`requirements.md`, `design.md`, `test-report.md`); approval before the review stage's merge.
- `explore`: read-only; 3 investigator seats with angles in `options.angle` (`callers-and-data-flow`, `tests-and-behaviour`, `history-and-ownership`) → `summarizer` with `options.citations: required`.
- `plan`: planner + architect negotiate (debate, maxRounds 2) → output task cards in `docs/tasks` format (`options.output: task-cards`), read-only except writing under `docs/`.
- Same validation rules as T03-04 (prompt ids exist; read-only playbooks have no edit seats).

**Tests** — parse, prompt ids exist, read-only rules.

---

### T02B-10 · Mode prompts
**Tier:** 🟢 H · **Review:** O (prompt quality) · **Size:** M · **Depends:** T03-01, T02B-01

**Allowed files** — create: `prompts/builtin/{lead,lead-report-instructions,navigator,red-team-attacker,hypothesis-investigator,swarm-worker,retro}.md`, `tests/unit/builtin-prompts-modes.test.ts`.

**Spec** — Same structure/limits as T03-02. Specifics:
- `lead`: role `meta`, read-only; must output only `ControllerAction` JSON (embed the action list from modes.md §4.2 with one example each); must cite the roster when hiring; must prefer cheaper models for tests/docs/mechanical tasks and strong ones for danger areas; never assign a seat to review its own work; ask the user when requirements are ambiguous.
- `lead-report-instructions`: appended to every agent prompt in Lead mode; requires the §4.3 JSON report as the final message.
- `navigator`: interject only for correctness/safety issues, max 2 sentences, otherwise reply `NO_COMMENT`.
- `red-team-attacker`: produce failing tests or a reproducible exploit description; never modify production code.
- `hypothesis-investigator`: one hypothesis, one discriminating experiment, report evidence.
- `swarm-worker`: tiny scope, touch only the listed files.
- `retro`: summarize what failed/worked and which models did well, output bullet lessons.

**Tests** — load with zero errors; `lead` prompt mentions every action name; variables declared.

---

### T02B-11 · TDD mode
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02B-01, T02B-12, T02-01

**Deliverables** — Mode `tdd`: test-writer stage → Gate A (new/changed tests fail on base, run in a worktree at base) → coder stage → Gate B (tests pass) → tamper check (T02B-12) → review. Explicit "test change request" path the reviewer can approve. Mock tests for each gate outcome.

---

### T02B-12 · Test-tamper detector
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** —

**Status: ✅ done.** Shipped in `db3d680`. Sonnet review PASS. Decisions: hand-rolled glob → RegExp (`**/` = zero or more segments, trailing `/**` = anything below, `*`/`?` never cross `/`, all else literal); paths normalized to `/` on every input to `detectTamper`; output keeps the coder's order, de-duplicated.
- ✅ **Fail-closed follow-up done in FU-02 (`461547f`)**, Sonnet PASS: strip a leading `./` in `normalizePath`; compare case-folded paths in `detectTamper` (macOS/Windows filesystems are case-insensitive); add tests for backslash `approvedChanges`/`lockedTests` and a pattern with a literal `.`/`[`. Paths are assumed repo-relative (callers must relativize absolute paths). Not handled: mid-path `//` or `/./`, `..` segments, NFC/NFD — callers should pass git-reported paths.

**Allowed files** — create: `src/modes/tdd/tamper.ts`, `tests/unit/tdd-tamper.test.ts`.

**Spec**
1. `isTestFile(path, patterns?)` — default patterns: `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `tests/**`, `test/**`, `**/*_test.go`, `**/test_*.py`. Implement glob matching without new deps (convert to RegExp; forward-slash paths; normalize `\`).
2. `detectTamper({ lockedTests: string[], coderChangedFiles: string[], approvedChanges?: string[] }): { tampered: string[]; ok: boolean }` — a locked test file changed by the coder and not in `approvedChanges` is tampered.
3. `lockTests(testWriterChangedFiles: string[], patterns?)` → the subset that are test files.

**Tests** — each default pattern, Windows paths, approved changes, non-test files ignored.

---

### T02B-13 · Pair mode
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02B-01, T01-05, T00-06

**Deliverables** — driver seat + navigator seat; navigator receives coalesced driver output every `intervalSec` or on tool calls; interjections via `seat.inject` (respect `NO_COMMENT`), navigator budget cap, optional role swap per subtask, `pair.interjection` events; tests with scripted seats.

---

### T02B-14 · Red-team mode
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02B-01, T02-01

**Deliverables** — rounds of attacker (read-only on production code; may add tests in its worktree) → builder fix → gates confirm attacker tests pass and suite still green → repeat until attacker yields or `maxRounds`; attacker tests kept as regression suite (applied with builder's fix after approval); `redteam.attack` events.

---

### T02B-15 · Swarm mode
**Tier:** 🟡 S · **Review:** O · **Size:** L · **Depends:** T02B-01, T02-01, T02-02, T02B-06

**Deliverables** — splitter (file list / glob / grep query → work items, each with owned files), batch scheduling on cheap tier, per-item patches, reducer applying patches in order with gates per batch, failed items retried on next Cascade tier, progress events `swarm.item`, resume after crash.

---

### T02B-16 · Debug mode
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02B-01, T02-01

**Deliverables** — evidence collection stage (logs, failing test output) → K hypothesis seats → experiments in separate worktrees (instrumentation never merged) → evidence ranking → fix stage on the top hypothesis → review. Tests with scripted hypotheses.

---

### T02B-17 · CLI: `--mode`, `--autonomy`, `assentor modes`
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02B-01

**Context to read** — `src/cli/index.ts` (`run`, `resume`), `src/modes/registry.ts`, `src/core/run-mode.ts`.

**Allowed files** — modify: `src/cli/index.ts`; create: `src/cli/modes.ts`, `tests/unit/cli-modes.test.ts`.

**Spec**
1. `assentor modes` → table: id, title, static/dynamic, edits code (✓/✗), one-line description; `--json` prints the registry list as JSON.
2. `assentor run --mode <id>`: unknown id → exit 1 with `Unknown mode "<id>". Available: <ids>`.
3. `--autonomy manual|supervised|autopilot`; `--mode supervised|autopilot` still accepted → sets autonomy and prints once to stderr: `--mode <x> is deprecated; use --autonomy <x>`; `--autopilot` flag unchanged.
4. `--mode supervisor` → `lead` (alias, no warning).
5. `--mode auto` → runs `suggestMode` (T02B-08), prints the suggestion with reasons, asks to confirm unless autonomy is `autopilot`.

**Tests** — table output, JSON, unknown id, deprecation message (exactly once), alias, auto confirmation skipped under autopilot (inject prompt fn).

---

### T02B-18 · TUI: Lead team board + lead log
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T02B-02, T01-06

**Context to read** — `src/tui/components/seat-board.tsx` (T01-06), `src/modes/lead/board.ts` (`boardColumns`), `src/ui-shared/status.ts`, event types `lead.action`, `task.*`.

**Allowed files** — create: `src/tui/components/lead-board.tsx`, `src/ui-shared/lead.ts` (pure reducer from events to board + log view model), tests; modify: `src/tui/components/index.ts`, `src/cli/ui/reporter.ts` (render when mode is `lead`).

**Spec** — Compact columns (Backlog / In progress / In review / Done) with task id, short title, owner seat display name; below, the last 5 lead actions with ✓ accepted / ✗ refused + reason. Width-aware truncation; ASCII mode like T01-06. Reducer is framework-free so the web UI (T04-17) reuses it.

**Tests** — reducer over a scripted event stream; render at 80/40 cols; ASCII mode.

---

### T02B-19 · Retro stage
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02B-01, T02B-10

**Allowed files** — create: `src/modes/retro.ts`, `tests/unit/retro.test.ts`.

**Spec**
1. `buildRetroInput(events: EngineEvent[]): RetroInput` — per seat: model, role, tasks accepted/rejected, escalations, review verdicts, failures; session totals (duration, tokens if present).
2. `appendLessons(projectPath, sessionId, lessons: string[])` — appends a dated section to `.assentor/memory/lessons.md` (create if missing; ensure `.assentor` gitignore via existing helper; atomic write of the whole file).
3. `scoreboardRows(input)` → rows `{ provider, model, role, accepted, rejected, escalatedFrom, escalatedTo }` for T06-01 (no persistence here).

**Tests** — input built from a fixture stream; lessons file created and appended; rows correct.
