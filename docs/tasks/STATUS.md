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

**Phase 0 — 8 of 9 · Phase 1 — 4 of 7 · Phase 2 — 1 of 10 · Phase 2b — 1 of 19 · Phases 3–5 — 0 of 35 · overall 14 of 80 cards (plus 11 backlog; FU-01, FU-02 done). By tier: 🟢 Haiku 10/41 · 🟡 Sonnet 1/17 · 🔴 Opus 3/22.**

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
| **T01-07** `run --team` + reporter seat section + doctor teams | 🔶 assigned to Haiku (planner: plain-text seat lines from `seatLineModel`, not Ink, in `RunReporter`) | Haiku |
| T00-08 CI matrix macOS/Windows/Linux | ⏳ unassigned (Sonnet card) | — |

**Haiku queue:** after FU-01 → T01-06 (seat board, needs T00-07 merged). Most other 🟢 cards wait on 🔴/🟡 contracts: T02B-01 (modes), T02-03 (negotiation), T03-01 (prompts, 🟡), T04-06 (UI scaffold, 🟡). Unblocked 🟡 cards: T00-08, T01-02, T03-01.

## 5. Next actions (in order)

1. **T01-07:** Sonnet review when Haiku reports; merge; fast-forward Haiku. That completes Phase 1 except T01-03 (🟡 panel policies) and T01-05 (🔴 model switch).
   Next Haiku cards need a contract first: **T03-01** (🟡 prompt format) unblocks T03-02…06; **T02B-01** (🔴 modes, needs T02-09) is far off. Planner should do T03-01 or T01-03 next.
2. Start 🟡 work so Haiku has cards: T03-01 (prompt format) and T01-02 (seat factory) via Sonnet; T00-08 CI matrix.
3. Update this file after every merge.

**Flaky test (unidentified):** one full-suite run on 2026-10-24 had 1 failure while Haiku ran its gate at the same time; 6 reruns were green. If it recurs, capture the test name (`pnpm test 2>&1 | grep -E "FAIL|×"`) — suspect timing under CPU load. Gate commands must not be piped through `grep` without `set -o pipefail`.

## 6. Known follow-ups (not scheduled)

- T00-03: `continue()` / `createExecutor("cursor")` model tests — assigned as FU-01.
- T01-04: re-export `rankCorrelatedFindings` from `src/review/index.ts` when the web Review view (T04-10) needs it.
- Config writes are not atomic (`fs.writeFile`). Pre-existing behavior; consider temp+rename with a Windows-safe fallback.
- The TUI saves the merged user + project config at user scope, so project overrides for sections other than teams/modes are still copied into `~/.assentor`. This is pre-existing behavior (T00-09 only protects teams/modes).
- Two separate CLI argument builders exist (executor recipes and reviewer adapters). Unifying them is backlog card T06-06.

## 7. Decisions still waiting on the user

- [modes.md §10](../plans/modes.md): Lead naming and the autonomy axis; which modes ship first; Lead's default model; auto-integration under autopilot.
- [desktop-app-system-design.md §13](../plans/desktop-app-system-design.md): engine stays TS; keychain vs vault; Linux formats; arm64; code-signing accounts.
- [app-and-multi-model.md §7](../plans/app-and-multi-model.md): TUI first-class?; default negotiation strategy; v1 scope.
