# Plan: Session Modes (Lead/Supervisor, Cascade, Pipeline, …)

Status: **Draft for review — design only** · Companion to [app-and-multi-model.md](./app-and-multi-model.md) · Tasks: [phase-2b-modes.md](../tasks/phase-2b-modes.md)

A **mode** decides *how seats are organized and who decides what happens next*. Negotiate and Review were the first two; this document adds a full catalog, with **Lead mode** (the "supervisor" team lead you asked for) as the centerpiece.

---

## 1. Naming — avoid three things called "supervisor"

The code already uses the word twice:

| Existing thing | Where | Meaning |
|---|---|---|
| `Supervisor` class | `src/orchestrator/supervisor.ts` | The executor ↔ reviewer loop engine |
| `--mode supervised \| autopilot` | `src/core/run-mode.ts` | How much the loop steers itself |

Proposal:

| Concept | New name | CLI | Notes |
|---|---|---|---|
| Team-lead AI that picks and manages agents | **Lead mode**, shown as **"Lead (Supervisor)"** in UI | `--mode lead` | `--mode supervisor` accepted as an alias |
| How much a session runs without asking the user | **Autonomy**: `manual \| supervised \| autopilot` | `--autonomy …` | `--mode supervised/autopilot` keeps working as a deprecated alias |
| How seats are organized | **Mode** | `--mode <id>` | solo, review, negotiate, lead, cascade, … |

So **mode** and **autonomy** become two independent axes: any mode can run manual, supervised or on autopilot.

---

## 2. Two kinds of control

| | Static modes | Dynamic modes |
|---|---|---|
| Who decides the next step | A fixed stage graph (playbook) run by `SessionRunner` (T02-09) | An LLM **controller seat** that issues validated actions |
| Examples | Solo, Review, Negotiate, Pipeline, TDD, Red team, Swarm, Explore | **Lead**, Cascade (partly), Auto |
| Predictability | High | Lower → strict policy, budgets, approvals |
| Built on | Stages + strategies | **Controller protocol** (§4) + the same stages/strategies as tools |

Both share everything underneath: seats, scheduler, worktrees, gates, events, prompts.

```
                        ┌───────────────────────── Mode ─────────────────────────┐
                        │  static: stage graph          dynamic: controller seat │
                        └───────────────┬───────────────────────────┬────────────┘
                                        ▼                           ▼
       stages / strategies  (negotiate, best-of-n, panel review, gates, merge …)
                                        ▼
       seat scheduler · worktrees · budgets · event log · prompt library
```

---

## 3. Mode catalog

| # | Mode | Shape | Who decides | Edits code | Best for | Phase |
|---|---|---|---|---|---|---|
| 1 | **Solo** (classic) | 1 executor ↔ review loop | Static | ✓ | Small, clear tasks; today's `assentor run` | exists |
| 2 | **Review** | N reviewers, policy merge | Static | ✗ | PRs, audits, second opinions | 1 |
| 3 | **Negotiate** | N peers reach consensus | Static (strategy) | Optional | Design decisions, hard bugs | 2 |
| 4 | **Lead (Supervisor)** | Lead seat + dynamic team; agents report to lead | **Dynamic** | ✓ (agents only) | Multi-part features, unknown scope | 2b |
| 5 | **Cascade** (escalation ladder) | Cheap model first; escalate on failure / risk | Rules + classifier | ✓ | Cost control; your Haiku → Sonnet → Opus workflow, automated | 2b |
| 6 | **Pipeline** (assembly line) | Requirements → Architect → Coder → Tester → Reviewer → Docs | Static | ✓ | Well-understood feature work | 2b |
| 7 | **Pair** (driver / navigator) | One codes, one watches the live stream and interjects | Static + live inject | ✓ | Tricky code where early correction saves rework | 2b |
| 8 | **Race** (tournament) | N implement in parallel worktrees; judge picks | Static | ✓ | When approach is unclear | 2 (best-of-N) |
| 9 | **Red team** (adversarial) | Builder vs attacker: attacker writes failing tests/exploits; builder fixes; repeat | Static loop | ✓ | Security, robustness, parsers | 2b |
| 10 | **TDD** | Test-writer writes failing tests (gate: must fail) → coder makes them pass (gate: tests untouched) | Static + gates | ✓ | Behavior with clear specs | 2b |
| 11 | **Swarm** (map-reduce) | Split many small independent items across cheap seats; reduce/merge | Static | ✓ | Lint fixes, migrations, renames across 100s of files | 2b |
| 12 | **Debug** (hypothesis) | Seats propose hypotheses; each tests one in its own worktree with instrumentation; evidence ranks them | Static | Worktrees only | Flaky tests, prod incidents | 2b |
| 13 | **Explore** (research) | Seats investigate a question read-only; synthesizer answers with citations | Static | ✗ | Onboarding, "how does X work", impact analysis | 2b |
| 14 | **Plan** (architect only) | Produce spec + task cards (like `docs/tasks/`), no code | Static | ✗ (docs only) | Before big work; feeds Lead or Cascade | 2b |
| 15 | **Interactive** (team chat) | User chats; lead routes messages to seats; seats reply in thread | Dynamic (user-driven) | ✓ | Exploratory sessions | 4 (needs UI) |
| 16 | **Auto** | Router picks a mode from task analysis; user confirms | Classifier | — | Default for new users | 2b |
| 17 | **Watch** (continuous) | Daemon reacts to commits/PRs/CI failures, runs a chosen mode | Trigger rules | Configurable | CI review bot, nightly audits | 6 |

