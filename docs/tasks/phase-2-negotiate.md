# Phase 2 — Negotiate mode

Phase exit criteria:
- [ ] From the CLI: "3× Opus + 2× Codex debate a plan → best-of-N implement in worktrees → panel review" runs end-to-end with mock providers in tests and with real CLIs manually.
- [ ] No seat ever edits the user's main checkout directly; all edits are in worktrees until an explicit merge.
- [ ] Concurrency caps and budgets stop runaway spend.

Strategy tasks (T02-04…08) implement against the **strategy contract** delivered by T02-03. Do not start them before T02-03 is merged.

---

### T02-01 · Worktree manager
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T00-01

**Goal** — Safe per-seat git worktrees: create, diff, merge into the task branch, discard, cleanup.

**Context to read** — `src/git/local.ts`, `src/git/types.ts`, `src/persistence/paths.ts`, `src/security/paths.ts`, existing checkpoint/rollback in `supervisor.ts`.

**Deliverables**
1. `WorktreeManager` (`src/worktrees/`), where `seat = { sessionId, seatId }` (seat ids are unique only within a session): `create(seat, baseRef)`, `list(sessionId)`, `diff(seat)`, `applyTo("main" | targetSeat, seat, { strategy: "merge" | "squash" | "patch" })`, `markFailed(seat)`, `discard(seat, { force })`, `cleanup(sessionId, { keepFailed })`, `reconcile()`.
2. Location `.assentor/worktrees/<short-session>/<short-seat>` (short ids to avoid Windows MAX_PATH); branch names `assentor/<session>/<seat>`.
3. Refuse when the main checkout is dirty unless the user opted in; never force-delete branches with unmerged commits unless `discard` was explicit.
4. Recovery: on startup, detect orphaned worktrees (`git worktree list --porcelain`) and report, don't auto-delete.
5. All git calls via `execFile` with timeouts (no shell strings).

**Acceptance** — integration tests on temp repos: create/diff/apply/discard/cleanup, dirty-main refusal, conflict reporting (no partial merge left behind), Windows path length test, interrupted cleanup is idempotent.

**Reviewer focus** — data loss paths, branch deletion, path traversal, Windows.

---

### T02-02 · Seat scheduler: concurrency, rate limits, budgets
**Tier:** 🔴 O · **Review:** O2 · **Size:** L · **Depends:** T00-07

**Status: ✅ done** (planner; O2 NEEDS_WORK → fixed → PASS). `src/seats/scheduler.ts`: `SeatScheduler.run(seat, job, { signal, timeoutMs, classify, maxAttempts })` → `JobOutcome` (never throws; reasons `cancelled|budget|timeout|rate_limited|error`, scope `seat|session`). Global FIFO admission with per-provider caps from the seat's transport (CLI 2, API 4), a global cap (6) and provider cooldowns; budgets re-checked at admission. Rate limits back off exponentially with jitter, release the slot, honour `retryAfterMs` up to `backoffMaxMs` (longer fails). Budgets per seat and session (tokens/cost/runtime): 80% `budget.warning`, 100% stop; runtime enforced mid-run by a timer; a seat breach stops the seat's jobs, a session breach stops all. Per-attempt `timeoutMs`; a job that ignores its abort settles after `abortGraceMs` (slot held until it really ends). `cancelSeat`/`cancelAll`. Config `limits.concurrency`, `limits.globalConcurrency`, `limits.session`; `createSeatScheduler(limits, …)`. Known limit (documented): parallel jobs can overshoot a runtime budget by their overlap. T02-03 maps `scope: "session"` → `NegotiationCancelledError(reason)` and everything else → `ok: false`, and must call `cancelAll` when a session ends.

**Goal** — Run many seats safely: per-provider concurrency caps, queue with `queued` status, rate-limit backoff with countdown events, per-seat and per-session budgets, cancellation.

**Context to read** — `src/core/budgets.ts`, `src/core/retry.ts`, `src/orchestrator/supervisor.ts` (retry logic), `src/process/tracker.ts`.

