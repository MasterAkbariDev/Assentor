# Phase 1 — Multi-seat review & model selection

Phase exit criteria:
- [ ] `assentor run --team review-panel "…"` with `2× gemini(api) + 1× claude-code(cli, model opus)` runs, shows one live line per seat in the terminal, and returns a merged verdict using the configured policy.
- [ ] A seat's model can be changed during a run; the change applies at the next turn, or immediately with "interrupt now".

---

### T01-01 · Model catalog + discovery (verified CLIs only)
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T00-03

**Status: ✅ done.** Shipped in `c03b2ad` + `570554c` + `6108fd2`. Two Sonnet review rounds; final PASS. Decisions:
- Discovery spawns **without a shell** (`spawnCliProcess` with fixed args, tracked child, 15 s timeout via `killProcessTree`, 1 MB/stream cap); binary paths with shell metacharacters are rejected before spawning; a synchronous spawn throw becomes an error result.
- Parser per the revised rule above (separator-based, drops `auto`).
- A corrupt cache is backed up to `models-cache.json.corrupt-<ts>` before continuing empty; if the backup fails, writes are refused. Writes are serialized; `addUserModel`/`removeUserModel` roll back on a failed save; `discover` keeps in-memory results and returns an error if the save fails.
- Extra `locate` constructor option for tests. Callers wiring add/remove (UI/CLI) must surface thrown save errors.

**Goal** — For every seat provider, list selectable models: seeded defaults + discovered + user-added.

**Context to read**
- `src/models/registry.ts` (API model registry — do not change its behavior)
- `src/process/run-shell.ts` (use this to run discovery commands; do not modify it)
- `src/executors/cli-locator.ts` (`locateBinary`)
- `src/config/paths.ts` (user dir helpers, `ASSENTOR_USER_DIR`)

**Allowed files**
- create: `src/models/cli-catalog.ts`, `tests/unit/cli-catalog.test.ts`
- modify: `src/models/index.ts`, `src/index.ts` (exports)

