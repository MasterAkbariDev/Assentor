# Plan: Assentor App + Multi-Model Negotiate/Review

Status: **Draft for review** · Base: v0.3.19 · Author: planning pass

---

## 1. Where we are today (what we build on)

Assentor already has the right bones for this:

| Existing piece | File | Reuse for |
|---|---|---|
| Supervisor FSM + rounds + budgets + resume | `src/orchestrator/supervisor.ts` | Becomes one "mode runner" among several |
| `SupervisorEvent` stream (`executor.started`, `review.completed`, …) | `src/orchestrator/supervisor.ts:83` | Seed of the realtime event protocol |
| Protocol bus (in-memory, typed messages) | `src/protocol/bus.ts` | Inter-seat messaging for negotiation |
| `PanelReviewer` + `ReviewCoordinator` (veto, agree-merge, adjudicator) | `src/review/coordinator.ts` | Multi-reviewer core; extend to N instances per provider |
| CLI print recipes (claude, codex, agy, qwen, opencode, cursor) | `src/providers/executors/cli-print/recipes.ts` | Seat adapters; add model flags here |
| Stream parsers (cursor/agy stream-json) | `src/providers/executors/cursor/stream-status.ts`, `cli-print/text-stream.ts` | Live status/tool-call extraction |
| Specialty prompts + agent profiles | `src/review/specialty-prompts.ts`, `src/agents/index.ts` | Starting set for the prompt library |
| Key vault, routing engine, model registry | `src/keys/`, `src/routing/`, `src/models/` | Model catalog + AUTO selection |
| Ink TUI | `src/tui/` | Stays; becomes a client of the same engine |

**Gaps found while reading the code:**

1. **One executor, one reviewer slot.** `SupervisorConfig` takes a single `executor` and a single `reviewer` (`PanelReviewer` hides the fan-out). No concept of "N seats".
2. **CLI recipes have no model flag.** `PrintCliRecipe` cannot pass `--model`; model choice for CLIs is effectively whatever the CLI defaults to.
3. **Events are coarse and per-supervisor**, not per-agent. No token/cost/tool-call/output-delta events, no seat id.
4. **Engine and UI live in one process.** The TUI imports services directly; there is no API another client (desktop/web) can attach to.
5. **CI only runs on `ubuntu-latest`.** "Works on all OS" is not verified on macOS/Windows.
6. **Agents are view-only** in the TUI; there is no user-editable prompt store.

---

## 2. What kind of app — recommendation

### Recommended: engine-first, then one React UI shipped two ways

```
                 ┌──────────────────────────────────────────┐
                 │  assentor engine (Node, existing core)   │
                 │  sessions · seats · modes · prompts      │
                 │  event log (append-only, replayable)     │
                 └──────────────┬───────────────────────────┘
                                │ JSON-RPC + event stream
                                │ (in-process | WebSocket | stdio)
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   Ink TUI (existing)   Web UI (React+Vite)    Desktop app
   `assentor`           `assentor app`          (same React UI in a
   in-process           WebSocket, localhost    Tauri shell; engine as
                                                stdio sidecar)
```

**Phase A — `assentor serve` + local web UI.** One codebase (React), runs on every OS that runs Node + a browser, zero signing/notarization pain, ships via the existing npm/install scripts. `assentor app` starts the engine and opens `http://127.0.0.1:<port>`.

**Phase B — desktop app** around the *same* React bundle for installers, tray icon, native notifications, auto-update.

**Decision: Tauri v2 + React + Rust**, with the TypeScript engine bundled as a sidecar and Rust as a thin host. Full design: [desktop-app-system-design.md](./desktop-app-system-design.md). Electron remains the fallback if the sidecar/streaming spikes fail.

Why not skip straight to desktop: the hard part is the engine API + event protocol, not the window. Doing web first means the desktop shell is ~1–2 weeks of packaging work instead of a rewrite.

---

## 3. Core concepts (new domain model)

```
Session ── has many ─▶ Stages (plan → negotiate → execute → review → …)
Stage   ── has many ─▶ Seats
Seat    = { id, provider(cli|api), model, role, promptRef, transport,
            permissions(read-only|edit), worktree?, budget }
Team    = saved named set of seats   e.g. "3× Opus + 2× Codex"
Playbook= saved stage graph + teams + prompts for a scenario
```

