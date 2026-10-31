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

**✅ Done — O2 PASS after 2 rounds at `ab42957`; user signed off 2026-10-29** (with T02B-01b). Decisions: CLI stays solo-only (`available`) until `assentor run` routes through `prepareModeSession` (its own Danger follow-up card); review NEEDS_WORK ends `blocked`; an unknown `modes.<id>` fails config load; synthesize waits for an `aggregator` field. **Must-do for T02B-02:** dynamic controllers need an approval/answer channel and `stages` gated under `manual`; any resume re-applies the autonomy floor. Planner fix in the merge: the alias hint uses `Object.hasOwn`, so `modes.constructor` gives a plain "unknown mode".

**Status: 🔶 type half done as T02B-01a** (planner; O2 NEEDS_WORK → fixed). `src/modes/lead/types.ts` (`TaskIdSchema` git-ref-safe, `OwnedPathSchema` repo-relative, `LeadTaskPlanSchema`/`LeadTaskSchema`, `TaskBoardSchema` (case-insensitive unique ids), `BoardOpSchema`, `AgentReportSchema`, `emptyTaskBoard`), `src/modes/roster.ts` (`CapabilityProfileSchema`, `ProviderAvailability`, `RosterStats`, `RosterScoreboard`, `RosterPolicySchema`, `RosterEntry`, `COST_TIERS`, `costRank`), `src/modes/controller.ts` (`ControllerActionSchema` — 14 actions, `SeatChoiceSchema` with `SeatRoleSchema` + `ModelIdSchema`, `ControllerTurnSchema` ≤ 20 actions, `ControllerContext`). Still to do: deliverables 1, 5, 6, 7 (mode registry, autonomy axis, `modes.<id>` config, new event types) after T02-09. Unblocks T02B-03, T02B-04, T02B-05, T02B-08.