**Spec**
1. `type CatalogEntry = { provider: SeatProvider; id: string; label: string; source: "seed" | "discovered" | "user"; }`
2. `SEED_MODELS: Record<cli provider, CatalogEntry[]>` — seed **aliases only** that the CLI documents as stable aliases: `claude-code: ["opus", "sonnet", "haiku"]`. Every other CLI starts with an empty seed (discovery or user-added). Add a comment: do not invent model ids.
3. Discovery commands (only these — verified on 2026-10-24):
   - `antigravity`: `agy models`
   - `cursor`: `agent --list-models` (or `cursor agent --list-models` when the located binary is the Cursor app)
   Run via `runShellCommand(command, cwd, { timeoutMs: 15_000 })` — it uses a shell, so build the command as `"<binary path>" models` with the located binary path in **double quotes** (paths may contain spaces, e.g. on Windows) and no user-supplied text. **Parser (revised after Haiku's escalation with real output — `agy models` prints `id<TAB>label`, `agent --list-models` prints `id - label` plus an `auto` entry):** a line is a model line only if it has a separator (first TAB, else first ` - `); id = text before it (trimmed), label = text after it (or the id); keep ids matching `^[A-Za-z0-9][A-Za-z0-9._/:-]*$`; lines without a separator (headers like "Fetching available models...") are skipped. Only if no line has a separator, fall back to bare ids (one per line, no spaces). Drop a discovered `auto` (case-insensitive) — the catalog's AUTO entry already means CLI default. De-duplicate by id (first wins). Timeout 15 s. On failure return `[]` and an `error` string — never throw.
4. `class CliModelCatalog` with:
   - `constructor({ cachePath?, run? })` — `cachePath` default `<userAssentorDir>/models-cache.json`; `run` injectable for tests.
   - `list(provider): CatalogEntry[]` — seed ∪ cached discovered ∪ user, de-duplicated by id (user > discovered > seed for label).
   - `async discover(provider): Promise<{ entries: CatalogEntry[]; error?: string }>` — runs the command, writes cache (`writeJsonAtomic`), returns entries.
   - `addUserModel(provider, id, label?)`, `removeUserModel(provider, id)` — persisted in the same cache file under `user`.
5. Always also allow `"AUTO"` as the first entry (`source: "seed"`, label "Auto (CLI default)").

**Acceptance**
- [ ] `list("claude-code")` → AUTO, opus, sonnet, haiku.
- [ ] Discovery output fixtures (write realistic multi-line strings in the test) parse into ids; garbage lines ignored.
- [ ] Discovery failure/timeout returns `error`, keeps previous cache.
- [ ] User models persist across instances (temp `ASSENTOR_USER_DIR`).

**Out of scope** — UI pickers, validation that a model works.

**Escalate if** — the real `agy models` / `agent --list-models` output on your machine doesn't fit the parser rules (paste the output).

---

### T01-02 · Seat factory: expand teams into reviewer seats
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T00-02, T00-04

**Status: ✅ done.** Implemented by the planner (Opus) because no Sonnet implementer was running; independent Opus review: round 1 NEEDS_WORK (codex sandbox not pinned), fixed. Decisions:
- `createReviewerSeats(team, deps)` in `src/seats/factory.ts` takes `createReviewer`, `resolveApiKey`, `defaultApiModel`, `specialtyAddendum`, `onStatus`, `onWarning` as injected deps (no import from `cli/`). Seat providers map to reviewer ids (`claude-code`→`claude`, `codex`, `antigravity`, `cursor`, `gemini`, `openai`, `mock`); `qwen`/`opencode` throw before any reviewer is built. Reviewer name = seat display name (`Opus#2`).
- CLI seats use only an explicit model; API seats on `AUTO` fall back to `models.*` like the legacy path. API keys come from `resolveProviderApiKey` (seats have no `keyId`). Team seats have no fallback reviewer (the seat schema has no fallback field).
- Edit review seats are downgraded to read-only with a warning. `assertReadOnlyReviewerArgs` rejects extra args that grant edit/unattended rights (`--dangerously-*`, `--yolo`, `--force`/`-f`, `--full-auto`, any sandbox flag, `--approve-for-me`, `--permission-mode`, `acceptEdits`, `--allowedTools`).
- Codex reviewer: `codex exec --sandbox read-only --skip-git-repo-check [-m model] <prompt>` — the sandbox is pinned because `~/.codex/config.toml` / profiles can widen the default.
- Team mode (`modes.review` set): members, preflight and labels come from the team (`reviewTargets`); `routing.reviewStrategy: SINGLE` does not cut a team to one seat; the panel is named `panel:team`. Event seat ids stay `reviewer-N`. Legacy path unchanged when `modes.review` is unset (test asserts the exact legacy seat data).
- Scope extension: `src/cli/preflight.ts` learned the `codex` binary/hint (it fell through to `agy`). Fixed the reviewer ENOENT hint to name the real env var per adapter.
- Follow-ups: codex prompt via stdin to avoid the Windows 8191-char cmd limit; a per-adapter allowlist instead of a denylist; run-level test of API-key wiring for a gemini team seat.

**Goal** — Turn a `Team` into concrete `Reviewer` instances (one per seat) with stable seat ids and names, feeding `PanelReviewer`.

**Context to read** — `src/cli/commands.ts:113-340, 460-530`, `src/review/coordinator.ts`, `src/review/backends.ts`, `src/providers/reviewers/cli/index.ts`, `src/core/seats.ts`, `src/config/teams.ts`.

**Allowed files** — create: `src/seats/factory.ts`, `src/seats/index.ts`, `tests/unit/seat-factory.test.ts`; modify: `src/providers/reviewers/cli/index.ts` (add `codex` adapter), `src/cli/commands.ts` (use factory when a review team is resolved).

**Deliverables**
1. `createReviewerSeats(team, deps): Promise<Array<{ seat: Seat; reviewer: Reviewer }>>` using existing `createReviewer` for each expanded seat; reviewer `name` = seat display name (so findings carry `Opus#2`).
2. Add `codex` CLI reviewer adapter: `codex exec --skip-git-repo-check [-m model] <prompt>` — **no** bypass/sandbox flags (reviewers are read-only). Document in code why.
3. Enforce `permissions: "read-only"` for review seats: if a team marks a review seat `edit`, downgrade with a warning (never pass edit/bypass flags to reviewers).
4. Keep legacy path identical when no teams are configured (snapshot test against v0.3.19 behavior).

**Acceptance**
- [ ] Team `{claude-code opus ×3}` → 3 reviewers named `Opus#1..3`, each passing `--model opus`.
- [ ] Mixed team → correct transports; API seats get keys via existing resolve logic.
- [ ] No reviewer arg list ever contains `dangerously`, `bypass`, `yolo`, `--force`.

**Reviewer focus** — permission flags (Danger list #3), legacy parity.

---

### T01-03 · Panel decision policies
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T01-02

**Status: implemented, awaiting review.** Decisions (on top of G-1; see STATUS §5):
- `security-veto` (default) is unchanged, including summaries. Other policies prefix the summary with `Panel [policy] M1 PASS, M2 NEEDS_WORK.`
- `majority`/`weighted` vote over the *answering* members (a PASS still needs every member via `PanelReviewer`'s G-1 guard, and the evidenced security veto runs after every policy). A split with no >50% winner is NEEDS_WORK; a PASS majority drops a dissenter's non-security objections.
- `weighted`: weight by seat role (`security*` = 2, else 1; `roleWeights` overrides), keyed per member id incl. `#2` duplicates. `roles` is passed from the seat roles by the CLI.
- `unanimous` never adjudicates (any BLOCKED → BLOCKED, else NEEDS_WORK). `adjudicator` rules on any split; with none configured (the CLI never configures one) it falls back to most-severe-wins and says so.
- `onDisagreement` runs on a split only when `tiebreak: "negotiate"`; `undefined`/throw falls back to the policy; its result still goes through the security veto and the failed-member guard.
- `src/review/index.ts` also exports `REVIEW_POLICIES`, `ReviewPolicy`, `defaultRoleWeight`.

**Goal** — `ReviewCoordinator.decide` supports `majority | unanimous | weighted | security-veto | adjudicator` from `modes.review.policy`; default `security-veto` keeps today's behavior exactly.

**Context to read** — `src/review/coordinator.ts` (whole), `src/agents/routed-reviewer.ts` (`reviewersDisagree`, `adjudicate`), `src/protocol/review-result.ts`, `tests/unit/multi-agent.test.ts`, `tests/integration/hardening-pack-panel.test.ts`.

**Allowed files** — modify: `coordinator.ts`, `src/cli/commands.ts` (pass policy); create: `tests/unit/panel-policies.test.ts`.

**Deliverables**
1. `ReviewCoordinatorOptions.policy?` (default `security-veto` = current algorithm, unchanged).
2. Policies:
   - `unanimous`: PASS only if all PASS; any BLOCKED → BLOCKED; else NEEDS_WORK with merged required changes.
   - `majority`: status with > 50% of seats; ties → NEEDS_WORK. Security blocker/major still vetoes (document).
   - `weighted`: weights from seat role (`security`=2, others=1 unless configured) — deterministic.
   - `adjudicator`: always adjudicate when >1 seat disagree (current behavior when routing is present).
3. Merged result's summary lists per-seat verdicts (`Opus#1 PASS, Gemini#2 NEEDS_WORK…`).
4. Hook point for `tiebreak: "negotiate"` — a `onDisagreement?: (findings) => Promise<ReviewResult | undefined>` option (implemented in T02-09).

**Acceptance** — table-driven tests for each policy across: all pass, split, security major, blocked, single seat.

---

### T01-04 · Finding agreement counts
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** —

**Status: ✅ done.** Shipped in `fc43032`. Sonnet review PASS, no required changes. Decisions:
- `severityRank()` extracted from `maxSeverity` (same ordering; unknown values rank last); clustering unchanged.
- `agreement.total` counts reviewers that produced any finding (not configured seats).
- `rankCorrelatedFindings` is exported from `src/review/coordinator.ts` only; re-export from `src/review/index.ts` when a consumer needs it (T04-10).

**Goal** — UIs can show "3/4 reviewers flagged `auth.ts:42`".

**Context to read** — `src/review/coordinator.ts:24-33` (`CorrelatedFinding`) and `:252-300` (`correlateFindings`), `tests/unit/multi-agent.test.ts`.

**Allowed files** — modify: `src/review/coordinator.ts` (only `CorrelatedFinding` + `correlateFindings` + new helper), create: `tests/unit/finding-agreement.test.ts`.

**Spec**
1. Add to `CorrelatedFinding`: `agreement: { count: number; total: number; ratio: number }` where `count = agentIds.length`, `total = number of distinct agentIds across all findings passed in`, `ratio = count / total` (0 when total is 0).
2. Add `export function rankCorrelatedFindings(list: CorrelatedFinding[]): CorrelatedFinding[]` — returns a **new** array sorted by severity, most severe first — use the same ordering as the existing private `maxSeverity` helper (`coordinator.ts` ~line 585); extract a shared `severityRank()` from it rather than writing a second ordering, then `agreement.count` desc, then `key` asc.
3. Do not change clustering logic.

**Acceptance / Tests**
- [ ] 4 reviewers, 3 report the same issue → `count 3, total 4, ratio 0.75`.
- [ ] Single reviewer → `1/1`.
- [ ] Ranking order as specified; input array not mutated.
- [ ] Existing multi-agent tests unchanged and green.

---

### T01-05 · Model switch at turn boundary + interrupt-now
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** M · **Depends:** T00-07

**Goal** — Change a running seat's model. Default: apply at next turn. Optional: interrupt the current turn and restart it with the new model.

**Context to read** — `src/orchestrator/supervisor.ts`, `src/providers/executors/cli-print/index.ts`, `src/providers/executors/cursor/index.ts`, `src/process/kill-tree.ts`, `src/process/tracker.ts`, plan §4.1.

**Deliverables**
1. `Executor`/`Reviewer` gain optional `setModel(model)` (applies to next invocation) — adapters store pending model.
2. Supervisor API `requestModelChange(seatId, model, { immediate })`; emits `seat.model.changed { pending: true }` then `{ pending: false }` when applied.
3. Immediate: cancel current turn via existing kill-tree; restart the same turn (same prompt + context) with session resume when supported, else fresh session with a summary of the partial output. Budgets: interrupted turn counts toward tool/runtime budgets but not rounds.
4. TUI hook: key `m` on focused seat (coordinate with T01-06) — keyboard handler only; picker uses T01-01 catalog.

**Acceptance** — tests with fake spawn: pending switch applied next turn; immediate switch kills exactly one process tree, restarts, no orphan (tracker empty), state machine stays valid; Windows path covered by unit test of kill invocation.

**Reviewer focus** — orphan processes, double-spawn races, budget accounting, resume correctness.

---

### T01-06 · Shared status icon map + TUI seat board
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T00-07

**Status: ✅ done.** Shipped in `2e79368` + `08ce336`. Sonnet review round 1 NEEDS_WORK (test gap), fixes verified by the planner. Decisions:
- `src/ui-shared/status.ts` (framework-free): `STATUS_META`, `reduceSeatEvents` (pure; insert-or-update on `seat.spawned`, keeps tokens on resume; placeholder for unknown seats; `outputTail` ≤ 1000 chars; a pending `seat.model.changed` does not change the model), `seatLineModel(seat, now, ascii?)`.
- `<SeatBoard seats width ascii? now?>` uses explicit column widths (Ink flex shrink doesn't clip). Ink 5.2.1 pads ⏸ and ⏳ as one column while drawing two, so each row keeps one spare column. ASCII icons get 4 columns.

**Goal** — Terminal users see one live line per seat with status icon, model, role, last activity, elapsed time.

**Context to read**
- `src/core/seats.ts` (`SeatStatus`), `src/protocol/events.ts`
- `src/tui/components/` (`badge.tsx`, `progress.tsx`, `table.tsx`, `index.ts`), `src/cli/ui/reporter.ts` (how runs render today)
- `tests/unit/tui-render.test.ts` (render test style)
- plan §4.6 status table

**Allowed files**
- create: `src/ui-shared/status.ts`, `src/tui/components/seat-board.tsx`, `tests/unit/seat-board.test.ts`
- modify: `src/tui/components/index.ts` (export)

**Spec**
1. `src/ui-shared/status.ts` (framework-free, reused by web UI later):
   - `STATUS_META: Record<SeatStatus, { icon: string; asciiIcon: string; label: string; tone: "muted" | "info" | "active" | "warn" | "ok" | "error" }>` using the plan table (`◌ ⟳ ✦ ✎ 🛠 ± ⏸ ⏳ ✓ ✗ ⚑`). `asciiIcon` fallbacks: `. ~ * > T +- || ... OK X !`.
   - `seatLineModel(seatState): { icon, label, name, model, role, detail, elapsed }` — pure, formats elapsed as `m:ss`.
   - `reduceSeatEvents(state, event): state` — pure reducer from `EngineEvent` to `Record<seatId, SeatState>` where `SeatState = { seat displayName, model, role, status, lastLine (≤ 120 chars, last non-empty line of output), startedAt, tokensIn, tokensOut }`.
2. `<SeatBoard seats={Record<string, SeatState>} width={number} ascii?={boolean} />` (Ink): one row per seat: `icon name · model · role  detail …  elapsed`. Truncate `detail` to fit `width`. Text label always present next to the icon (accessibility).
3. `ascii` true when `process.env.ASSENTOR_ASCII === "1"` or the terminal is Windows legacy console (`process.platform === "win32" && !process.env.WT_SESSION`) — pass this in from the caller; the component just accepts the prop.

**Acceptance / Tests**
- [ ] Reducer: spawn → thinking → writing (with deltas) → tool → done; lastLine updated; failure sets `failed`.
- [ ] Render at width 80 and 40 → no line exceeds width (use existing render helper).
- [ ] ASCII mode uses ascii icons only.

**Out of scope** — wiring into `RunReporter` (do in T01-07), web UI.

---

### T01-07 · `assentor run --team` + doctor seat listing
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T01-02, T01-06

**Status: ✅ done.** Shipped in `c79fd4b` + `ec305cd`. Sonnet review round 1 NEEDS_WORK (floating print promise), fixes verified by the planner. Decisions:
- `--team` on run/resume builds a new config via `withReviewTeam` (never saved); unknown team fails before any executor/reviewer (resume now loads config before looking up the task). `--reviewer` + `--team` is rejected first.
- The reporter does not render Ink: `RunReporter.onEngineEvent` folds reviewer seats with `reduceSeatEvents` and prints a plain-text "Review seats" section (via `writeln`, keeping the live status line) when the mirrored `review.verdict` (legacy `review.completed`) arrives and there is more than one reviewer seat. On the final round it can appear after "Task passed review" — accepted. Legacy multi-reviewer `reviewers:` configs now show this section too.
- `doctorAssentor({ projectPath?, config?, locate? })` prints a Teams section (✓/✗ for CLI seats, `api` otherwise; `teams: unavailable (…)` if config can't load).

**Goal** — Users can pick a configured team from the CLI and see seats live.

**Context to read** — `src/cli/index.ts:69-135`, `src/cli/commands.ts:440-560` (`runRun`), `:754+` (`doctorAssentor`), `src/seats/factory.ts`, `src/tui/components/seat-board.tsx`, `src/cli/ui/reporter.ts`.

**Allowed files** — modify: `src/cli/index.ts` (`run`, `resume`, `doctor` options), `src/cli/commands.ts` (`runRun`, `doctorAssentor`), `src/cli/ui/reporter.ts` (render seat board section when >1 reviewer seat); create: `tests/unit/run-team-flag.test.ts`.

**Spec**
1. `assentor run --team <name>` → sets the review team for this run (overrides `modes.review.team`). Unknown name → exit code 1 with the T00-02 error message.
2. `--reviewer` and `--team` together → error: `Use either --reviewer or --team, not both.`
3. Reporter: when the run has >1 reviewer seat, render `<SeatBoard>` lines during review; otherwise output stays byte-identical to today.
4. `assentor doctor` prints a "Teams" section: each team, each seat `displayName · provider/transport · model · permissions · binary found? (✓/✗)`.

**Acceptance / Tests**
- [ ] Flag parsing and both error messages.
- [ ] Single-reviewer run output unchanged (snapshot).
- [ ] Doctor lists seats with ✓/✗ using an injected locator.