- **Seat** is the key new abstraction: one running model instance. `3 × claude/opus` = three seats with the same provider/model but separate session ids, separate worktrees, possibly different role prompts.
- Seats get **stable display names + icons** (`Opus#1`, `Opus#2`, `Codex·sol#1`) so the UI and logs are readable.
- Config sketch:

```yaml
teams:
  heavy-negotiators:
    seats:
      - { provider: claude-code, model: opus, count: 3, role: engineer }
      - { provider: codex, model: "<codex model id>", count: 2, role: engineer }
  review-panel:
    seats:
      - { provider: claude-code, model: sonnet, role: security-reviewer }
      - { provider: gemini, transport: api, model: AUTO, role: code-reviewer, count: 2 }
      - { provider: codex, role: test-reviewer }

modes:
  negotiate: { team: heavy-negotiators, strategy: debate, maxRounds: 3, consensus: 0.7 }
  review:    { team: review-panel, policy: security-veto, tiebreak: negotiate }
```

---

## 4. Feature specs

### 4.0 Session modes (full catalog)

Negotiate (§4.2) and Review (§4.3) are two of **17 session modes**: Solo, Review, Negotiate, **Lead (Supervisor)**, Cascade, Pipeline, Pair, Race, Red team, TDD, Swarm, Debug, Explore, Plan, Interactive, Auto and Watch. Lead mode is the "team lead" AI: it picks agents and models per task, dispatches work, reads structured reports and manages the team without coding itself. **Mode** (how seats are organized) and **autonomy** (manual / supervised / autopilot) become two separate settings. Full design: [modes.md](./modes.md).

### 4.1 Realtime model selection for CLIs

1. **Per-recipe model flag**: extend `PrintCliRecipe` with `modelFlag` (`--model` for Claude Code/Cursor agent, `-m`/`--model` for Codex/Qwen, `-m provider/model` for OpenCode, verify for `agy`). Each must be verified against the installed CLI version during implementation — don't hardcode assumptions.
2. **Model catalog per CLI**: seeded list + `discover()` where the CLI exposes a list command, + user-added custom ids. Cached under `~/.assentor/models-cache.json`; refreshable from the UI.
3. **"Realtime" semantics** (important to be honest about): CLIs in print mode take the model at spawn time. So switching a seat's model applies **at the next turn boundary** — the engine resumes the same session (`--resume <id>`) with the new model where the CLI allows it, otherwise starts a fresh session seeded with a summary. The UI shows "switching after current turn…" and lets the user **interrupt now** (kill + restart turn) if they want it immediate.
4. Model picker everywhere a seat appears: seat card dropdown, command palette (`/model opus#2 → sonnet`), TUI (`m` on a focused seat).
5. Validation: picker greys out models the CLI/account can't use (detected via a cheap probe or last error).

### 4.2 Negotiate mode (multi-model collaboration)

Seats work together to produce **one** answer (plan, design, patch). Pluggable strategies:

| Strategy | How it works | Good for |
|---|---|---|
| **Debate** (default) | R1: each seat proposes independently → R2: each sees the others' proposals **anonymized** and critiques → R3: revise → moderator checks consensus | Design, architecture, tricky bugs |
| **Vote / ranked choice** | Each proposes, then all rank all proposals; Borda count | Picking between approaches |
| **Best-of-N** | Each seat implements in its **own git worktree**; verification gates run on each; judge panel picks/merges winner | Code changes with tests |
| **Divide & conquer** | Planner seat splits task → subtasks assigned to seats in parallel worktrees → integrator merges | Large features |
| **Mixture / synthesize** | All propose; an aggregator seat writes a merged answer citing sources | Plans, docs, specs |

Rules that make negotiation actually work (not echo chambers):
- **Anonymize** proposals across rounds (avoid "Opus said so" deference); reveal identities only in the UI.
- **Evidence-required critiques** — reuse the existing evidence-request protocol; critique without citations is down-weighted.
- Optional **devil's-advocate seat** with an explicit contrarian prompt.
- **Convergence**: stop when agreement ≥ threshold, or after `maxRounds`, or budget hit → moderator/judge decides and records dissent.
- **Isolation**: any seat that edits files gets its own `git worktree` under `.assentor/worktrees/<session>/<seat>`; read-only seats share the main checkout.
- Output: a `NegotiationResult { decision, rationale, dissent[], votes, transcriptRef }` persisted with the task.

### 4.3 Review mode (multi-reviewer, multi-instance)

