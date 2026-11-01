# Build Status & Handoff

**Read this first if you are an AI (or a person) picking up this work.** It is the one authoritative record of where the Assentor multi-model / app build stands, how it is run, and what to do next. Where it disagrees with [../plans/](../plans/) or older notes, this file wins.

_Last updated: 2026-10-27 by the planner session "Multi-model CLI app architecture" (Opus)._

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
- "Haiku implementer: Assentor task cards" — Haiku implementer #1 (replaced "Templates and phase 0 foundations"). Works only in the Haiku worktree; reports back by cross-session message and waits. Owns `ui/` cards.
- "Haiku implementer 2: Assentor task cards" (`haiku-two`) — Haiku implementer #2, started 2026-10-27 to speed things up. Own worktree/branch cut from the integration branch; never touches `ui/`. Merge its branch the same way as #1's.
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

**66 of 91 cards done** (2026-11-01; plan grew to 91 with Phase 3b and T04-18). By tier: 🟢 Haiku 28/41 · 🟡 Sonnet-tier 13/17 · 🔴 Opus-tier 13/22. Tests: 2501. **Core (Phases 0–3 + 2b) complete.** Phase 4 preview cuts merged: T04-09p, T04-10p, T04-14p, T04-17p. **T04-01 monorepo split merged (`c5f4201`)** — code now lives in `packages/{protocol,ui-shared,engine,cli,ui}/src`.

| Phase | Done | Open |
|---|---|---|
| 0 Foundations | 9/9 | — |
| 1 Review & models | 7/7 | — |
| 2 Negotiate | 10/10 | — |
| 2b Lead & modes | 8/19 (+01b) | T02B-02 Lead, 11 TDD, 14 red-team building; 09 and 10 in review; 06 Cascade and 16 debug starting; then 13, 15, 18, 19 |
| 3 Prompt library | 6/6 | — |
| 4 Engine & web UI | 3/17 | web preview fast path merged (§6); rest paused (core first) |
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
3. ✅ **T04-02p** (🔴 M, O2) — done, see commit log and the T04-02 card note. `src/rpc/`: typed method registry, in-process + stdio transports, `engine.hello`, read-only `sessions.list` and `events.subscribe(sessionId, fromSeq)` (`readSessionEvents` + live tail, bounded per-subscriber queue → `events.resync_required`). No write methods.
4. ✅ **T04-03p** (🔴 M, O2 + user sign-off) — done, see the T04-03 card note. — `assentor serve`: 127.0.0.1 only, 256-bit token via URL fragment, Origin + Host (DNS-rebinding) checks, CSP, auth-failure rate limit, serves the built UI; watch-only.
5. ✅ **T04-06p** (🟡 M) — `837c386` + review fixes (Opus NEEDS_WORK → fixed → PASS; see the T04-06 card note). — `ui/` scaffold (Vite + React + TS), `Transport` + `WebSocketTransport`, event store reusing `reduceSeatEvents` (`src/ui-shared/status.ts`), reconnect + resync, app shell (Sessions only), fixture stream.
6. **T04-07p** *(after the T04-06p review)* (🟢 M, Haiku) — read-only session board: seat cards (status icon + label, model, role, last line, elapsed, tokens). No model picker, pause or cancel yet.

