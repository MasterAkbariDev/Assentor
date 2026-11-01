# Assentor — Implementation Task Board

Source plans: [app-and-multi-model.md](../plans/app-and-multi-model.md) · [desktop-app-system-design.md](../plans/desktop-app-system-design.md)

**Picking this up in a new session? Start with [STATUS.md](./STATUS.md)** — current progress, branches, the review/merge loop, and next actions.

This folder turns those plans into **task cards** sized for a model team:

| Tier | Model | Does | Never does |
|---|---|---|---|
| 🟢 **H** | Haiku (`claude-haiku-5-5`) | Well-specified, bounded code: pure functions, UI components, CLI wiring, schema additions, tests, prompt/playbook content | Design interfaces, touch anything on the **Danger list**, add dependencies on its own |
| 🟡 **S** | Sonnet (`claude-sonnet-5-5`) | Medium-complexity logic with judgment: strategies, policies, scaffolds, CI fixes. **Reviews every H task** | Danger-list items (except as reviewer of an O task) |
| 🔴 **O** | Opus (`claude-opus-5-5`) | **Contracts** (types/interfaces other tasks build on), core orchestration, every **Danger-list** item. **Reviews every S task and every task touching the Danger list** | — |

Human sign-off is required on every 🔴 task before merge.

**Totals (Phases 0–5 incl. 2b, 80 cards):** 🟢 Haiku 41 · 🟡 Sonnet 17 · 🔴 Opus 22. Haiku cards carry exact files, specs and tests; 🟡/🔴 cards carry goals, deliverables and acceptance and leave design decisions to the stronger model.

---

## 1. The Danger list (only 🔴 O may implement)

Anything that can lose user work, leak secrets, run untrusted code, or brick installs:

1. **Process lifecycle** — spawning, killing, process trees, Job Objects, interrupt/restart of CLI turns.
2. **Git mutations** — worktrees, merge, rollback, stash, checkout, branch deletion, anything outside `.assentor/`.
3. **Permission flags** — any `--dangerously-*`, `--yolo`, `bypass-approvals` handling, read-only vs edit seat enforcement.
4. **Secrets** — vault, keychain, API key handling, redaction rules.
5. **Network surfaces** — `serve` WebSocket, auth tokens, Origin checks, Tauri capabilities/CSP.
6. **Shell execution of user environment** — login-shell PATH resolution, user-defined CLI recipes.
7. **File deletion & path policy** — cleanup routines, `allowExternalPaths`, path traversal checks.
8. **Release & update chain** — signing, notarization, update manifests, CI secrets.
9. **Contracts** — shared types/protocols that ≥2 later tasks depend on.
10. **User config migration** — anything that rewrites `~/.assentor/*` or project `.assentor/config.yaml`.

If a 🟢/🟡 task discovers it needs to touch one of these → **stop and escalate** (see §4).

---

## 2. Workflow per task

```
 ┌──────────┐   card + kickoff prompt   ┌────────────┐   PR / diff + report   ┌──────────────┐
 │ Dispatcher│ ────────────────────────▶ │ Implementer │ ─────────────────────▶ │  Reviewer(s)  │
 │ (human or │                           │ H / S / O   │                        │ S or O (+O2)  │
 │  Opus)    │ ◀──── escalation ──────── │             │ ◀── NEEDS_WORK ─────── │               │
 └──────────┘                            └────────────┘                         └──────┬───────┘
                                                                                         │ PASS
                                                                                  human merge (🔴 always)
```

1. **One card = one branch = one PR.** Branch: `task/<ID>-<slug>` (e.g. `task/T00-03-recipe-model-flag`).
2. Implementer gets: the card + [templates.md §1 kickoff prompt](./templates.md) + nothing else required. Cards list the files to read.
3. Implementer must stay inside **Allowed files**. New files only where the card says.
4. Every PR must pass: `pnpm typecheck`, `pnpm test`, `pnpm build` (Phase 5 adds `cargo test`, `cargo clippy`).
5. Reviewer uses [templates.md §2 review checklist](./templates.md) and returns `PASS` / `NEEDS_WORK` / `BLOCKED` with evidence (yes — the same protocol Assentor itself uses).
6. Max **2 NEEDS_WORK loops** for an H task; on the 3rd, the task is re-tiered to S.
7. Dogfooding option: once Phase 1 ships, run H tasks through Assentor itself (`executor: claude-code --model haiku`, reviewers: Sonnet/Opus seats).