- Generalize `PanelReviewer` from "one per provider" to **N seats**, any mix (`2× Gemini API + 1× Claude CLI + 1× Codex`).
- Each seat can carry a different **specialty prompt** (security, tests, architecture, UX…) or the same prompt for redundancy (majority voting reduces single-model hallucinated findings).
- Decision policies: `unanimous`, `majority`, `weighted` (by role/model track record), `security-veto` (existing), `adjudicator` (existing).
- **Finding de-dup & correlation** — extend `correlateFindings` so the UI shows "3/4 reviewers flagged `auth.ts:42`".

### 4.4 Negotiate + Review together

Modes compose as stages in a session:

```
plan(negotiate) → implement(single | best-of-N) → review(panel)
                       ▲                               │
                       └──── NEEDS_WORK (findings) ────┘
                     review disagreement? → reviewers enter negotiate(debate) → verdict
```

- **Reviewers can negotiate**: when the panel splits, instead of only an adjudicator, reviewers see each other's findings and debate to a verdict (tiebreak: `negotiate`).
- **Negotiators can be reviewed**: negotiation output (e.g. a plan) can pass through a review panel before execution.
- This is configured as a **Playbook** (stage graph), so users choose without code.

### 4.5 Prompt & agent library

Built-in, versioned prompts (markdown + YAML front-matter), plus user and project overrides:

```
built-in (shipped)  →  ~/.assentor/prompts/*.md  →  <project>/.assentor/prompts/*.md
```

```markdown
---
id: security-reviewer
role: reviewer
title: Security Reviewer
icon: shield
recommendedModels: [claude-code/opus, codex/*]
permissions: read-only
variables: [goal, diff, acceptanceCriteria]
output: review-result     # enforces the structured schema
---
You are a security reviewer… {{goal}} … {{diff}}
```

**Built-in roles** (initial set): Planner · Architect · Engineer/Coder · Refactorer · Debugger · Test writer · Code reviewer · Security reviewer · Performance reviewer · UX/accessibility reviewer · Docs writer · DevOps/CI · DB/migrations · Requirements analyst · Devil's advocate · Moderator · Judge · Integrator (merges worktrees) · Summarizer.

**Built-in playbooks** (scenarios): Feature build · Bug hunt · Refactor safely · Security audit · PR review · Write tests · Migrate dependency · Explain codebase · Incident/debug from logs.

UI: prompt list, editor with live variable preview, "try on this seat" button, duplicate/fork built-ins, import/export, diff vs. built-in version.

### 4.6 Streaming UI

**Event protocol** (replaces/extends `SupervisorEvent`, every event has `sessionId`, `seatId?`, `seq`, `at`):

`session.*` · `stage.started/completed` · `seat.spawned` · `seat.status` · `seat.output.delta` · `seat.thinking` · `seat.tool_call` (name, args summary, file) · `seat.tokens` (in/out/cost) · `seat.model.changed` · `seat.error` · `seat.done` · `negotiation.proposal` · `negotiation.critique` · `negotiation.vote` · `negotiation.consensus` · `review.finding` · `review.verdict` · `gate.result` · `budget.warning`

Persisted append-only to `.assentor/sessions/<id>/events.ndjson` → **replay**, **reconnect without loss** (client sends last `seq`), and crash recovery.

**Seat status icons** (same set in TUI and app):

| State | Icon | Meaning |
|---|---|---|
| queued | ◌ | waiting for a concurrency slot |
| starting | ⟳ | spawning CLI |
| thinking | ✦ (animated) | reasoning, no output yet |
| writing | ✎ | streaming text |
| tool | 🛠 / ⌘ | running a tool / command (shows which) |
| editing | ± | modifying files (shows count) |
| waiting | ⏸ | needs user input / approval |
| rate-limited | ⏳ | backoff with countdown |
| done | ✓ | finished turn |
| failed | ✗ | error (click for details) |
| vetoed / dissent | ⚑ | disagreed with consensus |

**Main screens (app):**
1. **Session board** — grid of seat cards (provider logo, model chip with dropdown, role, status icon, live last-line, elapsed, tokens/cost, mini progress). Stage rail on top (`Plan ✓ → Negotiate ● → Implement ○ → Review ○`).
2. **Seat drawer** — full streamed transcript, tool calls, files touched, diff; actions: pause, stop, restart, swap model, **inject message** (steer a running seat).
3. **Negotiation view** — proposals side by side, critique threads, vote tally, consensus meter, dissent notes.
4. **Review view** — findings grouped by file/severity with agreement count, verdict per reviewer, final decision.
5. **Diff & worktrees** — per-seat diffs, compare best-of-N candidates, apply/merge/discard, rollback to checkpoint.
6. **Prompts / Teams / Playbooks** editors.
7. **Settings** — CLIs detected + auth state, keys, budgets, concurrency, theme.