Cross-cutting **stages** any mode can append:
- **Retro** — after a session, a summarizer writes lessons (what failed, which model did well) to project memory and updates the model scoreboard.
- **Approval gate** — pause for the user (always before merging into the user's branch unless autonomy = autopilot *and* policy allows).

---

## 4. Lead mode (Supervisor) — detailed design

### 4.1 What it is

A **lead seat** behaves like a team lead:
1. Reads the goal and the project (read-only).
2. Breaks it into a **task board** (tasks with owners, dependencies, file ownership, acceptance criteria).
3. **Picks agents**: chooses role + provider + model per task from the **roster** (what's installed, logged in, its cost, strengths and past performance).
4. Dispatches tasks; agents work in their own worktrees.
5. Agents **report** back in a structured format; the lead reviews reports (and can call a review panel or gates).
6. Lead reassigns, splits, escalates to a stronger model, asks the user, or accepts.
7. Lead integrates accepted work (via the integrator role / worktree manager) and finishes with a summary.

The lead **never edits code itself**. It only acts through the action protocol, so every decision is visible, validated and logged.

```
                         ┌──────────────── Lead (Supervisor) ────────────────┐
         goal ─────────▶ │ plan board · pick agents · review reports · merge │ ◀── user (approve / steer)
                         └──────┬─────────────┬─────────────┬────────────────┘
                     assign     │             │             │      report (structured)
                    ┌───────────▼──┐  ┌───────▼──────┐  ┌───▼──────────┐
                    │ Opus#1       │  │ Haiku#1      │  │ Codex·sol#1  │
                    │ engineer     │  │ test-writer  │  │ refactorer   │
                    │ worktree A   │  │ worktree B   │  │ worktree C   │
                    └──────────────┘  └──────────────┘  └──────────────┘
                            └──── gates · review panel (on lead's request) ────┘
```

### 4.2 Controller protocol (actions the lead may emit)

Each lead turn returns JSON actions. The engine **validates every action against policy** before executing it.

| Action | Effect | Policy checks |
|---|---|---|
| `plan_tasks(tasks[])` | Create/replace tasks on the board | ≤ `maxTasks`; file ownership doesn't overlap for parallel tasks |
| `assign(taskId, { role, provider, model, permissions })` | Spawn or reuse a seat, start the task | Provider available; ≤ `maxSeats`; `edit` only if mode allows; budget headroom |
| `message(seatId, text)` | Send guidance to a working agent (uses `seat.inject`) | Rate limit |
| `request_report(seatId)` | Ask an agent for a status report now | — |
| `review(taskId, { team?, policy? })` | Run a review panel or gates on a task's worktree | Budget |
| `escalate(taskId, { model })` | Reassign to a stronger model | Escalation limit per task |
| `reassign(taskId, seatId)` / `split(taskId, tasks[])` | Move or break up work | Reassign limit per task (anti-loop) |
| `accept(taskId)` / `reject(taskId, reason)` | Close or reopen a task | Accept requires passing gates if configured |
| `integrate(taskIds[])` | Merge accepted worktrees into the session branch | Approval gate per autonomy; conflicts → user |
| `ask_user(question, options?)` | Pause for a decision | — |
| `retire(seatId)` | Stop an idle seat | — |
| `finish(summary)` | End the session | All tasks closed or explicitly abandoned |

Invalid actions are returned to the lead as errors (it may retry) and counted; too many invalid actions → pause and ask the user.

### 4.3 Agent report schema

Every agent turn in Lead mode ends with a report (prompted + parsed; lenient parser with one repair attempt):

```json
{
  "taskId": "T3",
  "status": "done | in_progress | blocked | needs_input | failed",
  "summary": "Implemented OAuth callback handler",
  "filesChanged": ["src/auth/callback.ts"],
  "testsRun": [{ "command": "pnpm test auth", "passed": true }],
  "confidence": 0.8,
  "blockers": [],
  "questions": [],
  "suggestedNext": "Add rate limiting (separate task)"
}
```

Claims are **checked, not trusted**: `filesChanged` is compared with the worktree diff, `testsRun` with gate results; mismatches are flagged to the lead.

### 4.4 Choosing agents — the roster

The lead receives a **roster** each turn (compact table), built from:
- **Model catalog** (T01-01) — what's installed and selectable per CLI.
- **Capability profile** per provider/model (seeded defaults, user-editable): strengths (`coding`, `reasoning`, `ui`, `tests`, `docs`), speed tier, cost tier, context size, tool abilities.
- **Availability** — logged in, rate-limited right now, concurrency slots free.
- **Scoreboard** (T06-01, promoted) — past acceptance rate and review pass rate per model and role in this project.
- **User policy** — allowed providers, max cost tier, "never use X for Y", required models for danger areas.

Default heuristic hints given to the lead (overridable): cheap/fast models for tests, docs and mechanical edits; strong models for architecture, security-sensitive and cross-cutting changes; never one model reviewing its own work.

### 4.5 Keeping the lead sane

- **Context compaction**: the lead sees the board + latest reports + a rolling summary, not full transcripts (summaries produced by a cheap summarizer seat).
- **Limits**: `maxSeats`, `maxTasks`, `maxReassignPerTask`, `maxEscalationsPerTask`, `maxLeadTurns`, session budget.
- **Loop detection**: repeated identical assign/reject cycles → pause and ask the user (reuse `LoopDetector` ideas).
- **Lead failover**: if the lead seat fails, the session pauses with the board intact; user can resume with another lead model.
- **Determinism for tests**: a scripted `MockLead` drives the controller in tests.

### 4.6 Config

```yaml
modes:
  lead:
    lead: { provider: claude-code, model: opus }      # the supervisor seat (read-only)
    roster:                                           # who it may hire; omit = everything available
      - { provider: claude-code, models: [opus, sonnet, haiku] }
      - { provider: codex }
      - { provider: gemini, transport: api }
    limits: { maxSeats: 6, maxTasks: 20, maxReassignPerTask: 2, maxEscalationsPerTask: 2 }
    policy:
      dangerAreas: strong-only        # see Cascade §5
      integrate: approve              # approve | auto (auto only with autonomy=autopilot)
      reviewBeforeAccept: true
```

### 4.7 UI

- **Team board** (kanban): Backlog → Assigned → In progress → In review → Accepted / Rejected, cards show owner seat + model icon + status.
- **Lead log**: every action with its reason and validation result (accepted/refused).
- **Org chart**: lead → seats, live status icons.
- Controls: approve integration, override an assignment, pin a model for a task, pause the lead.

---

## 5. Cascade mode (escalation ladder)

Automates the workflow you're running by hand with Haiku/Sonnet/Opus.

```
task ─▶ classify risk ─┬─ danger area? ─────────────────────────▶ strong tier (implement) ─▶ strong review + approval
                       └─ normal ─▶ cheap tier implements ─▶ mid tier reviews ─┬─ PASS ─▶ accept
                                          ▲                                    └─ NEEDS_WORK ×N ─▶ escalate tier
                                          └──────────── retry with findings ───┘
```

- **Tiers** are configurable lists of seat specs, e.g. `[haiku] → [sonnet] → [opus]`.
- **Risk classifier** (deterministic first, LLM optional): task text keywords + **paths touched** matched against a configurable danger list (defaults mirror `docs/tasks/README.md` §1: process spawning/killing, git mutations, permission flags, secrets/vault, network servers, file deletion, release/signing, config migration).
- **Escalation triggers**: N failed review rounds, gate failures, low confidence, reviewer flags danger area mid-task, agent reports `blocked`.
- **Never self-review**: reviewer tier ≥ implementer tier and a different seat.
- Records which tier finally succeeded → feeds the scoreboard, so routing gets cheaper over time.

---

## 6. Other modes — design notes

**Pipeline** — playbook of single-seat stages with typed handoff artifacts (requirements.md → design.md → diff → test report → review → docs). Any stage can be a team (e.g., review panel).

**Pair** — driver seat streams; navigator seat receives coalesced deltas every K seconds or on tool calls and may `inject` a short correction. Navigator budget is capped; roles can swap per subtask. Needs T01-05/inject plumbing.

**Red team** — round: attacker (read-only + may add tests in its own worktree) produces failing tests or a reproducible exploit description → builder fixes → gates confirm attacker's tests now pass and nothing else broke → repeat until attacker gives up or rounds exhausted. Attacker tests are kept as a regression suite.

**TDD** — Gate A: new/changed tests must **fail** on the base commit. Gate B: after coder, same tests pass. **Tamper check**: coder may not modify the test files from step A (diff check), unless the reviewer approves an explicit test-change request.

**Swarm** — splitter produces work items (files or symbols) from a query or file list; scheduler runs many cheap seats with small contexts; each item is a tiny worktree diff or patch; reducer applies patches in order and runs gates once per batch; failures retried on a stronger tier (Cascade inside Swarm).

**Debug** — collect evidence (logs, failing test) → K seats each propose one hypothesis + a discriminating experiment → each runs it in its own worktree (instrumentation allowed, not merged) → results ranked by evidence → fix stage on the winning hypothesis.

**Explore** — read-only seats each take an angle (callers, data flow, tests, history); synthesizer writes the answer with file:line citations; optional "save as doc".

**Plan** — planner + architect (optionally negotiated) produce a spec and task cards in the `docs/tasks` format with tier suggestions; output can be fed directly into Lead or Cascade.

**Interactive** — chat thread per session; `@seat` mentions route to a seat; otherwise the lead routes. Needs the web/desktop UI.

**Auto** — `suggestMode(task)` uses the existing `TaskComplexityAnalyzer` + keywords + repo size: e.g. "audit/review" → Review; "why/how does" → Explore; many files + mechanical verb → Swarm; high risk → Cascade with strong tier; multi-part feature → Lead. Always shows its reasoning and asks to confirm (unless autopilot).

**Watch** — `assentor watch` daemon with trigger rules (`on: push | pr | ci_failed | schedule`) → mode + team; read-only by default; posts results (PR comment, notification). Phase 6 (process lifecycle + tokens → Danger list).

---

## 7. Composition rules

- Modes can **call each other as tools**: Lead can run a Negotiate for a design decision or a Review panel before accepting; Cascade escalation can switch a task into Lead; Swarm uses Cascade per item.
- Nesting limit: depth 2 (configurable) to avoid runaway sessions.
- Every nested run is a child stage in the same session event log, so the UI shows one timeline.

---

## 8. New events (additive to the T00-01 catalog)

`mode.selected` · `lead.turn` · `lead.action` (with `accepted | refused` + reason) · `task.created` · `task.assigned` · `task.status` · `task.report` · `task.escalated` · `task.accepted` · `task.rejected` · `cascade.escalated` · `pair.interjection` · `redteam.attack` · `tdd.gate` · `swarm.item` · `user.question` · `user.answer`.

---

## 9. Safety summary

| Risk | Mitigation |
|---|---|
| Lead hires too many / expensive models | Roster + policy + limits + budget preflight; refused actions are visible |
| Lead loops (assign → reject → assign) | Per-task reassign/escalation caps + loop detector → ask user |
| Agents lie in reports | Claims verified against diff and gates |
| Dangerous edits by cheap models | Cascade danger classifier forces strong tier + approval |
| Merges without consent | `integrate` gated by autonomy + policy; never into user's branch without approval by default |
| Runaway nesting | Depth limit, session budget |

---

## 10. Decisions needed

1. Naming: **Lead (Supervisor)** with id `lead`, and rename the old run mode axis to **autonomy** (keeping `--mode supervised/autopilot` as aliases)?
2. Which modes for the first release of Phase 2b? Recommendation: **Lead, Cascade, Auto, Pipeline, TDD, Explore, Plan** first; Pair, Red team, Swarm, Debug next.
3. Lead default model: strongest available (recommended) or user must pick?
4. May Lead **auto-integrate** under autopilot, or always require approval?