**Deliverables**
1. `SeatScheduler.run(seat, job, { signal })` — admits by `limits.concurrency[provider]` (defaults: CLI 2, API 4) and global cap.
2. Rate-limit detection hooks (reuse executor error mapping) → `rate_limited` status with `retryAt`, exponential backoff with jitter, max attempts.
3. Budgets: tokens/cost/runtime per seat and session; on exceed → stop seat, emit `budget.warning` at 80% and `budget.exceeded`.
4. `cancelSeat`, `cancelAll` — propagate AbortSignal; integrates with kill-tree.
5. Config: `limits.concurrency`, `limits.session` (schema change owned by this task).

**Acceptance** — fake-clock tests: caps respected under 20 jobs, FIFO fairness per provider, backoff timing, budget stop, cancellation leaves no running jobs.

---

### T02-03 · Negotiation engine core + strategy contract
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T02-02

**Status: ✅ done** (contract: T02-03a; engine: planner + Opus, O2 NEEDS_WORK ×2 → fixed → PASS at `83159aa`; user signed off 2026-10-29 on one file per run, nothing saved on cancel or error, refusing to overwrite a reused runId). `src/negotiation/engine.ts`: `createNegotiationContext` (returns `{ ctx, transcript, abort, dispose }`) and `runNegotiation`. `askSeat` → `scheduler.run` with a per-ask timeout (default 10 min) → JSON extracted from text or object → step schema; seat-scope failure/timeout/invalid reply → `ok: false` + `seat.error`; session-scope stop (cancel/budget) → `NegotiationCancelledError(reason)`, and every ask stopped that way, queued or running, gets exactly one `seat.done { ok: false, summary: "cancelled" | "budget exceeded" }`. When the run ends (the strategy returns or throws) `dispose()` aborts asks still in flight (seat-scope, no `cancelAll`). Status is `thinking` for read-only steps, `editing` otherwise. The model call is an injected `SeatStepRunner`. Decisions: the file is `.assentor/sessions/<id>/negotiations/<runId>.json` (one per negotiation, not `negotiation.json`); `runId` is path-safe; the output path (session id, existing file) is checked before any model call; an existing file is never overwritten (`wx`; a failed write removes its partial file, a process crash mid-write does not); nothing is written on cancel or strategy error; `transcriptRef` is set only when a file is written; transcript entries carry the ask-start `index` and are sorted by it; the caller signal must be the session signal (a caller abort calls `cancelAll`, which is permanent), and its listener is removed after every run. Not done: no size cap on stored vars/replies. Contract history — T02-03a (planner; O2 NEEDS_WORK → fixed). `src/negotiation/strategy.ts`: `NegotiationStrategy`, `NegotiationContext` (`askSeat(seatId, step, vars, { readOnly, worktreePath? })` → `ok`/`!ok`, rejects only with `NegotiationCancelledError{reason}` or for an unknown seat), steps `negotiate-propose|critique|revise|rank|agree|synthesize`, `judge`, `moderator` with reply schemas, `anonymizeProposals`, `matchLabel`, `agreementScore`, `NegotiationResultSchema` (+ `transcriptRef`); registry in `strategies/index.ts`; `testing/mock-context.ts`. Still to do (the engine half): `engine.ts` on top of the seat scheduler (T02-02), persistence of `negotiation.json`, events through the sink. Implementation steps for best-of-n/divide are added by T02-06/T02-08 under Opus review. Items 2–5 below are covered by the contract; `ctx.anonymize`/`judge(...)`/`log`/`budget` are replaced by `anonymizeProposals` and engine-side handling.

**Goal** — The framework all strategies plug into: rounds, anonymization, convergence, persistence, events.

**Deliverables**
1. `NegotiationStrategy` interface (exact, documented) e.g.:
   - `id`, `validate(team, options)`, `async run(ctx): Promise<NegotiationResult>`
   - `ctx` provides: `seats`, `askSeat(seatId, promptRef, vars, { readOnly, worktree? })` (goes through scheduler), `anonymize(proposals)` (stable labels `Proposal A/B/C`), `emit(event)`, `budget`, `signal`, `judge(...)`, `log`.