**TUI** gets a compact board (one line per seat with icon/model/status) using the same events, so terminal users aren't second class.

---

## 5. Things you didn't list but will need

| Area | Why it matters | Proposal |
|---|---|---|
| **Git worktree isolation** | 5 CLIs editing one checkout = corruption | Per-seat worktrees, auto-cleanup, merge UI |
| **Concurrency & rate limits** | 3× Opus in parallel will hit plan limits | Per-provider concurrency caps, queue (◌), backoff surfaced in UI |
| **Cost & quota tracking** | Multi-model runs multiply spend | Per-seat/session token + $ estimates, hard budgets, pre-run cost estimate |
| **Permissions per seat** | Reviewers shouldn't edit | `read-only` vs `edit`; don't pass `--dangerously-*` flags to read-only seats |
| **Human-in-the-loop** | Users will want to steer | Approve stage transitions, inject messages, pause/resume, "ask me before merging" |
| **Auth detection** | Most failures are "CLI not logged in" | Doctor checks per CLI, shown in Settings with fix-it command |
| **Pluggable CLI providers** | New CLIs ship monthly | User-defined recipes in `~/.assentor/providers/*.yaml` (binary, args, model flag, stream format) |
| **Model scoreboard** | Learn which models win/are accurate | Record negotiation wins, review precision (findings later confirmed), feed `AUTO` routing |
| **Session reports** | Share outcomes | Export session to Markdown/HTML (decision, dissent, diffs, costs) |
| **Headless/CI** | Use review panel on PRs | `assentor review --pr <n> --team review-panel` + GitHub Action |
| **MCP server mode** | Let Claude Code/Cursor call Assentor | Expose `negotiate`, `review` as MCP tools |
| **Security of `serve`** | Local server can run code | Bind 127.0.0.1 only, random token, CSRF/Origin check |
| **Cross-OS verification** | "All OS" must be tested | CI matrix: ubuntu, macos, windows; Windows path/ConPTY/`.cmd` shim tests |
| **Auto-update** | Desktop users expect it | `tauri-plugin-updater` (signed); CLI keeps existing `assentor update` |
| **Code signing** | Unsigned apps are blocked on macOS/Windows | Apple notarization + Windows signing cert in release workflow (needs accounts/secrets) |
| **Accessibility & theming** | Icons alone aren't accessible | Icon + text label, dark/light, keyboard-first, command palette |
| **Notifications** | Long runs | Native notification when a session needs input or finishes |

---

## 6. Phased roadmap

Each phase is shippable on its own.

### Phase 0 — Foundations (engine refactor) · ~1–2 wks
- Introduce `Seat`, `Team`, `Session`, `Stage` types; config schema (`teams`, `modes`) with backward-compatible defaults (old `executor`/`reviewers` map to a 1-seat team).
- Add `modelFlag` to CLI recipes; verify each CLI's flag; model catalog + discovery.
- New per-seat event protocol + `events.ndjson` persistence; adapt `Supervisor` to emit seat-scoped events.
- CI matrix on macOS + Windows + Linux.
- **Exit:** existing `assentor run` behaves identically; tests green on 3 OSes.

### Phase 1 — Multi-seat review + model selection · ~1–2 wks
- N-seat review panel (multiple instances per provider), decision policies, finding correlation.
- Model switch at turn boundary + interrupt-now.
- TUI compact seat board with status icons.
- **Exit:** `assentor run --team review-panel` with 2× Gemini + 1× Claude shows live per-seat status and a merged verdict.

### Phase 2 — Negotiate mode · ~2–3 wks
- Worktree manager (create/cleanup/merge).
- Strategies: Debate, Vote, Best-of-N first; Divide & conquer, Synthesize next.
- Anonymization, consensus detection, moderator/judge, dissent record.
- Composition: negotiate → execute → review; reviewer tiebreak via negotiate.
- Concurrency limiter + rate-limit queue + budgets per seat.
- **Exit:** "3× Opus + 2× Codex debate a plan, best-of-N implement, panel review" runs end-to-end from CLI.