**Approved dependencies (lean set):** runtime `ws`; UI dev/build `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `zustand`, `tailwindcss`, `jsdom`, `@testing-library/react`. TanStack Router/Query/Virtual and Radix come later with the full UI. Nothing else without asking.

## 7. Decisions

**Made by the user (2026-10-24/25):** T00-07, T00-09 and G-1 sign-offs; adopt the §5 gate; finish T03-01 before the gate; release Haiku for prompt cards; fast path to a web preview; storage split by purpose; new runs only; watch-only preview; lean dependency set.

**Still waiting on the user:**
- [modes.md §10](../plans/modes.md): Lead naming and the autonomy axis; which modes ship first; Lead's default model; auto-integration under autopilot.
- [desktop-app-system-design.md §13](../plans/desktop-app-system-design.md): engine stays TS; keychain vs vault; Linux formats; arm64; code-signing accounts.
- [app-and-multi-model.md §7](../plans/app-and-multi-model.md): TUI first-class?; default negotiation strategy; v1 scope.
- Consolidated plan `docs/plans/app-product-review.md` "Decisions still needed": first app delivery target, background runs, provider/OS shortlist, data-sharing/spending defaults, snapshot mechanism.

## 8. In flight right now

**Planner handover (user, 2026-10-29):** session "Repository status review" (Opus) is the planner again; "Multi-model CLI app architecture" stays idle. The user asked for parallel subagents to finish faster. Found on takeover: merged since the last STATUS edit — T02-02 seat scheduler (`a7c8732`), T02-04 vote (`e516ff4`), T02B-05 Lead board (`f875a48`), T01-03 panel policies + T00-08 CI matrix (`2292270`). Uncommitted in this worktree: the previous planner's **T02-03 negotiation engine** (`src/negotiation/engine.ts`, test, export) — gate green, under O2 review now. Unmerged on side branches: T02B-03 report parser (`claude/haiku-two-cards-fd2328`, `bd5fdf9`, review fixes in), T02-05 debate (`claude/priceless-kirch-952d9c`, `9483d1f`), T02-07 synthesize (`claude/youthful-galileo-a41523`, `2ec5361`) — all under review now. New implementer subagents (own worktrees `card-*` off integration): T02B-04, T02B-08, T02B-17 (Haiku), T02-01 worktree manager (Opus, 🔴, O2 + sign-off). Gate on takeover: 1,277 tests green.

**Parallel wave (2026-10-29) — merged so far:** T02-07 synthesize (`2dae7c0`), T02B-04 roster (`eb64ae5`), T02B-03 report parser (`95113db`), T02B-08 auto router (`f1ca175`, follow-ups `4884c13`), T02-05 debate (`f72f60f`), T02-03 negotiation engine (`db3a8a4`), T03-03b negotiation prompts (`7b3a0cd`), FU-06 config safety (`885b5cd`), **T02-01 worktree manager (`3f17a20`), T02-09 stage-graph runner (`07392f5`), T02B-01b mode registry + autonomy (`2c28797`)** — the last three O2 PASS and signed off by the user on 2026-10-29. Card notes record each sign-off and known limit.
- ✅ T01-05 model switch merged (`031b9bc`): O2 PASS after 3 rounds; user signed off on 2026-10-29, including the shared kill-tree change.
- Follow-ups to file: FU-07 kill-tree SIGSTOP the root before the `ps` snapshot plus an async `ps` fallback; `setModel` rejecting invalid ids itself (defence in depth); manifest lock for the worktree manager before two Assentor processes share a repo; per-session lock + grace timeout in the session host; `saveConfig` atomic write.
- Wave 3 (started 2026-10-29): T02B-02 Lead (Opus), T02B-10 mode prompts and T02B-09 Pipeline/Explore/Plan playbooks (Haiku), T02B-11 TDD and T02B-14 red-team (Sonnet). Held for the next wave: T02B-13 pair, T02B-16 debug, and routing `assentor run` through `prepareModeSession` (Danger follow-up card).
- ✅ T02B-17 `assentor modes` merged (`a96ab80`, Sonnet PASS). Open: spec 5 `--mode auto` waits for a runnable non-solo mode (T02B-01).
- ✅ T03-04 built-in playbooks merged (`05eaffb`, Sonnet PASS); Phase 3 complete. Running playbooks waits for a real `SeatStepRunner` and team binding.
- In fix rounds after review:
  - ✅ T02-06 best-of-N merged (`6d4648d`): Opus PASS after 2 rounds; user signed off (deletion paths + read-only `WorktreeManager.topLevel()`).
  - T02-08 divide (Opus NEEDS_WORK: rework as an Executor like best-of-N, run parts through the scheduler, no stuck `waiting` seat, rename and late-write ownership bypasses. The R1/R2 fixes change the T02-01 worktree manager, so they need O2 plus **user sign-off**).
  - ✅ T02B-01 controller contract merged (`f1a5a3d`): O2 PASS after 2 rounds; user signed off. Must-do for T02B-02: approval/answer channel for dynamic controllers, `stages` gated under `manual`, resume re-applies the autonomy floor.
  - ✅ Worktree manager follow-up merged (`2dde8f9`, cherry-picked from `6966bd6` without the superseded divide commit): renames at both ends, `applyTo` `allowedPaths`. O2 PASS; user signed off.
  - ✅ T02-08 divide & conquer merged (`e9e7331`): Opus PASS after 3 rounds; user signed off. Phase 2 complete.
- ✅ T02B-07 danger classifier merged (`9716d2a`): O2 PASS after 3 rounds; user signed off. Merge fix: `modes.cascade` passthrough, `dangerAreas` optional. Follow-up: project `.assentor/config.yaml` with this repo's danger files.
- **Owner direction (2026-10-30): merge without asking for sign-off.** Cards still need an independent O2 review that ends PASS (or only nits) and a green staged-tree gate; the planner then merges and records it here instead of asking the owner.
- **2026-10-31: core complete.** Merged: T02B-19 retro `0444b42`, T02B-13 pair `ddc7ad3`, T02B-15 swarm `3ce4b91` (each O2/Sonnet review → fixes → PASS). Then Phase 4 watch-only preview cuts on the single package (no T04-01 split yet — it would block parallel work): T04-09p negotiation view `9528ff3`, T04-17p Lead board view `e0b592c`; T04-10p review view `8a4a114`, T04-14p command palette `d8ca52f`. Then **T04-01 monorepo split started** (Opus, worktree `card-t04-01` from `d8ca52f`) with nothing else in flight — it moves almost every file, so no other card starts until it merges.
  - **T04-01 merged `c5f4201`** (O2 PASS; fixes `7a55c91`). Layout: `packages/protocol` (zod schemas, Node-free), `packages/ui-shared` (Node-free), `packages/engine` (no Ink/React), `packages/cli` (CLI + TUI), `packages/ui` (web UI, built to `packages/ui/dist`). Packages import each other as `#assentor/<pkg>/…` (root `package.json` `imports` → `dist/`); `tsc -b --force` builds all into the one root `dist/`. Older notes in this file that say `src/…` or `ui/…` mean the same module under `packages/<pkg>/src/…`.
  - **Gate after the split:** run it in the worktree itself (`pnpm install --frozen-lockfile` first, then typecheck, `npx vitest run --maxWorkers=3`, `pnpm build`). The old checkout-index copy with one symlinked `node_modules` does not cover the per-package `node_modules`.
  - Next: write RPCs (rest of T04-02, T04-03 auth for writes) unblock T04-11/12/13/16 and the write half of the preview cuts; T04-05 sessions/seats/worktrees handlers; engine events the views need (listed above).