### Contract-first rule
Most 🟢 tasks depend on a 🔴 **contract** task that lands types + signatures + failing/skipped tests first. Haiku then implements against fixed interfaces — it never invents them.

---

## 3. Haiku rules (included in every kickoff prompt)

- Read every file in **Context to read** before writing code.
- Match existing style: ESM `.js` import suffixes, zod schemas, `strict` TS with `noUncheckedIndexedAccess`, tests in `tests/unit/*.test.ts` using vitest and importing from `../../src/...`.
- No new dependencies unless the card lists them.
- No refactors outside the card's scope, no renames, no formatting churn.
- Write the tests listed in the card; all existing tests must still pass.
- If anything is ambiguous, **escalate instead of guessing**.

---

## 4. Escalation triggers (all tiers)

Stop and file an escalation report ([templates.md §3](./templates.md)) when:
- The card is ambiguous or contradicts the code.
- You need a file outside **Allowed files**, or a new dependency.
- You hit a Danger-list item not owned by your card.
- A test you didn't write starts failing and the fix isn't obvious.
- An external CLI behaves differently from what the card states.

---

## 5. Task index

Legend: 🟢 H · 🟡 S · 🔴 O · Size S/M/L (≈ <150 / 150–500 / >500 changed lines)

### Phase 0 — Foundations · [phase-0-foundations.md](./phase-0-foundations.md)
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| T00-01 | Seat/Team/Session contract + event envelope ✅ | 🔴 O | O2 + human | M | — |
| T00-02 | Config schema: `teams`, `modes`, legacy mapping ✅ | 🟢 H | S | M | T00-01 |
| T00-03 | Model flag for CLI executor recipes ✅ | 🟢 H | S | S | — |
| T00-04 | Pass `model` through CLI reviewers (bug fix) ✅ | 🟢 H | S | S | — |
| T00-05 | Append-only session event log (NDJSON + seq) ✅ | 🟢 H | S | M | T00-01 |
| T00-06 | Output-delta coalescer ✅ | 🟢 H | S | S | T00-01 |
| T00-07 | Supervisor emits seat-scoped events ✅ | 🔴 O | O2 | M | T00-01, T00-05 |
| T00-08 | CI matrix: macOS + Windows + Linux ✅ | 🟡 S | O | S–M | — |
| T00-09 | Config save keeps `teams`/`modes`/new fields ✅ | 🔴 O | O2 + human | S | T00-02 |

### Phase 1 — Multi-seat review & model selection · [phase-1-review-models.md](./phase-1-review-models.md)
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| T01-01 | Model catalog + discovery (verified CLIs only) ✅ | 🟢 H | S | M | T00-03 |
| T01-02 | Seat factory: expand teams into reviewer seats ✅ | 🟡 S | O | M | T00-02, T00-04 |
| T01-03 | Panel decision policies ✅ | 🟡 S | O | M | T01-02 |
| T01-04 | Finding agreement counts ✅ | 🟢 H | S | S | — |
| T01-05 | Model switch at turn boundary + interrupt-now ✅ | 🔴 O | O2 + human | M | T00-07 |
| T01-06 | Shared status icon map + TUI seat board ✅ | 🟢 H | S | M | T00-07 |
| T01-07 | `assentor run --team` + doctor seat listing ✅ | 🟢 H | S | S | T01-02, T01-06 |

