# Build Status & Handoff

**Read this first if you are a Claude session picking up this work.** It says where things stand, how the work is run, and what to do next. The planner updates it after every merge.

_Last updated: 2026-10-24 by the planner session "Repository status review" (Opus), which took over from "Multi-model CLI app architecture"._

---

## 1. Where the code lives

| What | Branch | Worktree |
|---|---|---|
| **Integration branch** (all accepted work is merged here) | `claude/multi-model-cli-app-9319c3` | `.claude/worktrees/multi-model-cli-app-9319c3` |
| Haiku implementer branch (fast-forwarded to integration after each merge). Haiku session: **"Haiku implementer: Assentor task cards"** (the older "Templates and phase 0 foundations" session is retired) | `claude/templates-phase-0-foundations-06d4b4` | `.claude/worktrees/templates-phase-0-foundations-06d4b4` |
| `main` | `main` at `0fdb990` (v0.3.19) | repo root |

Nothing has been pushed to a remote. No PR exists yet.

Ignore the worktree `tidy-emerald-isle`. It sits on `f920db6`, an orphaned older copy of the plans commit, and has no work in it.

## 2. Rules every session must follow

- **Commit only via `~/commit.sh`** (`~/commit.sh -m "subject" -m "body"`), never `git commit`. No Co-Authored-By or "Generated with Claude Code" lines.
- **Never bare `git stash`.** The stash is shared across worktrees.
- **Never push** unless the user asks.
- Task cards, tiers, the Danger list and review templates: [README.md](./README.md) and [templates.md](./templates.md). Designs: [../plans/](../plans/).

## 3. How the work is run (the loop)

Roles: 🟢 **Haiku** implements bounded cards · 🟡 **Sonnet** reviews every Haiku card (and does S cards) · 🔴 **Opus** (planner) writes contracts and Danger-list cards, decides escalations, and merges.

For each Haiku card:
1. The planner sends the card to the Haiku session ("Haiku implementer: Assentor task cards") by cross-session message, with pointers and gotchas.
2. Haiku implements it on its branch, runs `pnpm typecheck && pnpm test && pnpm build`, commits via `~/commit.sh`, and messages back a completion report. It does not start another card until told.
3. The planner runs a **Sonnet review** subagent (read-only, checklist in templates.md §2) against Haiku's worktree.
4. On PASS, the planner checks anything risky itself, then merges into the integration branch:
   - `git merge --no-ff --no-commit claude/templates-phase-0-foundations-06d4b4`
   - adds a **Status** note to the card plus ✅ in README.md
   - runs the full suite, then commits via `~/commit.sh`.
5. The planner fast-forwards Haiku's branch: `git -C <haiku worktree> merge --ff-only claude/multi-model-cli-app-9319c3`.
6. The planner sends the verdict and the next card. On NEEDS_WORK it sends exact required changes instead.

🔴 cards additionally get an independent **Opus (O2) review** subagent, and the user's sign-off before merge.

## 4. Progress

**Phase 0 — 8 of 9 · Phase 1 — 5 of 7 · Phase 2 — 1 of 10 · Phase 2b — 1 of 19 · Phase 3 — 3 of 6 · Phases 4–5 — 0 of 29 · overall 18 of 80 cards (plus 11 backlog; FU-01, FU-02, G-1 done). By tier: 🟢 Haiku 13/41 · 🟡 Sonnet 2/17 · 🔴 Opus 3/22.**