2. `NegotiationResult { decision, rationale, proposals[], votes?, dissent[], rounds, transcriptRef }` + zod schema, persisted under `.assentor/sessions/<id>/negotiation.json`.
3. Events: `negotiation.proposal/critique/vote/consensus` with anonymized labels plus seat id (UI may reveal).
4. Consensus helper: `agreementScore(responses)` — structured: each seat answers `{ agree: boolean, preferred: label, confidence }`; score = weighted share for the top label.
5. A `MockSeat` harness for strategy tests (deterministic scripted responses).
6. Prompt refs for proposal/critique/revise/vote/judge (placeholders until T03-02/03 ship real prompts).
7. File layout later cards rely on: `src/negotiation/strategy.ts` (contract), `src/negotiation/engine.ts`, `src/negotiation/strategies/index.ts` (registry), `src/negotiation/testing/mock-context.ts`, plus a `src/negotiation/README.md` with one worked example strategy.

**Acceptance** — engine tests with a trivial strategy; anonymization never leaks seat names into prompts; cancellation mid-round; persistence round-trip.

---

### T02-04 · Strategy: Vote (ranked / Borda)
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02-03

**Status: ✅ done** (`c81286d` + `d56d5b8`, Haiku #3; Sonnet NEEDS_WORK → fixed). `src/negotiation/strategies/vote.ts` + `registerBuiltinStrategies()` (explicit, idempotent). Ballots matched with `matchLabel`; invalid ballots and failed replies → dissent; self-vote demotion via `seatByLabel`; Borda; ties → earliest label in proposal order (not text sort: B beats AA); score = winner / (valid ballots × (n−1)), reached > 0.5. Fewer than two proposals: one consensus event at round 1 (one proposal = deliberate vacuous consensus, score 1). Only labels+text in vars.

**Goal** — Each seat proposes; each seat ranks all proposals; Borda count picks the winner.

**Context to read** — `src/negotiation/README.md`, `src/negotiation/strategy.ts` (contract from T02-03a: `askSeat`, `anonymizeProposals`, `matchLabel`, `RankReplySchema`, `NegotiationResultSchema`), `src/negotiation/testing/mock-context.ts` (`createMockNegotiationContext`), `tests/unit/negotiation-contract.test.ts` (README example strategy test).

**Allowed files** — create: `src/negotiation/strategies/vote.ts`, `tests/unit/strategy-vote.test.ts`; modify: `src/negotiation/strategies/index.ts` (register).

**Spec**
1. Round 1: `ctx.askSeat(seat.id, "negotiate-propose", { goal: ctx.goal }, { readOnly: true })` for every seat in parallel → proposals from `ok` replies (failed replies → `dissent`); label them with `anonymizeProposals`.
2. Round 2: `ctx.askSeat(seat.id, "negotiate-rank", { goal: ctx.goal, proposals: anonymized }, { readOnly: true })` → `{ ranking: string[] }` (labels, best first). Map every label with `matchLabel`; a ballot with an unknown or duplicate label, or that doesn't rank every proposal, is ignored and recorded in `dissent` with reason `"invalid ballot"`. Only `anonymized` (labels + text) goes into `vars` — never seat ids.
3. Borda: with `n` proposals, position `i` (0-based) scores `n - 1 - i`. A seat may not rank its own proposal first — if it does, move it to last place before scoring (document this rule in code).
4. Ties → lowest label alphabetically wins, and `rationale` says it was a tie-break.
5. `NegotiationResult.votes` = per-seat ranking + per-label total.
6. Emit `negotiation.vote` per ballot and `negotiation.consensus` at the end with `score = winnerPoints / maxPossible`.

**Acceptance / Tests** — 3 seats clear winner; tie-break; invalid ballot; self-vote demotion; cancellation before round 2 returns a cancelled error from the engine (don't catch it).

---

### T02-05 · Strategy: Debate
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02-03

**Status: ✅ done.** Shipped on `claude/card-t02-05` (Sonnet), review fixes `1d5a57a`, Opus guard `8245d53`. `src/negotiation/strategies/debate.ts`: roles come from seat `role` (`moderator`, `devils-advocate`, `judge`) plus the options; one moderator, not also an advocate; at least one voting seat. Judge is the `judge` seat, else the first seat that is neither an advocate nor a failed proposer, sees the last critiques, and may not pick its own proposal. Each (critic, target) pair counts once at its heaviest weight; advocate critiques carry no weight. The moderator reply's `consensus` flag is ignored. Registered with vote and synthesize in `strategies/index.ts`.

**Status: implemented, awaiting Opus review.** Rules are documented at the top of `src/negotiation/strategies/debate.ts`. Decisions: options `maxRounds`/`consensus`/`moderator`/`devilsAdvocate` (seat ids); the moderator only rules after the last round (judge on the first seat if none); a seat whose round-1 proposal fails is out; critics are never shown their own proposal and self/unknown-target critiques are dropped with dissent; critique weight (cited 1, uncited 0.5) lowers the leader's agreement score: `score = base × (1 − 0.5·W/(W+V))`; if the moderator/judge reply is unusable the last check's leader (else the first proposal) stands and `consensus.reached` is false; dissent covers failures, dropped critiques and every final-round voter that did not back the decision.

**Goal** — Propose → anonymized critique (evidence-required) → revise → consensus check, up to `maxRounds`; moderator/judge decides if no consensus; dissent recorded.

**Deliverables** — strategy implementation, devil's-advocate seat support (role `devils-advocate` never counts toward consensus), critique quality rule (critiques without file/line or reasoning citations get weight 0.5), tests with scripted seats covering convergence in round 1, round 3, and no convergence → judge.

---

### T02-06 · Strategy: Best-of-N
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T02-01, T02-03

**Goal** — Each editing seat implements in its own worktree; verification gates run per worktree; judge panel (review seats) picks the winner; winner is applied to the task worktree (not main).

**Deliverables** — strategy; reuse `maybeRunVerificationGates` logic per worktree; judge prompt gets diffs + gate results (anonymized); losers' worktrees kept until session cleanup; tests with mock executor writing different files.

**Reviewer focus** — only `WorktreeManager` APIs used for git; no direct git calls.

---

### T02-07 · Strategy: Synthesize
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T02-03

**Status: ✅ done.** Shipped in `2ec5361` (Haiku #3). Sonnet review PASS. Decisions: non-aggregator seats propose in parallel in round 1; the aggregator gets `{ goal, proposals }` anonymized and read-only; sources via `matchLabel`, unknown labels become dissent, uncited proposals listed as "not used"; consensus score = cited / total; a failed aggregator gives an empty decision with dissent. `run()` throws when `validate` fails (vote does not) — the engine should call `validate` first. Merge note: debate (T02-05) also edits `strategies/index.ts`; keep the loop over `[voteStrategy, debateStrategy, synthesizeStrategy]`.

**Goal** — All seats propose; one aggregator seat writes a merged answer that cites which proposal each part came from.

**Allowed files** — create: `src/negotiation/strategies/synthesize.ts`, `tests/unit/strategy-synthesize.test.ts`; modify: strategies `index.ts`.

**Spec**
1. Options: `aggregator: seatId` (required; must be in team → else `validate` returns error `"synthesize requires an aggregator seat in the team"`).
2. Round 1: all non-aggregator seats propose in parallel (anonymized).
3. Round 2: `ctx.askSeat(aggregator, "negotiate-synthesize", { goal: ctx.goal, proposals: anonymized }, { readOnly: true })` → `{ answer, sources: Array<{ label, used }> }` (`SynthesizeReplySchema`); match source labels with `matchLabel`.
4. Validate every `sources[].label` exists; unknown labels → add a `dissent` entry `"aggregator cited unknown proposal <label>"` (don't fail).
5. Proposals never cited → listed in `rationale` as "not used".
6. `decision = answer`; `consensus` event score = cited proposals / total proposals.

**Tests** — happy path; missing aggregator; unknown label; uncited proposals.

---

### T02-08 · Strategy: Divide & conquer
**Tier:** 🟡 S · **Review:** O · **Size:** L · **Depends:** T02-01, T02-03

**Goal** — Planner seat splits the task into independent subtasks with file ownership; subtasks assigned to seats in separate worktrees in parallel; integrator seat merges; conflicts escalate to the user.

**Deliverables** — subtask schema (id, description, ownedPaths[], dependsOn[]), overlap check on `ownedPaths` (reject plan with overlaps), dependency-ordered scheduling, integration via `WorktreeManager.applyTo` in order, conflict → `waiting` status with user prompt event.

---

### T02-09 · Stage-graph runner (plan → execute → review, tiebreak)
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T02-03, T01-03

**Planner note (from the T01-03 review):** a reviewer negotiation used as the panel tiebreak (`onDisagreement`) replaces the vote, so the security veto and failed-member guard still apply but a negotiated PASS could clear a member's BLOCKED or evidenced non-security blocker. When implementing the tiebreak here, keep those: a negotiated result may not be PASS while any member returned BLOCKED or an evidenced blocker.

**Goal** — Sessions run as a graph of stages: `negotiate` output can feed `execute`; `review` NEEDS_WORK loops back; review disagreement can trigger a reviewer negotiation (`tiebreak: negotiate`).

**Deliverables**
1. `SessionRunner` over `SessionSpec` (from T00-01): stage transitions, loop limits, persistence + resume of a partially completed graph.
2. Wraps existing `Supervisor` for `execute`+`review` loop, passing negotiated plan as contract context.
3. Implements `onDisagreement` hook from T01-03 using Debate among reviewer seats.
4. Human-approval gates between stages (`requireApproval: true`) → `waiting` event + `session.approve` API.
5. `assentor run --playbook <id>` (CLI wiring).

**Acceptance** — mock end-to-end: plan(debate) → execute(best-of-n) → review(panel, NEEDS_WORK once) → PASS; resume after crash mid-stage; approval gate blocks until approved.

---

### T02-10 · Pre-run cost estimator
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T00-02

**Status: ✅ done.** Shipped in `7ace455`. Sonnet review PASS (arithmetic hand-verified). Decisions:
- `maxRounds` is an explicit input (keeps the function pure). best-of-n and divide are assumed 1 turn per seat (lower bound) until their strategies define turn counts.
- Pricing keys are literal `<provider>/<model>` (`claude-code/AUTO` stays unpriced).
- **Gap (follow-up):** only teams referenced by `modes` are estimated, so a default config with legacy `reviewers` shows zero review cost. Add an optional `reviewTeam` input fed from `resolveTeams(config).review` when this is wired to the CLI/UI. — ✅ `reviewTeam` added in FU-01 (`c023c6e`), used only when `modes.review` is unset; callers still need to pass it when wiring.

**Goal** — Show an estimated token/cost range before a session starts.

**Context to read** — `src/core/seats.ts`, `src/config/teams.ts`, `src/models/registry.ts` (`ModelInfo` pricing fields, if present).

**Allowed files** — create: `src/estimate/cost.ts`, `tests/unit/cost-estimate.test.ts`.

**Spec**
1. `estimateSession({ teams, modes, contextTokens, pricing }): { perSeat: Array<{ seatId, low, high, unit: "tokens" }>, totalLow, totalHigh, usd?: { low, high } }`.
2. Heuristic (document in code as rough): per seat-turn input = `contextTokens + 2_000`, output = 1_500–4_000. Turns: negotiate debate = `maxRounds × 2` per seat (propose/revise + critique), vote = 2, synthesize = 1 (+1 for aggregator), review = `1 × limits.maxRounds` (low uses 1 round, high uses maxRounds).
3. `usd` only if every seat has pricing in `pricing` map (`{ "<provider>/<model>": { inPerMTok, outPerMTok } }`); CLI subscription seats with no pricing → omit usd and add `notes: ["<seat> billed by subscription; no $ estimate"]`.
4. Pure function; no I/O.

**Tests** — single seat; 5-seat debate; mixed pricing → usd omitted with notes; numbers match hand-computed expectations in the test.