### Phase 2 — Negotiate mode · [phase-2-negotiate.md](./phase-2-negotiate.md)
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| T02-01 | Worktree manager ✅ | 🔴 O | O2 + human | L | T00-01 |
| T02-02 | Seat scheduler: concurrency, rate limits, budgets ✅ | 🔴 O | O2 | L | T00-07 |
| T02-03 | Negotiation engine core + strategy contract ✅ | 🔴 O | O2 + human | L | T02-02 |
| T02-04 | Strategy: Vote (ranked / Borda) ✅ | 🟢 H | S | S | T02-03 |
| T02-05 | Strategy: Debate ✅ | 🟡 S | O | M | T02-03 |
| T02-06 | Strategy: Best-of-N ✅ | 🟡 S | O | M | T02-01, T02-03 |
| T02-07 | Strategy: Synthesize ✅ | 🟢 H | S | S | T02-03 |
| T02-08 | Strategy: Divide & conquer ✅ | 🟡 S | O | L | T02-01, T02-03 |
| T02-09 | Stage-graph runner (plan → execute → review, tiebreak) ✅ | 🔴 O | O2 + human | L | T02-03, T01-03 |
| T02-10 | Pre-run cost estimator ✅ | 🟢 H | S | S | T00-02 |

### Phase 2b — Lead (Supervisor), Cascade & more modes · [phase-2b-modes.md](./phase-2b-modes.md)
Design: [modes.md](../plans/modes.md)
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| T02B-01 | Mode registry, controller contract, autonomy axis ✅ | 🔴 O | O2 + human | L | T02-09, T00-09 |
| T02B-02 | Lead controller (the Supervisor) | 🔴 O | O2 + human | L | T02B-01, 03, 04, 05, T02-01, T02-02 ✅ |
| T02B-03 | Agent report parser + claim verification ✅ | 🟢 H | S | M | T02B-01 |
| T02B-04 | Roster builder ✅ | 🟢 H | S | M | T02B-01, T01-01 |
| T02B-05 | Task board model ✅ | 🟢 H | S | M | T02B-01 |
| T02B-06 | Cascade mode | 🟡 S | O | M | T02B-01, T02B-07, T01-03 ✅ |
| T02B-07 | Danger-area classifier ✅ | 🔴 O | O2 | S | T02B-01 |
| T02B-08 | Auto mode router ✅ | 🟢 H | S | S | T02B-01 |
| T02B-09 | Playbooks: Pipeline, Explore, Plan | 🟢 H | S | S | T02B-01, T03-01, T03-04 ✅ |
| T02B-10 | Mode prompts (lead, navigator, attacker, …) | 🟢 H | O (quality) | M | T03-01, T02B-01 ✅ |
| T02B-11 | TDD mode | 🟡 S | O | M | T02B-01, T02B-12, T02-01 ✅ |
| T02B-12 | Test-tamper detector ✅ | 🟢 H | S | S | — |
| T02B-13 | Pair mode | 🟡 S | O | M | T02B-01, T01-05, T00-06 ✅ |
| T02B-14 | Red-team mode | 🟡 S | O | M | T02B-01, T02-01 ✅ |
| T02B-15 | Swarm mode | 🟡 S | O | L | T02B-01, T02-01, T02-02, T02B-06 ✅ |
| T02B-16 | Debug mode | 🟡 S | O | M | T02B-01, T02-01 ✅ |
| T02B-17 | CLI: `--mode`, `--autonomy`, `assentor modes` ✅ | 🟢 H | S | S | T02B-01 |
| T02B-18 | TUI: Lead team board + lead log | 🟢 H | S | M | T02B-02, T01-06 ✅ |
| T02B-19 | Retro stage | 🟢 H | S | S | T02B-01, T02B-10 ✅ |

### Phase 3 — Prompt library & playbooks · [phase-3-prompts.md](./phase-3-prompts.md)
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| T03-01 | Prompt format, layered loader, safe templating ✅ | 🟡 S | O | M | T00-01 |
| T03-02 | Built-in builder roles (planner, coder, …) ✅ | 🟢 H | O (quality) | M | T03-01 |
| T03-03 | Built-in reviewer & meta roles ✅ | 🟢 H | O (quality) | M | T03-01 |
| T03-04 | Built-in playbooks ✅ | 🟢 H | S | S | T03-01, T02-09 |
| T03-05 | `assentor prompts` CLI commands ✅ | 🟢 H | S | S | T03-01 |
| T03-06 | TUI Agents screen: fork/edit prompts ✅ | 🟢 H | S | M | T03-01, T03-05 |