| Card | Status | Where |
|---|---|---|
| T00-01 Seat/team/session contract + event envelope | ✅ merged | `329446a` |
| T00-02 Config `teams`/`modes` + legacy mapping | ✅ merged | `7c139bd` |
| T00-03 Model flag for CLI executors | ✅ merged | `60f45b3` |
| T00-04 CLI reviewers pass `model` (no default leak) | ✅ merged | `40c1937` |
| T00-05 Session event log | ✅ merged | `7ecda0c` |
| T00-06 Output-delta coalescer | ✅ merged | `c4efdd6` |
| T00-09 Config save keeps `teams`/`modes`/`executor.model` | ✅ merged | `58a5a35` |
| T01-04 Finding agreement counts | ✅ merged | `7cfedb6` |
| T01-01 Model catalog + discovery | ✅ merged | `cec0e47` |
| T02-10 Pre-run cost estimator | ✅ merged | `cec0e47` |
| T02B-12 Test-tamper detector | ✅ merged | `03f4d15` |
| FU-01 Follow-ups: T00-03 `continue()`/cursor model tests + T02-10 `reviewTeam` input | ✅ merged | `48d02f7` |
| T00-07 Supervisor emits seat-scoped events | ✅ merged (O2 PASS after one round; user signed off) | `572618c` |
| FU-02 Fail-closed tamper detector | ✅ merged | `4da3636` |
| T01-02 Seat factory + read-only codex reviewer | ✅ merged (planner-implemented; Opus review PASS after one round) | `9f1620c` |
| T01-06 Status icon map + seat event reducer + TUI seat board | ✅ merged (Sonnet NEEDS_WORK → fixed) | `e0cca77` |
| T01-07 `run --team` + reporter seat section + doctor teams | ✅ merged (Sonnet NEEDS_WORK → fixed) | `d8b4d4c` |
| T03-01 Prompt format, layered loader, safe templating | ✅ merged (planner-implemented; Opus review PASS after one round) | `c882420` |
| G-1 Panel failure handling (5.0 item 1) | ✅ merged (O2 NEEDS_WORK → fixed → PASS; user signed off) | `6522d2a` |
| Executor handoff parser + cmd quoting (planner) | ✅ merged (Sonnet PASS) | `2db1e16` |
| T03-02 Built-in builder prompts | ✅ merged (Opus NEEDS_WORK → fixed → PASS) | `143358e` |
| T03-05 `assentor prompts` CLI | ✅ merged (Sonnet PASS) | `143358e` |
| T03-03a Reviewer role prompts + FU-03 builder prompt follow-ups | ✅ merged (Opus NEEDS_WORK ×2 → fixed; last fix by planner) — T03-03 stays open for moderator/judge/negotiate-* (gated) | `2f92d0f` |
| T00-08 CI matrix macOS/Windows/Linux | ⏳ unassigned (Sonnet card) | — |

**Haiku released (user, 2026-10-25) for prompt work only:** T03-02, T03-05, T03-03a, FU-03 done. Next candidate: T03-06 (TUI Agents screen for prompts; depends on T03-01 + T03-05). Still gated: new seats, modes, negotiation (incl. moderator/judge/negotiate-*, T03-04 playbooks needs T02-09), browser control.

## 5. Next actions (in order)

### 5.0 Review-correctness gate (agreed with the user 2026-10-25, overrides older ordering)

This file is the one authoritative execution order. Where [../plans/](../plans/) or the consolidated plan (`docs/plans/app-product-review.md`, untracked on `main`; its "Delivery sequence" and "First implementation PR" are folded in here) imply a different order, this section wins. Those plans are design input only. **No new seats, modes, negotiation or browser control until items 1–3 are merged.**

1. ✅ **Panel failure handling (integration branch, 🔴) — done.** In `PanelReviewer.turn` / `ReviewCoordinator.decide`, a failed or malformed member is a recorded member outcome, not a dropped one. 3 reviewers with 2 failures and 1 PASS must not return PASS: the result is *inconclusive/retry*, not NeedsWork (NeedsWork would send the executor off making edits for a non-code problem). Agreement counts use all configured reviewers, not just respondents (`correlateFindings` `totalAgents`). See the consolidated plan's "First implementation PR" acceptance list.
2. **Decision signals survive the evidence budget; omitted evidence is disclosed (`main`, uncommitted).** `formatEvidencePackForPrompt` must not tail-truncate the stall signal, executor claims or architecture summary, and must list files it did not inline. (The supervisor already downgrades a stalled PASS when phases remain, via `downgradePassIfPhasesRemain`; a blanket "never PASS while stalled" rule was rejected because a false stall detection would loop forever.)
3. **Architecture docs through guarded, redacted reads (`main`, uncommitted).** `loadProjectArchitectureDoc` uses the same symlink-guarded, `redactSecrets` path as other file evidence.
4. **This file is authoritative** — adopted by the planner and the user on 2026-10-25.
5. **Storage ownership before browser control.** Decide who owns `.assentor/sessions` (T00-05 event log, no writer lock) versus the existing task store, and the migration, before T04 or any background execution depends on it. Import-based related-file discovery (replacing the Dart filename guesses in `expandRelatedModuleFiles`) comes after.

