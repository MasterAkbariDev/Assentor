# Build Status & Handoff

**Read this first if you are an AI (or a person) picking up this work.** It is the one authoritative record of where the Assentor multi-model / app build stands, how it is run, and what to do next. Where it disagrees with [../plans/](../plans/) or older notes, this file wins.

_Last updated: 2026-10-25 by the planner session "Repository status review" (Opus)._

---

## 0. Picking this up — checklist

1. Work in the integration worktree: `cd /Users/scalesops/Developer/assentor/.claude/worktrees/multi-model-cli-app-9319c3` (branch `claude/multi-model-cli-app-9319c3`).
2. Run `git status` and `git log --oneline -5`. Compare with §8 "In flight" — uncommitted files there are planner work in progress; do not discard them.
3. Run the gate (§2) once to see the baseline is green.
4. Read §5 (gate) and §6 (web preview plan); continue with the first open item.
5. After every merge or decision, update this file and commit it via `~/commit.sh`.

## 1. Where the code lives

| What | Branch | Worktree / place |
|---|---|---|
| **Integration branch** — all accepted work | `claude/multi-model-cli-app-9319c3` | `.claude/worktrees/multi-model-cli-app-9319c3` |
| Haiku implementer branch (fast-forwarded to integration after each merge) | `claude/templates-phase-0-foundations-06d4b4` | `.claude/worktrees/templates-phase-0-foundations-06d4b4` |
| `main` | `fa31708` (v0.3.19 + gate items 2–3, committed by the user's other session) | repo root `/Users/scalesops/Developer/assentor` |
| Ignore | `worktree-tidy-emerald-isle` (orphaned copy of the plans commit) | `.claude/worktrees/tidy-emerald-isle` |

Nothing has been pushed. No PR exists. Merge-base of integration and `main` is `0fdb990` (v0.3.19).

**Sessions (Claude Desktop) that have worked on this:**
- "Repository status review" — current planner (Opus). Took over from "Multi-model CLI app architecture" (first planner, idle).
- "Haiku implementer: Assentor task cards" — the Haiku implementer (replaced "Templates and phase 0 foundations"). Works only in the Haiku worktree; reports back by cross-session message and waits.
- "Review reliability concerns" (Opus) — works on `main`; wrote gate §5.0 and delivered gate items 2–3.

If a session no longer exists, start a new one with the same role and point it at this file.

## 2. Rules every session must follow

- **Commit only via `~/commit.sh`** (`~/commit.sh -m "subject" -m "body"`), never `git commit`. No Co-Authored-By or "Generated with Claude Code" lines.
- **Never bare `git stash`** (the stash is shared across worktrees). **Never push** unless the user asks.
- **Gate:** `pnpm typecheck && pnpm test && pnpm build`. Check real exit codes — never pipe test output through `grep` without `set -o pipefail` (that once let a failing run look green).
- **Merging Haiku work:** `git merge --no-ff --no-commit <commit>`; add the card's **Status** note and ✅ in [README.md](./README.md); test the *staged* tree alone (`git checkout-index -a --prefix=<scratch>/`, symlink `node_modules`, run tsc + vitest + build there) so uncommitted planner work can't mask a failure; commit; then `git -C <haiku worktree> merge --ff-only claude/multi-model-cli-app-9319c3`.
- **Reviews:** 🟢 cards → Sonnet review; 🟡 → Opus review; 🔴 and Danger-list work → independent Opus **O2** review **and the user's sign-off before commit**. Reviewers are read-only subagents.
- Tier rules, the Danger list, templates: [README.md](./README.md), [templates.md](./templates.md). Card text: `phase-*.md`.

## 3. How the work is run (the loop)

Roles: 🟢 **Haiku** implements bounded cards · 🟡 **Sonnet** reviews every Haiku card · 🔴 **Opus planner** writes contracts, core and Danger-list work, reviews overall, merges.

1. Planner reads the card and the code it touches, then sends the card to the Haiku session with **planner clarifications** (exact names, edge cases, scope amendments). Cards are often stale against the code — check before sending.
2. Haiku implements on its branch, runs the gate, commits via `~/commit.sh`, reports, and waits.
3. Planner runs the review subagent (checklist: [templates.md §2](./templates.md)).
4. NEEDS_WORK → planner sends exact required changes (max 2 loops for 🟢; small final fixes the planner may make itself in the merge). PASS → merge as in §2.
5. Planner fast-forwards Haiku's branch and sends the next card.

## 4. Progress

**19 of 80 cards done** (plus T03-03 half done, 3 follow-up cards FU-01…03, and gate fix G-1). By tier: 🟢 Haiku 14/41 · 🟡 Sonnet-tier 2/17 · 🔴 Opus-tier 3/22. Tests: 958 passing.

| Phase | Done | Open |
|---|---|---|
| 0 Foundations | 8/9 | T00-08 CI matrix (🟡, unassigned) |
| 1 Review & models | 5/7 | T01-03 panel policies (🟡), T01-05 model switch (🔴) |
| 2 Negotiate | 1/10 | gated (§5) |
| 2b Lead & modes | 1/19 | gated (§5) |
| 3 Prompt library | 4/6 | T03-03 rest (moderator/judge/negotiate-*: gated), T03-04 playbooks (needs T02-09: gated) |
| 4 Engine & web UI | 0/17 | fast path in progress (§6) |
| 5 Desktop | 0/12 | — |

| Card | Status | Commit |
|---|---|---|
| T00-01 Seat/team/session contract + event envelope | ✅ | `329446a` |
| T00-02 Config `teams`/`modes` + legacy mapping | ✅ | `7c139bd` |
| T00-03 Model flag for CLI executors | ✅ | `60f45b3` |
| T00-04 CLI reviewers pass `model` | ✅ | `40c1937` |
| T00-05 Session event log | ✅ | `7ecda0c` |
| T00-06 Output-delta coalescer | ✅ | `c4efdd6` |
| T00-07 Supervisor emits seat-scoped events (O2, user signed off) | ✅ | `572618c` |
| T00-09 Config save keeps teams/modes/new fields | ✅ | `58a5a35` |
| T01-01 Model catalog + discovery | ✅ | `cec0e47` |
| T01-02 Seat factory + read-only codex reviewer | ✅ | `9f1620c` |
| T01-04 Finding agreement counts | ✅ | `7cfedb6` |
| T01-06 Status icon map + seat reducer + TUI seat board | ✅ | `e0cca77` |
| T01-07 `run --team` + reporter seat section + doctor teams | ✅ | `d8b4d4c` |
| T02-10 Pre-run cost estimator | ✅ | `cec0e47` |
| T02B-12 Test-tamper detector | ✅ | `03f4d15` |
| T03-01 Prompt format, layered loader, safe templating | ✅ | `c882420` |
| T03-02 Built-in builder prompts | ✅ | `143358e` |
| T03-03a Reviewer role prompts (half of T03-03) | ✅ | `2f92d0f` |
| T03-05 `assentor prompts` CLI | ✅ | `143358e` |
| T03-06 TUI Agents screen: prompts fork/edit/validate | ✅ (real-terminal editor run not yet verified) | `c3aee69` |
| FU-01 / FU-02 / FU-03 follow-ups | ✅ | `48d02f7` / `4da3636` / `2f92d0f` |
| G-1 Panel failure handling (gate item 1, O2, user signed off) | ✅ | `6522d2a` |
| Executor handoff parser + cmd.exe quoting | ✅ | `2db1e16` |

Card-level decisions are in each card's **Status** note in `phase-*.md`.

## 5. Review-correctness gate (agreed with the user 2026-10-25)

**No new seats, modes, negotiation or browser control until items 1–3 are merged.** Prompt work (Phase 3) and the watch-only web preview (§6) were released by the user.

1. ✅ **Panel failure handling** (`6522d2a`). Every member gets a recorded outcome; a PASS needs every member; failures make the turn inconclusive and retryable (not NEEDS_WORK); agreement counts use the configured panel size; security veto comes from evidenced blocker/major security findings (no name or majority rule); an unevidenced claim asks for the diff once, then blocks for a human.
2. ✅ **Evidence budget keeps decision signals** — from `main` (`15e5494`, `fa31708`), merged here.
3. ✅ **Architecture docs through guarded, redacted reads** — same merge.
4. ✅ **This file is authoritative.**
5. 🔶 **Storage ownership** — decided by the user: `.assentor/sessions/<id>/events.ndjson` owns the live event stream (read by web UI and TUI) with a writer lock; `.assentor/tasks/<id>/` keeps state, history, artifacts and the legacy `events.jsonl` for resume/status. Old runs show "no live log" (no backfill). Implemented as **G-5** (`c30ea14`, O2 PASS, user signed off). ✅

**All gate items are now done (2026-10-26).** The gate's condition for new seats, modes, negotiation and browser control is met; the user's chosen order is still the web preview fast path (§6) first.

G-1 follow-ups: the CLI never configures an adjudicator for `PanelReviewer` (adjudicator paths are library-only today); a retry re-runs every member; no resume hint after an inconclusive failure; an unsupported claim inside a non-PASS merge still goes to the executor. Plan bullets not covered yet: honest requested-vs-verified model reporting; duplicate explicit seat ids failing validation.

## 6. Web preview — fast path (chosen by the user 2026-10-25)

Watch-only first preview, ahead of the T04-01 package split. Code stays in the single package (`src/rpc/`, `src/serve/`, `ui/`) and moves when T04-01 runs.

1. ✅ **G-5** — event log writer lock + read-only reader (`c30ea14`).
2. ✅ **Merge `main`** (gate items 2–3) into integration.
3. **T04-02p** *(next)* (🔴 M, O2) — `src/rpc/`: typed method registry, in-process + stdio transports, `engine.hello`, read-only `sessions.list` and `events.subscribe(sessionId, fromSeq)` (`readSessionEvents` + live tail, bounded per-subscriber queue → `events.resync_required`). No write methods.
4. **T04-03p** (🔴 M, O2 + user sign-off) — `assentor serve`: 127.0.0.1 only, 256-bit token via URL fragment, Origin + Host (DNS-rebinding) checks, CSP, auth-failure rate limit, serves the built UI; watch-only.
5. **T04-06p** (🟡 M) — `ui/` scaffold (Vite + React + TS), `Transport` + `WebSocketTransport`, event store reusing `reduceSeatEvents` (`src/ui-shared/status.ts`), reconnect + resync, app shell (Sessions only), fixture stream.
6. **T04-07p** (🟢 M, Haiku) — read-only session board: seat cards (status icon + label, model, role, last line, elapsed, tokens). No model picker, pause or cancel yet.

**Approved dependencies (lean set):** runtime `ws`; UI dev/build `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `zustand`, `tailwindcss`, `jsdom`, `@testing-library/react`. TanStack Router/Query/Virtual and Radix come later with the full UI. Nothing else without asking.

## 7. Decisions

**Made by the user (2026-10-24/25):** T00-07, T00-09 and G-1 sign-offs; adopt the §5 gate; finish T03-01 before the gate; release Haiku for prompt cards; fast path to a web preview; storage split by purpose; new runs only; watch-only preview; lean dependency set.

**Still waiting on the user:**
- [modes.md §10](../plans/modes.md): Lead naming and the autonomy axis; which modes ship first; Lead's default model; auto-integration under autopilot.
- [desktop-app-system-design.md §13](../plans/desktop-app-system-design.md): engine stays TS; keychain vs vault; Linux formats; arm64; code-signing accounts.
- [app-and-multi-model.md §7](../plans/app-and-multi-model.md): TUI first-class?; default negotiation strategy; v1 scope.
- Consolidated plan `docs/plans/app-product-review.md` "Decisions still needed": first app delivery target, background runs, provider/OS shortlist, data-sharing/spending defaults, snapshot mechanism.

## 8. In flight right now

- Nothing uncommitted. Next: **T04-02p** (planner, 🔴, O2 review).
- **Haiku is idle**, waiting for T04-07p (after T04-06p) — no other ungated 🟢 card is open on the chosen path.

## 9. Known follow-ups (not scheduled)

- From the `main` merge review: `resume --executor <other provider>` reuses the snapshot's executor session id (main's behaviour, unguarded); the new `mergeEvidenceIntoPack` call on the needs-work path has no try/catch (a pack bootstrap error fails the task); the shared reviewer prompt's evidence example lists only `file`/`search`/`command`.

- 🔴 **Windows `.cmd` shims and `%VAR%`** (Danger #1/#6): CLIs reached through `agent.cmd`/`codex.cmd` run via `cmd.exe /d /s /c`; `quoteCmdArg` quotes `& | < > ^ ( )` and whitespace, but cmd still expands `%VAR%` inside quotes, so prompt text containing `%NAME%` is altered. Fix: pass prompts on stdin or a temp file for `.cmd` targets.
- T03-06: run the real editor round-trip once in a real terminal (`EDITOR=vi bin/assentor` → Tab, 3 → `f` `u` → `e` → edit → `:wq`; expect Agents back with the prompt selected). Ink gets no keys under `expect` in the sandbox.
- G-5: a concurrent resume of the same task still mutates task state; the lock only protects the event log. Track task-level concurrency separately. `readSessionEvents` re-reads the whole file (serve should tail from a byte offset).
- Executor handoff: built-in edit prompts end with a fenced ```json handoff block read by `findExecutorHandoff`; keep it in any new builder path. `expected-fail:` test prefix is not read by the review pipeline yet.
- T01-04: re-export `rankCorrelatedFindings` from `src/review/index.ts` when the web Review view (T04-10) needs it.
- Config writes are not atomic; the TUI saves merged user+project config at user scope (pre-existing).
- Two CLI argument builders exist (executor recipes and reviewer adapters) — backlog T06-06.
- Prompt library: `output` enum has no value for Lead/moderator JSON (decide in T02B-10/T03-03); a symlinked `.assentor/prompts` dir is not checked against the project root.

## 10. Gotchas for agents

- `ls` is aliased to `eza` in this shell; use `command ls`.
- One full-suite run once had a single unidentified failure while another worktree ran its gate at the same time; reruns were green. If it recurs, capture the test name.
- Usage limits can stop a session or reviewer mid-turn; resume the same agent with a message rather than starting over.
- `bin/assentor` is a bash wrapper — run it directly, not via `node`.