### Phase 3b — Token economy & skills · [phase-3b-token-economy.md](./phase-3b-token-economy.md)
Measure first: TE-01 and TE-10 come first; every saving must pass the TE-10 net-tokens gate before it is on by default.
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| TE-01 | Usage ledger, report, budget warnings | 🟢 H | S | S | — ✅ |
| TE-10 | Token benchmark, A/B gate, prompt-size guard | 🟡 S | O | M | TE-01 ✅ |
| TE-02 | Output styles (concise / normal / verbose) | 🟢 H | S | S | TE-10 gate |
| TE-03 | Context packer (budgeted context) | 🟡 S | O | M | TE-01, TE-10 |
| TE-04 | Rolling summaries for long conversations | 🟡 S | O | M | TE-03 |
| TE-05 | Prompt caching and session reuse | 🟡 S | O2 | M | TE-01, TE-10 |
| TE-06 | Run profiles (economy / balanced / max) | 🟢 H | S | S | TE-02, TE-10 |
| TE-07 | Skills: on-demand instruction packs | 🟡 S | O2 | M | — |
| TE-08 | Built-in token-saver skills (benchmarked) | 🟢 H | O (quality) | M | TE-07, TE-10 |
| TE-09 | Pre-run estimate and confirm | 🟢 H | S | S | TE-01, TE-06 |

### Phase 4 — Engine server & Web UI · [phase-4-serve-web-ui.md](./phase-4-serve-web-ui.md)
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| T04-01 | Monorepo split (engine / protocol / cli / ui) | 🔴 O | O2 | L | Phase 0–3 merged ✅ |
| T04-02 | JSON-RPC core + stdio & in-process transports | 🔴 O | O2 | M | T04-01 ✅ |
| T04-03 | WebSocket transport (`serve`) security | 🔴 O | O2 + human | M | T04-02 ✅ |
| T04-04 | RPC handlers: prompts/teams/playbooks/settings | 🟢 H | S | M | T04-02 ✅ |
| T04-05 | RPC handlers: sessions/seats/worktrees | 🟡 S | O | M | T04-02, T02-09 ✅ |
| T04-06 | UI scaffold, Transport interface, event store | 🟡 S | O | M | T04-02 ✅ |
| T04-07 | Session board + SeatCard | 🟢 H | S | M | T04-06 |
| T04-08 | Seat drawer (transcript, xterm, actions) | 🟢 H | S | M | T04-06 |
| T04-09 | Negotiation view | 🟢 H | S | M | T04-06 |
| T04-10 | Review view | 🟢 H | S | M | T04-06 |
| T04-11 | Diff & worktrees view | 🟢 H | S (+O for apply/merge buttons) | M | T04-06 ✅ |
| T04-12 | Prompts / Teams / Playbooks editors | 🟢 H | S | M | T04-06 |
| T04-13 | Settings, Doctor, Onboarding | 🟢 H | S | M | T04-06 ✅ |
| T04-14 | Command palette + keyboard map | 🟢 H | S | S | T04-06 |
| T04-15 | `assentor app` launcher ✅ | 🟢 H | S | S | T04-03 |
| T04-16 | Mode picker (new session) | 🟢 H | S | S | T04-06, T02B-01, T02B-08 ✅ |
| T04-17 | Lead team board view | 🟢 H | S | M | T04-06, T02B-18 |
| T04-18 | Usage view (tokens, cost, budgets per run) | 🟢 H | S | S | T04-06, TE-01 |

