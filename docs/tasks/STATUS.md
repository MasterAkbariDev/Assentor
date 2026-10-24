# Build Status & Handoff

**Read this first if you are a Claude session picking up this work.** It says where things stand, how the work is run, and what to do next. The planner updates it after every merge.

_Last updated: 2026-10-24 by the planner session "Multi-model CLI app architecture" (Opus)._

---

## 1. Where the code lives

| What | Branch | Worktree |
|---|---|---|
| **Integration branch** (all accepted work is merged here) | `claude/multi-model-cli-app-9319c3` | `.claude/worktrees/multi-model-cli-app-9319c3` |
| Haiku implementer branch (fast-forwarded to integration after each merge) | `claude/templates-phase-0-foundations-06d4b4` | `.claude/worktrees/templates-phase-0-foundations-06d4b4` |
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
1. The planner sends the card to the Haiku session ("Templates and phase 0 foundations") by cross-session message, with pointers and gotchas.
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

**Phase 0 — 6 of 9 done · Phase 1 — 1 of 7 done · overall 7 of 80 cards (plus 11 backlog).**

| Card | Status | Where |
|---|---|---|
| T00-01 Seat/team/session contract + event envelope | ✅ merged | `329446a` |
| T00-02 Config `teams`/`modes` + legacy mapping | ✅ merged | `7c139bd` |
| T00-03 Model flag for CLI executors | ✅ merged | `60f45b3` |
| T00-04 CLI reviewers pass `model` (no default leak) | ✅ merged | `40c1937` |
| T00-05 Session event log | ✅ merged | `7ecda0c` |
| T00-06 Output-delta coalescer | ✅ merged | `c4efdd6` |
| T01-04 Finding agreement counts | ✅ merged | `7cfedb6` |
| **T00-09** Config save keeps `teams`/`modes`/`executor.model` | 🔶 **implemented, uncommitted** in the integration worktree (`src/config/load.ts`, `src/services/app.ts`, `tests/unit/config-save.test.ts`); 391/391 tests pass; **O2 review running; needs user sign-off** | planner |
| **T01-01** Model catalog + discovery | 🔶 assigned to Haiku | Haiku |
| T00-07 Supervisor emits seat-scoped events | ⏭ next for planner, after T00-09 is committed | planner |
| T00-08 CI matrix macOS/Windows/Linux | ⏳ unassigned (Sonnet card) | — |

**Haiku queue after T01-01:** T02-10 (cost estimator) → T02B-12 (test-tamper detector). After T00-07 merges, T01-06 (seat board) opens up. After T00-02 + T00-04, T01-02 (Sonnet) opens up.

## 5. Next actions (in order)

1. **T00-09:** read the O2 review result. Fix any required changes. Ask the user for sign-off, then commit via `~/commit.sh`, mark ✅ and add a Status note to the card.
2. **T00-07** (planner, 🔴): wire `fromSupervisorEvent` + `EventLog` + the delta coalescer into `Supervisor`. Pass a coalescer `onError` that never throws. Event writes must never break the run loop. Then O2 review and user sign-off.
3. Keep running the Haiku loop: T01-01 → T02-10 → T02B-12, then T01-06 once T00-07 lands.
4. Assign T00-08 (CI matrix) to a Sonnet session or subagent.
5. Update this file after every merge.

## 6. Known follow-ups (not scheduled)

- T00-03: add a `continue()` model test and a `createExecutor("cursor")` model test.
- T01-04: re-export `rankCorrelatedFindings` from `src/review/index.ts` when the web Review view (T04-10) needs it.
- Config writes are not atomic (`fs.writeFile`). Pre-existing behavior; consider temp+rename with a Windows-safe fallback.
- The TUI saves the merged user + project config at user scope, so project overrides for sections other than teams/modes are still copied into `~/.assentor`. This is pre-existing behavior (T00-09 only protects teams/modes).
- Two separate CLI argument builders exist (executor recipes and reviewer adapters). Unifying them is backlog card T06-06.

## 7. Decisions still waiting on the user

- [modes.md §10](../plans/modes.md): Lead naming and the autonomy axis; which modes ship first; Lead's default model; auto-integration under autopilot.
- [desktop-app-system-design.md §13](../plans/desktop-app-system-design.md): engine stays TS; keychain vs vault; Linux formats; arm64; code-signing accounts.
- [app-and-multi-model.md §7](../plans/app-and-multi-model.md): TUI first-class?; default negotiation strategy; v1 scope.