Items 2–3 are being done in the repo-root checkout on `main` by session "Review reliability concerns"; they are not on this branch until merged. T01-07 and T03-01 finished before the gate (user decision); T01-03 waits behind item 1.

**G-1 decisions (panel failure handling):**
- Every configured member gets a `MemberOutcome` (`result` | `pending` | `failed`); throws (`Promise.allSettled`), errors, empty turns and FAILED verdicts are failed members. Duplicate member names get `#2`.
- A PASS needs every member: a pending member gets its evidence first; any failed member makes the turn **inconclusive** (`error` + `retryable`, never NEEDS_WORK). Retryable unless a member failed on auth/permission. Non-PASS results backed by findings stand. Agreement counts use the configured panel size.
- Security authority comes from the finding: an evidenced (non-empty `evidence[]`) blocker/major security issue from any reviewer vetoes a PASS; no name or majority precondition. An unevidenced one asks for `git_diff` (+ named files) once, then BLOCKS for a human (HumanRequired) if it comes back unsupported.
- Supervisor: `ReviewerTurnResult.retryable` overrides the text-based retry rule.
- Follow-ups: the CLI never configures an adjudicator for `PanelReviewer`, so the adjudicator-PASS paths are covered only by library tests; a retry re-runs every member (cost); no resume hint after an inconclusive failure; an unsupported claim inside a non-PASS merge still goes to the executor; a claim is marked "verification requested" even if the request was never sent (fails safe to BLOCKED).
- Remaining first-PR bullets not in G-1: honest requested-vs-verified model reporting; duplicate explicit seat ids failing validation.

**Then, after the gate (items 2–3 land from `main`, item 5 decided):**
1. Release Haiku: T03-02 → T03-05 → T03-03 (reviewer roles), each Sonnet/Opus-reviewed.
2. T01-03 panel policies (🟡) builds on item 1. T00-08 CI matrix.
3. Update this file after every merge.

**Flaky test (unidentified):** one full-suite run on 2026-10-24 had 1 failure while Haiku ran its gate at the same time; 6 reruns were green. If it recurs, capture the test name (`pnpm test 2>&1 | grep -E "FAIL|×"`) — suspect timing under CPU load. Gate commands must not be piped through `grep` without `set -o pipefail`.

## 6. Known follow-ups (not scheduled)

- 🔴 **Windows `.cmd` shims and `%VAR%`** (Danger #1/#6): executors and reviewers reached through `agent.cmd`/`codex.cmd` etc. run via `cmd.exe /d /s /c`; `quoteCmdArg` now quotes `& | < > ^ ( )` and whitespace, but cmd still expands `%VAR%` inside quotes, so prompt text containing `%NAME%` is altered. Fix by passing prompts on stdin or a temp file for `.cmd` targets. Found in the T03-05 review.
- Executor handoff: `findExecutorHandoff` (`src/review/pack-builder.ts`) prefers the last fenced ```json block with handoff keys; built-in edit-role prompts end with one (T03-02 review). Strategies that drive builders through other paths should keep that block.

- T00-03: `continue()` / `createExecutor("cursor")` model tests — assigned as FU-01.
- T01-04: re-export `rankCorrelatedFindings` from `src/review/index.ts` when the web Review view (T04-10) needs it.
- Config writes are not atomic (`fs.writeFile`). Pre-existing behavior; consider temp+rename with a Windows-safe fallback.
- The TUI saves the merged user + project config at user scope, so project overrides for sections other than teams/modes are still copied into `~/.assentor`. This is pre-existing behavior (T00-09 only protects teams/modes).
- Two separate CLI argument builders exist (executor recipes and reviewer adapters). Unifying them is backlog card T06-06.

## 7. Decisions still waiting on the user

- [modes.md §10](../plans/modes.md): Lead naming and the autonomy axis; which modes ship first; Lead's default model; auto-integration under autopilot.
- [desktop-app-system-design.md §13](../plans/desktop-app-system-design.md): engine stays TS; keychain vs vault; Linux formats; arm64; code-signing accounts.
- [app-and-multi-model.md §7](../plans/app-and-multi-model.md): TUI first-class?; default negotiation strategy; v1 scope.