- **2026-11-01 (night).** Merged: mode routing `4cb837b`, FU-08 `97ea125`, T04-13 `879603e`, T04-16 `ddfc117`, T04-11 `7bd8987`, TE-01+TE-10 `bb82c85`, FU-10 `479195f`, TE-07 `926db3a`, T04-18 `07a2c98`, TE-09 `2cf55a3`, FU-11 `33d2972` — **13 of 17 modes now run from `assentor run --mode`** (race, interactive, auto, watch have no runner). Integration: 2,861 tests.
  - In flight: T04-12 editors (data-loss fixes: raw team spec in team.list; `extends` copy), TE-02 concise style (config-save leak, golden snapshot), TE-03 context packer (review found the saving was tuned — 0% on original fixtures; now: lossless dedupe ON, every budget cut OFF until the owner's live A/B), TE-05 caching (O2 review; fresh input −30%, net unchanged — billed cost is the win), TE-08 saver skills (each benchmarked; off unless it passes).
  - Needs the owner: `pnpm bench:tokens --live --budget N --executor claude-code --gate <variant>` runs to turn any token saving on by default; Phase 5 runs on three OSes.
- **2026-11-01 (early morning, owner: "implement faster, use more agents").** Merged, each after review PASS and a full gate: TE-02 output styles `ab693a7`, T04-12 editors `f8625cd`, TE-03 context packer `369259f`, TE-08 saver skills `2e1444e`, TE-05 caching `733e4b4`, FU-12 seat stop/setModel `daf4913`, T04-W UI write controls `2c211f5`, T05-02 perf harness (machine part) `2ea1cac`, TE-04 rolling summaries `4068b50`. 72 of 91 cards.
  - Token economy result so far (all mock, `docs/benchmarks/tokens.md`): nothing that raises tokens is on by default. Lossless context dedupe is on (0% on the fixtures). Off until the owner's live A/B: concise style (+7% always-on cost; its saving is shorter output), all eight saver skills (+3% to +29% each, +78.5% together), context budget cuts (−15%/−40% on large fixtures, quality unmeasured), rolling summaries (the summariser call costs more than it saves on the mock). Caching (TE-05) cuts billed cost, not tokens; the fresh-input −30% is a best case.
  - Fixed in merges: FU-12 had dropped the "Resume with" hint from every cancelled turn (Claude Code's own message lacks it) — only an RPC seat stop skips it now; T05-02 found the shared frame batcher's `flush()` left a second timer chain (fixed in the store).
  - Process slips: the TE-06 builder made merge commit `ccacfa6` with plain `git commit` (no trailers); left as is.
  - Then merged: TE-06 run profiles `c71d141` (economy = one reviewer unless task text, changed files or diff hit a danger area; −26% on the mock, all from the 3→1 panel, quality unproven; opt-in), T04-18b usage view skills + estimate vs actual. 73 of 91 cards; 3,067 tests.
  - In flight: FU-13 Windows `.cmd` prompts off the cmd.exe command line (O2 FAIL → fixing: cmd.exe must be spawned with `windowsVerbatimArguments` — a pre-existing quoting bug that let `& ^ |` in paths break out), FU-14 `--mode auto` runner, T02B-R race mode (new card). Watch and interactive stay Phase 6 backlog.
  - Owner: the builder's browser tool left an untracked `.playwright-mcp/` log folder in the main checkout (safe to delete). T05-02's webview runs (WKWebView, WebView2, WebKitGTK) are in `docs/benchmarks/streaming.md`.
- **Fan-out 2 (2026-10-31 night, owner: "implement faster, use more agents").** Merged since the evening resume: T04-02 `9819eaf`, T04-03 `2fc2de4`, FU-09 `bbcd9dd`, T04-04 `57bd880`, T04-06 `018b82b`, T04-05 `bbfb171`; plan Phase 3b added `d488d89`. 58 of 91 cards. Building now (worktrees `card-<id>` from `bbfb171` unless noted): T04-11 diff view, T04-12 editors (owns the UI's write opt-in: auth frame `write:true`, `canWrite` signal), T04-13 settings, T04-16 mode picker, TE-07 skills, TE-02 concise style (opt-in only), TE-01+TE-10 (from `d488d89`), FU-10 worktree installs (+ pair, lead). Merging: mode routing (staged), FU-08 next. After FU-10 + mode routing: flip lead, pair, tdd, redteam, swarm, debug to available and pass `config.worktrees.install` to the TDD executor.
- **Resumed 2026-10-31 evening** with four builders (load ~9): T04-02 review fixes, T04-04, FU-09, mode routing. T04-03, T04-05, FU-08 and T04-06 stay paused until slots free.
  - **T04-02 merged `9819eaf`** (+ review fixes `d81be9c`). Planner slip: that merge was committed with 2 failing tests because my gate line printed `EXIT=$?` and then exited 0 itself; both were load timeouts — `persistence` passes alone, the `runShellCommand` abort test got a 30 s limit in `7abbd61` and passes alone in 0.4 s. From now on check the vitest summary for "failed", not the wrapper's exit code.
  - Reviews: T04-04 O2 NEEDS_WORK (settings.get wrote the vault master key; settings.save accepted flag-like model ids; plus prompt symlink escape, playbook team references, atomic config writes) → fixing. FU-09 O2 NEEDS_WORK (a model could fake a stage denial by text; manual question lacked the danger reason; diff not re-checked after approval) → fixing. Mode routing O2 NEEDS_WORK (Ctrl+D hangs a prompt; tdd/redteam/debug/swarm marked available without the worktree dependency-install host duty — to stay unavailable for now; reviewer CLIs not tracked/killed) → fixing.
  - Still building: T04-03 (merging T04-02 in), T04-05. Paused: FU-08 events, T04-06.
- **Paused by the user on 2026-10-31 (afternoon).** All eight builders stopped; leftover test processes killed. Nothing in this batch is committed except T04-02's card commit `102812f`. Every worktree below holds **uncommitted, untested** work — review its `git diff` first, then finish:
  - T04-02 (`card-t04-02`, 5 files): O2 review PASS on `102812f`; in progress were the two should-fixes (duplicate `register` throws; `engine.hello` lists write methods only on write-capable connections) + a README note that stdio = full trust. Merge this first.
  - T04-03 write auth (`card-t04-03`, 9 files, from `102812f`): told not to do the hello fix itself; merge T04-02 in when it lands.
  - T04-04 library handlers (`card-t04-04`, 6 files, from `102812f`): typecheck passed; full gate was running.
  - T04-05 session handlers (`card-t04-05`, 7 files, from `102812f`): was updating the README, then gate.
  - FU-08 engine events (`card-fu-08-events`, 27 files): gate was running.
  - Mode routing (`card-mode-routing`, 7 files): was flipping `available: true` for 13 modes, to revert any that don't verify.
  - T04-06 UI scaffold (`card-t04-06`, 23 files): was updating the README.
  - FU-09 cleanup (`card-fu-09-cleanup`, 11 files): close to done.
  - Lesson: eight builders gating at once pushed load to ~415. Resume with at most 3–4 builders at a time.
- **Fan-out 2026-10-31 (owner: "use more agents").** In flight, each in `.claude/worktrees/card-<id>`:
  - T04-02 rest (`102812f`, Opus review running): typed client moved to protocol; `access: read|write` per method, writes default-denied, refused on serve (-32002).
  - From `102812f`: T04-03 write-auth for serve (Opus), T04-04 library handlers (Sonnet), T04-05 session/seat/worktree handlers (Sonnet).
  - From integration: FU-08 engine events for the views (Sonnet), mode routing — `assentor run --mode <id>` through prepareModeSession (Opus), T04-06 rest (Sonnet), FU-09 shared runner-file list + one approval per decision (Sonnet).
  - Phase 5 spikes (T05-01/02/03) need a Tauri app and runs on three OSes by the owner — not started.
  - Merge order: T04-02 first (the three cards above build on it), then whatever passes review. Every builder gates once with `--maxWorkers=2`; real-git timeouts under load get rerun alone.
  - Engine follow-ups the views need (they show "not in the event stream" today): proposal authors on `negotiation.proposal`; consensus threshold and decision rationale events; per-reviewer `review.verdict` with confidence; an emitter for `review.finding` with agreement; panel policy on `review.completed`.
  - Gate note: full suites at load 150–370 time out real-git tests (strategy-divide, swarm-mode, tdd-mode, cascade-mode); they pass alone. Run at most two gates at once.
- **Paused by the user on 2026-10-30 after merging T02B-18** (`b94c4a9`, Lead team board + lead log; Sonnet review fixes `426369a`). All agents stopped. Paused cards, all on branches `claude/card-<id>` from `248f8e0`, **uncommitted and untested** — review the diff first, then finish:
  - T02B-13 pair (Sonnet): `src/modes/pair.ts`, `tests/unit/mode-pair.test.ts`, registry/index/test edits, and an edit to its card text (revert unless the card asks for it). It was rerunning its gate when stopped.
  - T02B-15 swarm (Sonnet): `src/modes/swarm.ts`, `tests/unit/swarm-mode.test.ts`, registry/test edits, and a change to `src/negotiation/strategies/divide.ts` (shared code — needs O2 review). It was fixing a type cast when stopped.
  - T02B-19 retro (Haiku): `src/modes/retro.ts`, `tests/unit/retro.test.ts`. Its last full gate had four timeouts in three unrelated files under load ~450; recheck at normal load.
  - Load note: four builders gating at once pushed the load average to ~450 and left two orphaned vitest runs (killed). Next time run at most two builders' gates at once, `--maxWorkers=2`.
- **2026-10-30: all seven paused cards merged** (each after O2 review → fixes → PASS with nits; merge notes with open nits are on each card in phase-2b-modes.md):
  - T02B-09 playbook modes `93a2bdf` (owner signed off) · T02B-10 mode prompts `1cee6c9` · T02B-16 debug `7508edf` · T02B-02 Lead `6a6ada2` · T02B-11 TDD `ccb189e` · T02B-06 Cascade `edd296c` · T02B-14 red-team `8787d1f`.
  - Contract now: `ModeControllerInput` has `host`, `requestApproval`, `ask`, `resume`; `ControllerWorktrees` = create/diff/list/applyTo (applyTo("main") asks unless autopilot) + discard/markFailed/cleanup/readAtBase pass-throughs. Debug, Cascade and red-team route their own `approve` through `requestApproval`. `runShellCommand`/`RunVerificationCommand` take `signal` and `env`.
  - Follow-ups (not scheduled):
    - Double approval prompts: under manual both the session (per stage) and Cascade (per tier) ask; under supervised both the session and Debug/red-team ask before apply. Pick one owner of each question (routing card).
    - TDD (`RUNNER_CONFIG` in `src/modes/tdd/tamper.ts`) and red-team (`RUNNER_FILE`/`RUNNER_PACKAGE_KEYS` in `redteam.ts`) keep separate runner-file lists — unify.
    - Lead/Cascade/debug/TDD/red-team are not CLI-available; `assentor run` routing through `prepareModeSession` is its own Danger card. Namespace the playbook team names there.
    - Supervisor appends "Resume with: assentor resume" even to TDD's "locks lost" failure.
    - Cascade large-file tests are slow (~13 s each): build files from long lines instead of 450k short ones.
  - Flakes seen: `lead-report.test.ts` "brace-only input … fails fast" (283 ms vs 200 ms, once); `rpc-core` "catches up quickly…" (once). Cascade real-git tests timed out at load ~79 → describe timeout raised to 60 s in `8787d1f`.

**Direction (user, 2026-10-27): core engine first.** After the Haiku agents finish their current cards, UI and app work (rest of Phase 4, Phase 5) pauses. Finish the core (Phases 0–3, 2b) first, then build the UI and apps on top of it.

Web preview fast path: done enough to pause. T04-02p, T04-03p, T04-06p, T04-07p (board), T04-08p (seat drawer, `5eae232`), T04-15 (`assentor app`) are merged; T04-04p (read-only prompt/team/model RPCs) is in its last fix round with Haiku #2.

**Sessions**
- Haiku #1 ("Haiku implementer: Assentor task cards") — retired by the user (other account). Do not assign work to it.
- Haiku #2 ("Haiku implementer 2: Assentor task cards", worktree `haiku-two-cards-fd2328`) — FU-05 merged (T00-03 continue()/cursor model-flag tests; export strips zero-width chars before redaction; `rankCorrelatedFindings` re-exported — `severityRank` stays private). Waiting for the next core card.
- Haiku #3 ("Haiku implementer 3: Assentor UI cards", worktree `youthful-galileo-a41523`) — FU-04 done; waiting for the next core card.

**Contracts landed (user signed off 2026-10-27):** T02-03a negotiation strategy contract (`src/negotiation/`) and T02B-01a Lead/modes types (`src/modes/`), O2 NEEDS_WORK → fixed → PASS. They unblock Haiku cards T02-04 vote, T02-07 synthesize, T02B-03 report parser, T02B-04 roster, T02B-05 task board, T02B-08 auto router. Assignments: Haiku #2 → T02B-05 then T02B-03; Haiku #3 → T02-04 then T02-07; T02B-04/T02B-08 next.
- Sonnet session "Sonnet implementer: Assentor core cards" (started 2026-10-27) — 🟡 T01-03 panel policies, then T00-08 CI matrix.

**Core order (critical path):**
1. 🟡 T01-03 panel decision policies and 🟡 T00-08 CI matrix: Sonnet-tier, can run in a separate Sonnet session in parallel.
2. 🔴 T02-02 seat scheduler → 🔴 T02-03 negotiation engine + strategy contract (opens Haiku cards T02-04 vote, T02-07 synthesize; Sonnet T02-05/06/08).
3. 🔴 T02-01 worktree manager (needed by best-of-N, divide, Lead integrate).
4. 🔴 T02-09 stage-graph runner (needs T02-03 + T01-03) → 🔴 T02B-01 mode registry/controller contract (opens Haiku cards T02B-03/04/05/08/17) → 🔴 T02B-07 danger classifier → 🔴 T02B-02 Lead controller.
5. 🔴 T01-05 model switch; Phase 3 rest (T03-03 meta prompts after T02-03, T03-04 playbooks after T02-09).

**Gate under load:** FU-04 (`ad4fe08`, Haiku #3) fixed the two load-sensitive tests (rpc-core catch-up writes its 2,000-line log in one write; the supervisor test that spawns a real `npm test` has a 20 s timeout). The full gate passes with default workers again; if a different test times out under heavy load, rerun with `--maxWorkers=3` and record the test name here. 2026-10-29 at load ~150 (six agents gating at once): `modes-registry` "autonomy precedence…" runs and `evidence-pack` "includes committed files since git baseline" timed out; a timed-out run leaked its `MockExecutor` spy into the next test. Fixed in `a96ab80` with 30 s / 20 s timeouts.

## 9. Known follow-ups (not scheduled)

- rpc-core "catches up quickly" asserts delivery within 1 s; it missed once at load average ~139 (2 s) and passes alone. Loosen to a few seconds or measure relative to a baseline.

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