### Phase 2b — Lead (Supervisor), Cascade & more modes · ~3–4 wks
- Mode registry + controller protocol; split "mode" from "autonomy" (old `--mode supervised/autopilot` kept as aliases).
- **Lead mode**: task board, roster-based agent picking, structured agent reports verified against diffs/gates, policy-checked actions, limits and loop detection.
- **Cascade mode** with a danger-area classifier (cheap → mid → strong tiers).
- **Auto** mode router; Pipeline, TDD, Explore, Plan as playbooks; Pair, Red team, Swarm, Debug next.
- **Exit:** "Lead (Opus) plans a feature, hires Haiku for tests and Sonnet for code, reviews reports, escalates one task to Opus, integrates after approval" runs end-to-end with mocks and manually with real CLIs. Tasks: [phase-2b-modes.md](../tasks/phase-2b-modes.md).

### Phase 3 — Prompt library & playbooks · ~1–2 wks
- Prompt file format, loader (built-in → user → project), templating, validation.
- Ship built-in roles + playbooks listed in §4.5.
- TUI: Agents screen becomes editable (or opens `$EDITOR`).
- **Exit:** user creates a custom "API designer" prompt and uses it in a team.

### Phase 4 — `assentor serve` + Web UI · ~3–4 wks
- JSON-RPC/WebSocket server (sessions, seats, prompts, teams, settings) with token auth, reconnect via `seq`.
- React + Vite UI: Session board, Seat drawer, Negotiation view, Review view, Diff/worktrees, Prompts/Teams/Playbooks editors, Settings, **mode picker** and **Lead team board** (kanban, lead log, org chart).
- `assentor app` launches server + browser.
- **Exit:** full session driven and observed from the browser on all 3 OSes.

### Phase 5 — Desktop app (Tauri) · ~2–3 wks (+ signing setup)
- Do the three spikes in [desktop-app-system-design.md §12](./desktop-app-system-design.md) first (they can run any time after Phase 0).
- Rust host: engine sidecar supervisor, RPC broker, process guard, PATH resolver, keychain, tray, notifications, updater.
- Installers (`.dmg`, NSIS `.exe`, AppImage/`.deb`); release workflow with signing/notarization.

### Phase 6 — Extras (pick based on usage)
- Model scoreboard feeding AUTO routing and Lead's roster · session export reports · `assentor review --pr` GitHub Action · MCP server mode · user-defined CLI provider recipes · **Watch mode** daemon · **Interactive** team chat (needs Phase 4 UI).

---

## 7. Risks & open questions

**Risks**
- **CLI churn**: flags/stream formats change often → recipes must be data-driven and covered by contract tests against recorded output.
- **Cost blow-up**: 5 seats × 3 rounds × big contexts. Mitigate with pre-run estimates, budgets, and summarizing proposals between rounds.
- **Subscription limits**: running several Claude/Codex CLI sessions concurrently may hit plan limits faster than API usage; concurrency caps default low (e.g. 2 per provider).
- **Consensus quality**: models converge on plausible-but-wrong answers. Mitigate with evidence requirements, verification gates, and a contrarian seat.
- **Windows**: process trees, `.cmd` shims, long paths in worktrees — needs real Windows CI, not just unit tests.

**Decisions I need from you**
1. ~~Desktop shell~~ → **Tauri v2** (decided; see desktop design doc for its own open questions).
2. **Does the TUI stay first-class**, or become a "lite" client once the app ships?
3. **Default negotiation strategy**: Debate (recommended) or Best-of-N?
4. **Code signing**: do you have / want Apple Developer + Windows signing certificates? (Needed for a smooth desktop install.)
5. **Scope of v1**: ship Phases 0–3 (CLI/TUI) first as v0.4, then the app as v0.5 — or app-first?
6. **Model ids**: exact model ids for each CLI (e.g. the Codex model you call "sol") should come from discovery/user config — OK to not hardcode any?
7. **Modes**: see the four decisions in [modes.md §10](./modes.md) (naming, first-release modes, Lead's default model, auto-integration).

---

## 8. Proposed first PR (if approved)

Phase 0, part 1 — no behavior change:
- `Seat`/`Team` types + schema with legacy mapping
- `modelFlag` on recipes + `--model` plumbing for Claude Code and Codex (verified against installed versions)
- seat-scoped events behind the existing `onEvent`
- CI matrix (macOS, Windows, Linux)