### Phase 5 — Desktop (Tauri) · [phase-5-desktop-tauri.md](./phase-5-desktop-tauri.md)
| ID | Title | Tier | Review | Size | Depends |
|---|---|---|---|---|---|
| T05-01 | Spike: Node SEA engine sidecar on 3 OSes | 🔴 O | human | M | T04-02 |
| T05-02 | Spike: streaming perf harness | 🟡 S | O | S | T04-07 |
| T05-03 | Spike: GUI-launched CLIs, PATH + kill-all | 🔴 O | human | S | — |
| T05-04 | Rust host: sidecar supervisor + RPC broker | 🔴 O | O2 + human | L | T05-01 |
| T05-05 | Rust: process guard (Job Object / pgroup) | 🔴 O | O2 + human | M | T05-04 |
| T05-06 | Rust: login-shell PATH resolver | 🔴 O | O2 | S | T05-03 |
| T05-07 | Capabilities + CSP lockdown | 🔴 O | O2 + human | S | T05-04 |
| T05-08 | Keychain bridge | 🔴 O | O2 + human | M | T05-04 |
| T05-09 | `TauriTransport` in UI | 🟢 H | S | S | T05-04 |
| T05-10 | Tray, notifications, single-instance, window state | 🟢 H | S | M | T05-04 |
| T05-11 | Installer configs per OS | 🟡 S | O | M | T05-04 |
| T05-12 | Updater + signing + release workflow | 🔴 O | O2 + human | L | T05-11 |

### Phase 6 — Backlog · [phase-6-backlog.md](./phase-6-backlog.md)
Model scoreboard · session export · PR-review GitHub Action · MCP server mode · user-defined CLI recipes · Watch mode · Interactive mode · scoreboard-driven roster tuning.

---

## 6. Critical path & parallelism

```
T00-01 ─┬─ T00-02 ── T01-02 ── T01-03 ──────────────┐
        ├─ T00-05 ── T00-07 ─┬─ T01-05              │
        ├─ T00-06            ├─ T01-06              │
        │                    └─ T02-02 ── T02-03 ─┬─┴─ T02-09 ── T03-04
        └─ T02-01 ───────────────────────────────┤      │
T00-03 ── T01-01                                  ├─ T02-04/05/06/07/08
T00-04, T00-08, T01-04 (independent)              │
T03-01 ── T03-02/03/05/06                         │
T02-09 + T00-09 ── T02B-01 ─┬─ T02B-03/04/05/08/17 (Haiku, parallel) ── T02B-02 (Lead) ── T02B-18
                            ├─ T02B-07 ── T02B-06 (Cascade) ── T02B-15 (Swarm)
                            └─ T02B-11/13/14/16, T02B-09/10/19 (after T03-01)
T02B-12 (independent, Haiku any time)
                                  T04-01 ── T04-02 ─┬─ T04-03 ── T04-15
                                                    ├─ T04-04 / T04-05
                                                    └─ T04-06 ── T04-07…14
                                                    └─ T05-01 ── T05-04 ── T05-05…12
```

Maximum parallel Haiku work opens after T00-01 (T00-02, T00-05, T00-06 together with independent T00-03, T00-04, T01-04) and after T04-06 (eight UI screens at once).

---

## 7. Corrections to the plans found while writing these cards

1. **CLI reviewers drop the configured model.** `createReviewerTransport` (`src/cli/commands.ts`) never passes `options.model` to `CliReviewer`, and `buildCliArgs` (`src/providers/reviewers/cli/index.ts:342`) has no model flag. → fixed by **T00-04**.
2. **There are two separate CLI arg builders** — executor recipes (`cli-print/recipes.ts`) and reviewer adapters (`reviewers/cli/index.ts`). Model/permission handling must be added to both until they are unified (Phase 6 candidate).
3. **`PanelReviewer` already accepts N members**; the real gap is `count`, per-seat model, stable seat names, and decision policies — not "one per provider" as the plan states.
4. **CLI reviewer adapters lack Codex** (executor recipes have it). T01-02 adds a `codex` reviewer adapter.
5. **Verified CLI flags on the dev machine (2026-10-24):** `claude --model`, `codex exec -m/--model`, `agy --model` (+ `agy models` lists models, `--mode plan`, `--json-schema`), `cursor agent --model` (+ `--list-models`). Qwen and OpenCode not installed → unverified; cards treat them as such.