**Status: implemented, awaiting O2 review** (branch `claude/card-t02b-01`). Finishes what T02B-01a/01b left: deliverables 1 (runnable registry: `buildSession` / `createController` / `validate`), 2 (`ControllerTurnResult`), 6 (`modes.<id>` config) and 7 (§8 events). Files: `src/modes/registry.ts` (contract types, builders for solo/review/negotiate), `src/modes/session.ts` (`prepareModeSession`, `ModeValidationError`; exported from the package root, not from the browser-safe `src/modes/index.ts`), `src/modes/controller.ts`, `src/config/schema.ts`, `src/protocol/events.ts`; tests `tests/unit/mode-session.test.ts`, `tests/unit/config-save.test.ts`. Decisions:
- **Contract.** `ModeDefinition` keeps the 01b metadata and adds optional `validate(config) → problems[]`, `buildSession(input) → SessionSpec` (static) and `createController(input) → ModeController` (dynamic). `ModeController.run()` resolves `completed | blocked | budget_exceeded`, throws to fail, and must settle when the signal aborts. Its input carries the goal, title, configured autonomy, config, session id, the built-in `StageRunners` (Lead calls stages as tools), the `StageRunnerDeps`, an optional `WorktreeManager`, the signal and `emit`. A mode without the builder for its kind cannot run.
- **`prepareModeSession(input)`** validates everything and starts nothing (unknown mode or autonomy, empty goal, missing builder, the mode's `validate`, then for static modes the graph rules and the built-in stage checks: strategy registered, team has seats). It throws `ModeValidationError` with every problem; nothing is emitted, written or spawned. `run()` starts it once: static modes go through `SessionRunner` (T02-09) unchanged; dynamic modes get the same lifecycle events (`session.created`, `session.state`, `session.completed|blocked|failed`). Every run emits `mode.selected` first.
- **Autonomy floor, enforced by the runner, not the mode:** `manual` → `requireApproval` on every non-review stage (approve via `approve(stageId)`); the Supervisor's `autopilot` is set from autonomy and overrides the host's `deps.supervisor.autopilot`, so only `autopilot` lets it steer. A mode may add approvals, never remove the floor. Controllers receive the configured level and must honour it (T02B-02).
- **Review mode without touching the runner:** the graph has no standalone review stage, so review is the execute ⇄ review pair with a built-in no-op executor (`strategy: "existing-work"`, the host's `createExecutor` is never called) and `maxRounds: 1`. PASS completes; NEEDS_WORK ends `blocked` with the findings in the reason.
- **Negotiate** reads `modes.negotiate` (team, strategy, maxRounds, consensus) into one negotiate stage; the decision is the session's `plan`. `synthesize` needs an `aggregator` seat id that `modes.negotiate` cannot express yet, and `best-of-n`/`divide` are not registered: all three are refused at prepare time.
- **`available` unchanged (only solo).** It means "`assentor run --mode <id>` runs it", and the CLI still drives the Supervisor directly; review and negotiate run through the contract with injected seats, but there is no real `SeatStepRunner` and no CLI route yet, and flipping them would make `run --mode negotiate` silently run solo.
- **Config:** `modes.<modeId>` for every registry id. `negotiate`/`review` stay typed; other sections (e.g. `modes.lead`) are kept as written and round-trip through save; each mode's `validate` checks its own section before it runs. Unknown ids (`modes.reveiw`) now fail config load instead of being dropped silently; aliases are not accepted as keys.
- **Events:** the 17 §8 types with minimal passthrough payloads (`mode.selected {mode, kind, autonomy}`, `lead.action {action, accepted, reason?}`, `task.* {taskId, …}`, `tdd.gate {gate: A|B, passed}`, …). Only `mode.selected` has a producer so far.
- **O2 round 1 (CHANGES REQUIRED → fixed):** `prepareModeSession` refuses a non-UUID `sessionId` (it becomes a path) before anything emits or runs; a static `run()` checks for an existing `graph.json` before emitting `mode.selected`, so a reused id adds nothing to that session's log; the `existing-work` no-op executor is honoured only in review mode, and any other mode naming it is a `ModeValidationError` (otherwise "implementation skipped, still PASS"). Also: catchall `modes.<id>` values are optional in the TypeScript type; `modes.supervisor` hints at `modes.lead`; `mode.selected.autonomy` is the autonomy enum. The strict unknown-`modes.<id>` rule stays.
- **Follow-ups for T02B-02 (from O2):** dynamic controllers have no approval or ask-user channel yet: before Lead lands, add `requestApproval`/`answer` to `ModeControllerInput` and gate `stages` under `manual` (today a controller can call `stages.execute` without approval). Any future `resumeModeSession` must re-apply the autonomy floor. Review mode only sees changes made since the task start, not earlier work.
- **Danger classifier (T02B-07):** this card asks for no hook; Cascade (T02B-06) and the Lead policy (T02B-02) call `classifyRisk` themselves.

| Mode | Kind | Contract | Runs through `prepareModeSession` | CLI `available` |
|---|---|---|---|---|
| solo | static | `buildSession`: execute → review(panel) | ✓ | ✓ |
| review | static | `buildSession`: existing-work → review(panel, 1 round) | ✓ | ✗ (no CLI route) |
| negotiate | static | `buildSession`: one negotiate stage | ✓ | ✗ (no real `SeatStepRunner`) |
| lead, cascade, interactive, auto | dynamic | `createController` (T02B-02, T02B-06; auto stays a router in the CLI, T02B-17) | ✗ | ✗ |
| pipeline, pair, race, redteam, tdd, swarm, debug, explore, plan, watch | static | `buildSession` from their cards / playbooks (T03-04, T02B-09…16) | ✗ | ✗ |

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

### T02B-01b · Mode registry metadata + autonomy axis (split from T02B-01)
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** M · **Depends:** T02B-01a, T00-09

**✅ Done — O2 PASS after 3 rounds at `3475843`; user signed off 2026-10-29** on: an unknown `--mode` errors (with a "did you mean --autonomy …?" hint for mis-cased levels); `review` stays unavailable (error points to `run --team`); only `solo` is runnable of the 17 registered modes; `assentor init` keeps writing `run.mode: supervised`. The project layer wins over the user layer for autonomy, and a TUI save keeps the user file's own `run` unless the mode was toggled.

Split out of T02B-01 on 2026-10-29 so the CLI card (T02B-17) and the UI can list modes before T02-09. Deliverables 1 (metadata only: `ModeDefinition` without `buildSession`/`createController`, which arrive with T02-09/T02B-02) and 5 (autonomy axis) of T02B-01. Deliverables 6–7 and the runnable registry stay in T02B-01.

---

### T02B-02 · Lead controller (the Supervisor)
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T02B-01, T02B-03, T02B-04, T02B-05, T02-01, T02-02

**Merged 2026-10-30 (planner, under the owner's standing merge direction):** O2 review NEEDS_WORK twice → fixed in `8f6e11a` and `3b61cb9` → PASS with nits. At merge, `ControllerWorktrees` gained `discard`/`markFailed`/`cleanup` (pass-through, ungated) so the debug controller fits the new contract, and debug's approval now uses `requestApproval`. Open nits: `lostWork` set when any (not only the assignee's) worktree is gone; a denied integration has no 'leave it out' option; `oneLine` misses `\p{Cf}` bidi marks; report-instructions render failure warns every run. `assentor run --mode lead` is not wired yet (routing card).

**Status: built, awaiting O2 review + sign-off.** `src/modes/lead/` (controller, config `modes.lead`, `MockLead`), session floor in `src/modes/session.ts`. Must-dos from T02B-01: `requestApproval`/`ask` + `answer()`/`approve()` over `user.question`/`user.answer` (ids unique across resumes); under `manual` every `stages` call and each executor's first run wait for approval; `applyTo("main")` asks unless `autopilot`; `resume: true` goes through `prepareModeSession`, so the floor comes from the autonomy given now, never from `lead.json`. The lead prompt renders the library's `lead` prompt (T02B-10) with `goal, autonomy, tasks, roster, reports, results` (report text has `</report` escaped), else a built-in fallback with the same variables. **Deviation:** deliverable 8 (`assentor run --mode lead`) is not wired: the CLI still runs only `available` modes, and routing `run` through `prepareModeSession` with real `host.askSeat`/`host.roster` and a terminal answer loop is the held Danger follow-up card. `message`/`request_report` are refused (seats take no mid-run messages yet). O2 round 1 (NEEDS_WORK) fixed: retire refused while the seat runs; every failed landing (not only conflicts) asks stop / keep going; ownership check case-sensitive like `allowedPaths`; gates skipped when ownership fails, raced against cancel, diff taken after them; landing warnings surfaced; overlapping accepted-but-unlanded work blocks a new run; replies over 256 KB or 20 actions refused whole; worktree key saved before create; resume checks worktree paths against the manager; questions settle before the terminal state. `ControllerWorktrees` gains `list`. Round 2: `host.prompts` (the host's `PromptLibrary`; tests pin built-in and an empty user layer), `ApprovalDeniedError` for a denied landing (a plain refusal, the task stays accepted); a worktree gone on resume warns, leaves accepted work out, rejects its review and tells the next agent; files made by the gate run are named as such; agents get the library's `lead-report-instructions`.

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

**Status: ✅ done.** Shipped in `4e475e7`, review fixes `bd5fdf9` and `1535152` (Haiku subagent). Sonnet review: fence parity after the 64 KB cut, named bare-JSON parse errors, brace-only input bounded (<200 ms on 64 KB), wrong task id truncated to 100 chars. `src/modes/lead/report.ts`: `parseAgentReport`, repair prompt, claim checks; exported from `src/modes/index.ts`.

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

**Status: ✅ done.** Shipped in `67a685d` (Haiku subagent). Sonnet review PASS. Decisions: `src/modes/capabilities.ts` seeds (8 keys, "seed — user-editable"), `src/modes/roster-build.ts` (`buildRoster`, `formatRosterForPrompt`, `rosterKey`); locale-independent sort; duplicate catalog rows collapse to the first; `rateLimitedUntil` attached but not excluded and not shown in the prompt table (T02B-02 must check it); the catalog's `AUTO` row is an ordinary model when availability lists it (policy for T02B-02). Not exported from `src/modes/index.ts` (import by path). Follow-ups: `maxRows` NaN/fraction handling; tests for `maxRows: 0`, AUTO, neutral-profile `maxCost`, `allowedProviders: []`.

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

**Status: ✅ done** (`e89f32d` + `29cb341`, Haiku #2; Sonnet NEEDS_WORK → fixed). `src/modes/lead/board.ts`: pure `applyBoardOp` (validates the op, returns the original board on any refusal), case-insensitive ids, the transition matrix, `readyTasks`, `boardColumns` (incl. `split`). Decisions: `plan` keeps unmatched backlog tasks; dependents of a split parent depend on all its children; a child may not depend on its own parent; `assign` from `rejected` counts as a reassignment and clears `rejectionReason`; `assign` doesn't check `dependsOn` — the controller (T02B-02) must gate on `readyTasks`. Assumes a valid input board (validate boards loaded from disk).

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

**Merged 2026-10-30 (planner, under the owner's standing merge direction):** O2 review NEEDS_WORK three times → fixed in `150f583`, `23dda28`, `833c4b2` → PASS with nits. At merge, cascade's approval goes through `requestApproval`, and the test helper approves the session's own per-stage questions under manual. Follow-up: under manual both the session (per stage) and cascade (per tier) ask, so the user is asked twice. Open nits: the "could not be read" reason is cut at 400 chars and can lose its size/mtime with very long names; unscanned reasons skip bidi-mark cleaning; the large-file tests are slow (~13 s each) — use long lines instead of 450k short ones.

**Deliverables** — Mode `cascade`: tiers config (`modes.cascade.tiers: [{ team, reviewTeam?, maxRounds? }, …]`, cheapest first; each tier references teams in `teams`, not inline seat specs), escalation triggers (N NEEDS_WORK rounds, gate failure, low confidence, `blocked` report, reviewer flags danger), never-self-review rule (reviewer tier ≥ implementer tier, different seat), danger tasks start at the top tier with approval, `cascade.escalated` events, records the successful tier for the scoreboard (`cascade.tier_succeeded` event plus an `onTierSucceeded` hook). A danger start emits `cascade.escalated` with trigger `danger_start` and no `fromTier`. Danger is checked after every tier below the top (untracked files included). Mock end-to-end tests for each trigger.

---

### T02B-07 · Danger-area classifier
**Tier:** 🔴 O · **Review:** O2 · **Size:** S · **Depends:** T02B-01

**✅ Done — O2 PASS after 3 rounds at `2a5eb23`; user signed off 2026-10-29.** Merge fix (planner, per the reviewer): `modes.cascade` uses `.passthrough()` so untyped keys (T02B-06 tiers) survive a config save, and `dangerAreas` is `.optional()` (no `dangerAreas: []` written on save). Release note: a malformed `modes.cascade.dangerAreas` now fails config load. Known limits: cross-script homoglyphs and string-built module names; spawn aliases with >40 characters after the keyword. Follow-up: project `.assentor/config.yaml` listing this repo's danger files that generic rules miss.

**Status: implemented, awaiting O2 review (round 3).** `src/modes/danger.ts` (exported from `src/modes/index.ts`), tests `tests/unit/danger-classifier.test.ts`; `modes.cascade.dangerAreas` added to the config schema. `classifyRisk(input, { extraRules, projectRoot })` returns `{ level, categories, reasons }`: ten built-in categories (Danger list §1 incl. shell and contracts) plus `unscanned` (input over a limit, binary content, unreadable diff formats, or the glob work budget spent; always danger). Paths are NFKC-normalised with invisible characters stripped, case-folded, `..`/Windows trailing dots resolved; absolute paths are `paths` unless inside `projectRoot`; bare-name rules also match with an extension (`keys` ~ `keys.tsx`). Diffs: symlink/gitlink/100755 modes, context of changed hunks and `@@` function context are checked. User areas add only (literal keywords, never regex). Round-1 and round-2 O2 evasions are tests. Callers pass plain `git diff` (no colour, not `git show`/format-patch); other formats are `unscanned`. Known limit: keyword matching cannot see through obfuscation (`process['\x6bill']` is caught as `process[`, but string-built names and cross-script homoglyphs are not); it is a triage signal, not a security boundary. Not wired into Cascade/Lead (T02B-06/T02B-02 do that).

**Deliverables** — `classifyRisk({ taskText, paths?, diff? }) → { level: "normal" | "danger", reasons[] }`; default rules mirror `docs/tasks/README.md` §1 (process spawn/kill, git mutations, permission/bypass flags, secrets/vault/keychain, network listeners/auth, file deletion & path policy, release/signing/CI secrets, user config rewrite) as path globs + keyword patterns; user-extendable via `modes.cascade.dangerAreas`; false-negative-biased tests using this repo's real danger files (`src/process/*`, `src/keys/*`, `src/git/*`, `src/security/*`, `scripts/install*`).

---

### T02B-08 · Auto mode router
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02B-01

**Status: ✅ done.** Shipped in `1a4ec9d` (Haiku subagent). Sonnet review PASS. `src/modes/auto.ts`: pure, deterministic keyword router (review, explore, plan, swarm, debug, tdd, cascade on high/critical risk, lead, solo); literal mode ids until T02B-01b. Review follow-ups done in `5cafc30` (Haiku): distinct fallback reason when matched modes are unavailable, sentence split ignores dotted filenames, `\s+` in phrases, missing tests added.

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

**Signed off by the owner (2026-10-30):** merged with both deviations approved — the mode wiring beyond the card's file list (`src/modes/playbook-modes.ts`, registry entries) and docs-writer inside the build stage instead of after review. Review NEEDS_WORK → fixed in `044d5dc`.

**Allowed files** — create: `playbooks/builtin/{pipeline,explore,plan}.yaml`, `tests/unit/playbooks-modes.test.ts`.

**Spec**
- `pipeline`: stages requirements-analyst → architect → engineer (edit) → test-writer (edit) → review (panel, security-veto) → docs-writer; handoff artifact names in `options.artifact` (`requirements.md`, `design.md`, `test-report.md`); approval before the review stage's merge.
- `explore`: read-only; 3 investigator seats with angles in `options.angle` (`callers-and-data-flow`, `tests-and-behaviour`, `history-and-ownership`) → `summarizer` with `options.citations: required`.
- `plan`: planner + architect negotiate (debate, maxRounds 2) → output task cards in `docs/tasks` format (`options.output: task-cards`), read-only except writing under `docs/`.
- Same validation rules as T03-04 (prompt ids exist; read-only playbooks have no edit seats).

**Tests** — parse, prompt ids exist, read-only rules.

**Status: implemented, awaiting Sonnet review** (branch `claude/card-t02b-09`). `pipeline`, `explore` and `plan` build their `SessionSpec` from the built-in playbooks (`playbooks/builtin/{pipeline,explore,plan}.yaml`) through `buildSession`, and `validate` refuses bad config. `available` stays false: `assentor run` routing through `prepareModeSession` is a separate Danger follow-up. Decisions:
- Files: the three playbooks; `src/modes/playbook-modes.ts` (new: a synchronous built-in loader and the config team checks, because `buildSession` and `validate` are sync); three entries in `src/modes/registry.ts`; `tests/unit/playbooks-modes.test.ts`. Pinned lists updated for the new playbooks and modes: `builtin-playbooks.test.ts` and `playbook-library.test.ts` (9 → 12 built-ins, explore and plan read-only), and `mode-session.test.ts` (the mode list; its "cannot run" and skip-executor checks now use `swarm`, which still has no builder).
- A playbook's stage `team` is a config team name, bound by the host's `seatsFor`. `validate` refuses a missing team, an edit seat in explore or plan, and an execute stage whose team has no edit seat. Team seat counts are checked by the strategy at prepare time.
- Graph shape (the runner's rules, not the card's wording): an edit stage must be followed by its review, so `docs-writer` sits inside `build` rather than after `review` (card order was review, then docs-writer; a deviation awaiting the owner's sign-off); negotiation strategies need at least two debating seats, so each card role pair is a debate (`requirements-analyst` + `devils-advocate`, then `architect` + `planner`); explore is one three-seat debate, then a summarizer debate with a devil's advocate.
- The `build` stage is ONE executor: `session-stages.ts` `execute()` calls `createExecutor(stage)` once and never reads the team's seats. engineer, test-writer and docs-writer are metadata until the runner runs seats in sequence; nothing runs them one after another today.
- Not wired, metadata only: `options.angle` (seat order; per-seat angles need the host to put them in each prompt), `options.citations`, `options.artifact` and `options.output`. No strategy or runner reads them yet. `synthesize` is not used: its aggregator must be a config seat id, which a playbook cannot name.
- `plan` keeps `editsCode: true` because it writes task cards under `docs/`; that write is host-side, since the graph has no edit stage.
- Tests: each mode builds a spec that passes `validateSessionGraph`; each runs through `prepareModeSession` on mock seats (explore and plan never call an executor; pipeline's build waits for approval, then the review runs); explore and plan have no execute stage or edit seat; invalid config is refused with no events and no `.assentor` directory.

---

### T02B-10 · Mode prompts
**Tier:** 🟢 H · **Review:** O (prompt quality) · **Size:** M · **Depends:** T03-01, T02B-01

**Merged 2026-10-30 (planner; 🟢, not Danger-list):** Opus prompt review NEEDS_WORK (8 items) fixed in `eaedfd5`; second review aligned `lead.md` with the Lead controller (`0631fa6`) in `40e2683`. Deviation: `lead.md` omits `message` and `request_report` because the controller refuses them; add them back when seats accept mid-run messages.

**Status: built, awaiting Opus prompt-quality review.** The seven prompts ship in `prompts/builtin/` and `tests/unit/builtin-prompts-modes.test.ts` (90 tests) checks them. `lead` uses `output: subtasks` and its example parses as a `ControllerTurnSchema` turn; `lead-report-instructions` is checked by `parseAgentReport`. No caller passes their variables yet, so the names are declared from the card and from `ControllerContext`, `AgentReport` and the retro record. Open: the `output` enum has no value for a controller turn or a report.

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

**Merged 2026-10-30 (planner, under the owner's standing merge direction):** O2 review NEEDS_WORK twice → fixed in `e35ca6d` and `4b8de86` → PASS with nits. Adds an abort `signal` to `runShellCommand`/`RunVerificationCommand` (shared with debug). Host duties: return `createTddExecutor` for strategy `tdd`; install dependencies in the worktree; gitignore test-run artifacts or the round is blocked. Known limits: babel/tsconfig not protected; a leftover process could change a test between the tamper check and apply. Open nit: the Supervisor still appends its resume hint to "locks lost".
- ✅ **Dependency install done in FU-10** for tdd, red-team, swarm and debug: `prepareWorktree` (`packages/engine/src/worktrees/prepare.ts`) runs once in every worktree these modes create, before anything runs there (swarm: the integration and item worktrees, and each batch candidate after its merges). Config `worktrees.install`: `"auto"` (default; `pnpm-lock.yaml` → `pnpm install --frozen-lockfile --prefer-offline`, `package-lock.json` → `npm ci --prefer-offline`, `yarn.lock` → `yarn install --frozen-lockfile`, `bun.lockb`/`bun.lock` → `bun install --frozen-lockfile`, first match; no lockfile → nothing; Python and other ecosystems are never guessed, set a command such as `uv sync --frozen`), `"off"`, or a one-line shell command. Runs through the mode's gate runner with `CI=1`, the session signal (cancel kills it) and a 10 min timeout; failure, timeout or an install that leaves unignored files ends the mode `blocked` with the output tail, the worktree kept. Always a real install, never a link to the main checkout's `node_modules` (a symlink escapes the usual `node_modules/` ignore rule and writes through it change main). Lifecycle scripts run as the package manager defaults (the main checkout ran the same ones; a seat-edited `package.json` in a swarm worktree can add scripts, but the gates run seat code anyway). The TDD host should pass `install: config.worktrees.install` (default `auto`).

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

**Merged 2026-10-31 (planner, under the owner's standing merge direction):** O2 review NEEDS_WORK (cancel during drain spun forever; navigator note framed as a supervisor directive; output watching missed gated executors under manual; resume failed raw) → fixed in `9045fee` → PASS with nits. Deviations: no `seat.inject` yet, so an interjection is `interrupt()` + `continue()` with the note as a quoted Warning message; new optional `ModeHostServices.watchExecutorOutput` (nothing implements it yet, so live runs get end-of-turn looks only); pair does not resume. Open nits: `session.ts` spreads `host`, so prototype methods on a class-based host would be lost; gate output is labelled as from the navigator; the budget-stop cancel is untested.

**Deliverables** — driver seat + navigator seat; navigator receives coalesced driver output every `intervalSec` or on tool calls; interjections via `seat.inject` (respect `NO_COMMENT`), navigator budget cap, optional role swap per subtask, `pair.interjection` events; tests with scripted seats.

---

### T02B-14 · Red-team mode
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02B-01, T02-01

**Merged 2026-10-30 (planner, under the owner's standing merge direction):** O2 review NEEDS_WORK three times → fixed in `40e1e3c`, `a985238`, `decb13a` → PASS with nits. Shared-code changes: linear JSON extraction in `src/protocol/parse.ts`; `WorktreeManager.readAtBase`; `env` option on `runShellCommand`/`RunVerificationCommand` (kept alongside TDD's `signal`). At merge: `ControllerWorktrees` gained `readAtBase`; red-team approval goes through `requestApproval`; the test helper approves the session's own apply question. Follow-up: under supervised both the session and the mode ask before apply (double prompt), and TDD and red-team keep separate runner-file lists.

**Deliverables** — rounds of attacker (read-only on production code; may add tests in its worktree) → builder fix → gates confirm attacker tests pass and suite still green → repeat until attacker yields or `maxRounds`; attacker tests kept as regression suite (applied with builder's fix after approval); `redteam.attack` events.

**Status: implemented, awaiting Opus review** (`src/modes/redteam.ts`, `tests/unit/mode-redteam.test.ts`). Decisions: (1) the mode is a dynamic controller loop in code, not a stage graph (the round count depends on the attacker); `kind` changed from static to dynamic, `available` stays false. (2) The attacker is a read-only seat, one seat per team (`validate` refuses `edit`). It replies with JSON; the controller writes its proposed test files (new files only, test-pattern paths, no `..`/symlink escapes) into the single builder worktree, and the worktree diff must be identical before and after the attacker's turn or the session ends `blocked`. (3) A test attack counts only if the tests fail before the fix; exploit descriptions are text only and never run. (4) Attacker output reaches the builder only inside an `<attacker-report>` data block; locked attacker tests are restored if the builder touches them. (5) Review (the host's panel via `createReviewer`) runs before anything is applied; apply is `applyTo("main", squash)` of the builder worktree, so attacker tests land with the fix. Autonomy: `autopilot` applies after PASS; `supervised` needs an `approve` callback, otherwise ends `blocked` with the branch kept; `manual` does not start (no approval channel yet, see T02B-02). Prompt id `red-team-attacker` (T02B-10) is a role for the host's team config; this code does not depend on it. Known limit: an in-flight gate command cannot be killed on cancel (`RunVerificationCommand` has no signal).

**O2 round 1 (NEEDS_WORK) addressed:** the attacker reply schema is strict and needs `yield: true` or an attack (summary tried before rawOutput, length capped; unparsable → `blocked`); each attack's tests run alone on the green baseline and only reproduced attacks are locked; test paths under dot-directories and runner hook/config files are refused; a test run that changes anything besides its own files ends `blocked`; locked-test restore refuses symlinked paths (→ `blocked`) and reads without following links; a builder change to runner config/setup files or package.json scripts fails the attempt; an exploit-only fix with an empty diff ends `blocked`; apply requires the worktree to equal the reviewed diff after review and after approval, passes `allowedPaths`, and reports apply/cleanup warnings in the reason; `classifyRisk` on the final diff makes a danger-area change need approval even under autopilot; `manual` never starts.

**Danger notes:** attacker test code is untrusted and runs with the user's privileges (the gates run it unsandboxed in the builder worktree). The read-only fingerprint is `git diff` against the base plus untracked files: git-ignored paths and the main checkout are not seen. Restore and test-file writes check for symlinks and then write (lstat, then write): a builder process still running after its turn could swap a parent directory in between. That does not widen what unsandboxed builder code can already do. Runner tampering covers runner config/setup files, pyproject.toml, setup.py/.cfg, tox.ini, tsconfig*.json, go.mod, Cargo.toml, Makefile, karma.conf.*, and package.json `scripts`/`jest`/`vitest`/`mocha`/`ava` (nested ones compared with their base version). Not covered (deferred): other build or detection inputs such as pom.xml, build.gradle, Gemfile/Rakefile, noxfile.py, .npmrc, bunfig.toml, deno.json, coverage config (c8/nyc, e.g. .c8rc/.nycrc), package.json `type`, and runner config inside files not listed here. Allowlisted attacker test files are still code: one can change how its package's tests run (a Go `TestMain` calling `os.Exit(0)` disables that package's tests), and a test with a syntax error "reproduces" and is locked. Every gate run uses CI=1 and PYTHONDONTWRITEBYTECODE=1, so an env difference cannot fake a reproduction. The review still sees the whole diff.

**O2 round 2 addressed:** linear JSON extraction in `extractJsonCandidate` (shared); `yield: true` with attacks refused; attacker test names allowlisted; nested package.json compared at the base commit; attack runs use CI=1/PYTHONDONTWRITEBYTECODE=1 and tolerate new snapshot/bytecode files next to the attack's tests; exploit-only attacks reported as unverified.

---

### T02B-15 · Swarm mode
**Tier:** 🟡 S · **Review:** O · **Size:** L · **Depends:** T02B-01, T02-01, T02-02, T02B-06

**Merged 2026-10-31 (planner, under the owner's standing merge direction):** O2 review NEEDS_WORK (gate side effects could land unreviewed; crash-resume windows; no baseline gate; silent unchanged items; truncated diffs; one verdict failing a batch) → fixed in `7d6433f` → PASS; the reviewer's pre-merge should-fix (pin each item's reviewed diff to the merged commit) done in `82b22a2`. Swarm is a dynamic controller (not static); `escapingSymlinks` is exported from divide.ts. Deviations: no partial landing (one item failing every tier blocks the run); a gate failure sends the whole batch up a tier (no bisecting). Open nits: a worker that owns `package.json` can change what the gates run (reviewer sees it); `.assentor/sessions/<id>/swarm.json` and failed worktrees stay until cleanup.

**Deliverables** — splitter (file list / glob / grep query → work items, each with owned files), batch scheduling on cheap tier, per-item patches, reducer applying patches in order with gates per batch, failed items retried on next Cascade tier, progress events `swarm.item`, resume after crash.

---

### T02B-16 · Debug mode
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02B-01, T02-01

**Merged 2026-10-30 (planner, under the owner's standing merge direction):** O2 review NEEDS_WORK → fixed in `18b540a`/`b988bbf` → re-review PASS with nits. `run-shell.ts` and `verification-gates.ts` carry TDD's abort-signal change verbatim. Open nits: a hook rejection from applyTo ends `failed` instead of `blocked` (fix is kept); signals that are substrings of the project path are rejected without telling the seat; reject `<root>`/`<seat>` signals.

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

**Status: ✅ done** (`f4e0c95`, Haiku; Sonnet review PASS). `assentor modes` and `--json` live in `src/cli/modes.ts` (registered from `src/cli/index.ts`); tests in `tests/unit/cli-modes.test.ts`. Spec 1 done; it reads the registry only and never loads config. Specs 2–4 were already met by T02B-01b. Spec 2's wording is still `Modes: …`, not the card's `Available: …`, because `modes-registry.test.ts` pins it. **Open follow-up:** spec 5 (`--mode auto` running `suggestMode` with confirmation) waits until a non-solo mode runs end to end (T02B-01 controller contract); `auto` stays unavailable until then. The footer line is hidden once every mode is available (planner fix in the merge).

---

### T02B-18 · TUI: Lead team board + lead log
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T02B-02, T01-06

**Merged 2026-10-30 (planner, under the owner's standing merge direction):** Sonnet review NEEDS_WORK (bidi/format characters not stripped; CJK overflowed the reporter width) → fixed in `426369a`. The Ink `LeadBoard` is not mounted in a TUI screen yet (screens are outside the card's files); the CLI reporter prints the board on each lead turn. Open nits: terminal task states can regress on a late `task.status`; columns are cramped below ~60 columns.

**Context to read** — `src/tui/components/seat-board.tsx` (T01-06), `src/modes/lead/board.ts` (`boardColumns`), `src/ui-shared/status.ts`, event types `lead.action`, `task.*`.

**Allowed files** — create: `src/tui/components/lead-board.tsx`, `src/ui-shared/lead.ts` (pure reducer from events to board + log view model), tests; modify: `src/tui/components/index.ts`, `src/cli/ui/reporter.ts` (render when mode is `lead`).

**Spec** — Compact columns (Backlog / In progress / In review / Done) with task id, short title, owner seat display name; below, the last 5 lead actions with ✓ accepted / ✗ refused + reason. Width-aware truncation; ASCII mode like T01-06. Reducer is framework-free so the web UI (T04-17) reuses it.

**Tests** — reducer over a scripted event stream; render at 80/40 cols; ASCII mode.

---

### T02B-19 · Retro stage
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02B-01, T02B-10

**Merged 2026-10-31 (planner, under the owner's standing merge direction):** Sonnet review NEEDS_WORK (missing review verdicts; lessons-file safety) → fixed in `fe30b35` → PASS with nits. Library only: `buildRetroInput`, `retroVariables`, `appendLessons` (to `.assentor/memory/lessons.md`), `scoreboardRows`; not yet called by any mode (wire it as the last stage when modes route through the CLI). Limits: two seats on the same provider/model share escalation counts; concurrent retros can drop a lessons section (no lock); the prompt has no variable for the session outcome or verdicts.

**Allowed files** — create: `src/modes/retro.ts`, `tests/unit/retro.test.ts`.

**Spec**
1. `buildRetroInput(events: EngineEvent[]): RetroInput` — per seat: model, role, tasks accepted/rejected, escalations, review verdicts, failures; session totals (duration, tokens if present).
2. `appendLessons(projectPath, sessionId, lessons: string[])` — appends a dated section to `.assentor/memory/lessons.md` (create if missing; ensure `.assentor` gitignore via existing helper; atomic write of the whole file).
3. `scoreboardRows(input)` → rows `{ provider, model, role, accepted, rejected, escalatedFrom, escalatedTo }` for T06-01 (no persistence here).

**Tests** — input built from a fixture stream; lessons file created and appended; rows correct.
