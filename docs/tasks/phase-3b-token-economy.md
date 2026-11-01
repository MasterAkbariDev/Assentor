# Phase 3b — Token economy & skills

Added 2026-10-31 at the owner's request ("reduce token usage, simpler responses, token-saver skills — enhance and do whatever is best"). Runs in parallel with Phase 4: engine + CLI only, no UI dependency (the web usage view is T04-18).

**Principle:** measure first, then cut. Every saving is visible in the usage report (TE-01) and guarded by the token benchmark (TE-10), so a change that "saves tokens" but costs quality or silently grows prompts is caught.

**Why a "token-saver" can double usage (the owner saw this) — and the rules that prevent it:**
- *Always-on text is paid on every call.* A 600-token "be brief" skill sent with 40 calls costs 24k tokens before it saves anything. → Only a one-line index is always on (TE-07); bodies load on demand; the always-on overhead of styles + skills index has a hard cap (≤ 300 tokens per seat prompt), pinned by a snapshot test.
- *It can break prompt caching.* Inserting text into a stable prefix (or varying it per call) turns cached tokens into paid ones. → Skill/style text lives only in the static prefix, byte-stable (TE-05), and the benchmark reports cache hits.
- *Brevity can cost turns.* "Don't read whole files" can make an agent take five reads where one would do; "be short" can drop the handoff and trigger a retry. → Every skill is measured on **net tokens per completed task** (all calls, retries and follow-up turns), not on reply length.
- *Instructions can conflict.* A skill that contradicts the role prompt makes models hedge and repeat. → Skills are written against the built-in prompts and reviewed for conflicts (TE-08).

**Shipping gate (applies to TE-02, TE-03, TE-04, TE-05, TE-06, TE-08):** a change ships ON by default only if the TE-10 benchmark shows (a) net tokens per completed task down ≥ 10% on the fixture set, (b) no drop in task success, and (c) no growth in always-on prompt size beyond its budget. A skill or option that fails the gate ships OFF (opt-in) with its measured numbers in its description, or is dropped. Structural savings (prompt size, dedupe, caching) are measured with mock seats in CI; behavioural savings (shorter replies, fewer turns) need real models, so TE-10 has a `--live` A/B mode the owner runs with real CLIs/keys, and its results file is the evidence for turning a skill on by default.

What already exists: per-seat and per-session `limits.maxTokens` / `maxCostUsd` (scheduler), `seat.tokens` events, the cost estimator (`packages/engine/src/estimate/cost.ts`), cheap-first Cascade, routing, rolling summary in Lead, delta coalescer, evidence-pack caps.

Phase exit criteria:
- [ ] Every run ends with a token/cost breakdown; budgets warn before they stop.
- [ ] `--profile economy` and `--style concise` measurably cut tokens on the benchmark (target ≥ 40% vs `balanced`/`normal` on the fixture set) with no lost acceptance checks.
- [ ] Skills load on demand: only a one-line index is in every prompt.
- [ ] Built-in token-saver skills ship with the package and are on by default in `economy`.

---

### TE-01 · Usage ledger, report and budget warnings
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** —

**Merged 2026-11-01:** `8bb8386` + O2 fixes `6ffe7cb`, `558a97b`; re-review PASS. `UsageLedger` over `seat.tokens` (cached tokens inside tokensIn, priced at the cached rate when known); real counts from Claude Code's stream-json `result` usage for solo and mode-run executor turns (one source per turn); `assentor usage [sessionId] [--json]`; RPC `usage.get`; live 50/80% budget warnings. Limits: Codex, OpenCode, CLI reviewers (text output) and API seats report nothing yet (TE-05); mode-run executor tokens don't count toward scheduler budgets yet.

**Goal** — Make token use visible: per seat, stage, model and run.

**Deliverables**
1. `UsageLedger` folding `seat.tokens` (+ cached tokens when providers report them) into totals per seat / stage / model / session; cost via `estimate/cost.ts` prices.
2. End-of-run summary in the CLI reporter (one compact table; `--style concise` shows one line).
3. `assentor usage [sessionId] [--json]` reads the event log; default = last session.
4. Budget warnings as `session.warning` (kind `budget`) at 50% / 80% of `limits.maxTokens` and `maxCostUsd`, once each; the existing hard stop stays.
5. RPC read method `usage.get {sessionId}` (for T04-18).

**Acceptance** — ledger totals equal the sum of `seat.tokens` on a fixture log; warnings fire once at each threshold; `usage --json` schema-tested; old logs without cached-token fields work.

---

### TE-02 · Output styles (`concise | normal | verbose`)
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** —

**Goal** — Shorter answers from seats and from the CLI.

**Deliverables**
1. Config `output.style` + flag `--style`; `--brief` = `concise`. Default `normal` (unchanged behaviour).
2. A built-in prompt fragment per style (`prompts/builtin/style-concise.md`, `style-verbose.md`) appended to every seat prompt by the existing addendum path: answer first, no preamble or restating the task, bullets over prose, word caps per output type, never repeat code that didn't change, JSON-only where the output type is machine-read.
3. Reporter: `concise` prints one line per stage and the final summary only; `verbose` adds per-seat detail.
4. Machine-read steps (review-result, negotiation JSON, Lead actions) always get the strict JSON instruction regardless of style.

**Acceptance** — the fragment is included exactly once per seat prompt; the style never changes a JSON contract (schema tests on fixtures); `--brief` CLI output snapshot.

---

### TE-03 · Context packer (budgeted context assembly)
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** TE-01

**Built (branch `claude/card-te-03`, not merged):** `packages/engine/src/context/`. **ON by default (lossless):** identical proposals sent once, identical repeated blocks in failing-test output / history merged with a count, over-cap diffs keep their changed lines (`fitDiffChars`) instead of the first N characters, code fences closed after any cut. **OFF by default (every budget cut):** `context.budgetTokens.{reviewer,negotiation,lead,coder}` (unset or 0 = no cuts; nothing written on save; budgets are passed from the loaded config to each call site, no process state): reviewer evidence packing, negotiation shrink, Lead engine-state shrink, coder first-error+tail, ±3 diff context. Mock numbers (docs/benchmarks/tokens.md): the lossless part saves 0% on the original fixtures and on realistic large fixtures (their repeats differ); budget cuts save -8.5% (2500 tokens) / -21.9% (1000) on the large fixtures with success unchanged, and 0% on the original (too small to cut). The mock cannot show quality loss from cutting real contexts, so **turning any budget on needs the owner's live A/B** (`bench:tokens --live --variants context:packed@<tokens> --fixtures large`).

**Goal** — One place that builds what a seat sees, under a token budget, instead of ad-hoc slicing in each mode.

**Deliverables**
1. `packContext(sections, { budgetTokens })` with typed, prioritised sections: task, constraints, diff hunks (changed lines ± N context), failing-test output (tail + first error), file excerpts around referenced symbols, summaries, history. Lower priority sections shrink first; every cut leaves an explicit `[… N lines omitted — ask to see more]` marker.
2. Token counting: a fast estimator (chars/≈4 with per-model factor) — no tokenizer dependency.
3. De-duplication: identical blocks across sections sent once.
4. Adopt it in: review evidence packs, negotiation critique/revise rounds, Lead turn prompts, TDD/debug feedback to coders. Each adoption keeps its current hard caps as an outer bound.
5. Config `context.budgetTokens` per role (defaults chosen from the TE-10 benchmark).

**Acceptance** — packer unit tests (priority order, markers, dedupe, never exceeds budget); each adopted path still passes its tests; TE-10 shows prompt tokens down on the fixture set.

---

### TE-04 · Rolling summaries for long conversations
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** TE-03

**Goal** — Keep long negotiations, Lead runs and multi-round fixes from re-sending full history.

**Deliverables**
1. `summarizeHistory(turns, { keepLast, budgetTokens, seat })`: older turns folded into a fixed-size digest by the cheapest available seat (the `summarizer` prompt), last K turns verbatim; digests cached per (session, turn range).
2. Used by: debate/vote/synthesize after round 2, Lead turns (replacing its ad-hoc rolling summary if smaller), TDD/red-team/debug retry loops.
3. Digests are data: fenced, redacted, size-capped; the summarizer never sees secrets (redaction first).
4. Fallback when no cheap seat is available: deterministic truncation with markers.

**Acceptance** — a 6-round debate fixture sends ≤ the configured budget per round; digests reused (no re-summarising the same range); a summariser failure falls back without failing the run.

---

### TE-05 · Prompt caching and session reuse
**Tier:** 🟡 S · **Review:** O2 · **Size:** M · **Depends:** TE-01

**Goal** — Pay once for the parts of a prompt that never change.

**Deliverables**
1. Stable prompt order everywhere: (static) role prompt + style fragment + skills index → (shared) task/context → (per-seat) delta. A test pins the order.
2. API seats: Anthropic `cache_control` breakpoints on the static and shared blocks; OpenAI-compatible providers rely on automatic prefix caching (keep prefixes byte-stable). Read cached-token counts from responses into `seat.tokens` (TE-01).
3. CLI seats: prefer `continue()` on an existing executor session over re-sending history when the provider supports it (claude, codex); fall back to a fresh run with a packed context.
4. Panels/debates: shared context built once per round and reused byte-for-byte across seats (dedupe).
5. Report cache hit rate in the usage summary.

**Acceptance** — byte-identical prefixes across seats in a panel fixture; Anthropic request bodies carry the breakpoints (mock HTTP); cached tokens show in the ledger; no change to results on the mock fixtures.

---

### TE-06 · Run profiles (`economy | balanced | max`)
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** TE-02

**Built 2026-11-01 (branch `claude/card-te-06`):** `run.profile` + `--profile` on `run` and `resume`; one resolver, `applyRunProfile` / `reviewStrategyFor` / `routeSeatModel` in `packages/engine/src/config/profile.ts`, tested as a profile → effective-config table. A key still at its built-in default counts as unset (a profile fills it); any other value, or a flag, wins. `balanced` returns the config untouched. **Hard rule from the owner (a saver once doubled usage): a profile only switches on measured or no-risk things.** `economy` therefore sets only: one reviewer unless `classifyRisk` on the task text finds a danger area (then today's full panel), negotiation 2 rounds (early stop on consensus already exists), Lead planning/tests/docs seats on the cheapest capable model of their provider, `skills.enabled: [lean]` (empty today). Cascade already starts at the cheapest tier in every profile. It does NOT turn on `output.style: concise` (mock +7.8%) or `context.budgetTokens` cuts (mock 0% / -8.5% / -21.9%): pending the live A/B, so the exit criterion "economy cuts ≥ 40%" is not met and cannot be met by the mock. `max`: `FULL` review panel, verbose style, negotiation 5 rounds, `limits.maxRounds` 12. `assentor modes` and `--help` list what each profile changes. `bench:tokens --variants profile:<name>` runs the real resolver; the mock has one seat per task, so economy shows +0% (it does not model panel size, rounds or routing). Limits: danger is judged on the task text before the run (diff-based danger is only used by the modes that already do it); the profile is applied by the CLI run/resume paths, not by `serve` or the TUI yet.

**Goal** — One switch that trades cost for depth.

**Deliverables**
1. Config `run.profile` + flag `--profile`; default `balanced` (today's behaviour).
2. `economy`: cheapest capable model for planning/tests/docs/mechanical stages (routing + capability table), one reviewer unless `classifyRisk` says danger (then the full panel), negotiation max 2 rounds with early stop on consensus, Cascade starts at the cheapest tier, `output.style: concise`, token-saver skills on (TE-08), tighter `context.budgetTokens`.
3. `max`: full panels, verbose style, larger budgets.
4. Profiles only set defaults; explicit config/flags still win. Danger areas always get full review in every profile.
5. `assentor modes` / `--help` show what each profile changes.

**Acceptance** — profile → effective config table tested; danger-area runs keep the full panel under `economy`; TE-10 shows the economy saving.

---

### TE-07 · Skills: on-demand instruction packs
**Tier:** 🟡 S · **Review:** O2 · **Size:** M · **Depends:** —

**Merged 2026-11-01:** `8007fc8` + O2 fixes `4b4b3ac`, `3162274`; re-review PASS. `skills/<name>/SKILL.md` layered built-in → `~/.assentor/skills` → `<project>/.assentor/skills` with prompt-library path safety, 32 KiB cap, ≤ 200 dirs per layer. A capped skills index (≤ 200 tokens, "+N more") goes after the role prompt, labelled as names not instructions, byte-stable per role; bodies load by trigger or a trailing `load_skill:` line, fenced as reference, ≤ 3 skills / 4k tokens per seat, every delivery counted in `skill.loaded`. Project skills only for built-in builder roles on edit seats (never reviewers, Lead or negotiation steps). `assentor skills list|show|new`, RPC `skill.list/get`. Wired into `assentor run --mode`. Not wired yet: serve's session host, profiles (TE-06), reviewer skills (TE-08).

**Goal** — Reusable know-how that costs one line until it is needed (progressive disclosure), instead of long always-on prompt text.

**Deliverables**
1. Format: `skills/<name>/SKILL.md` (built-in, shipped) → `~/.assentor/skills` → `<project>/.assentor/skills`, same layering and path safety as prompts (no symlink escape, size caps, kebab-case names). Front-matter: `name`, `description` (≤ 200 chars, says *when* to use it), `roles?` (which seat roles may load it), `modes?`, `profiles?`, `autoload?` (trigger keywords / file globs), `version`.
2. Prompt integration: every seat prompt carries only a compact **skills index** (name + description, one line each, capped) in the static prefix (TE-05).
3. Loading: (a) automatic when a trigger matches the task or changed files; (b) on request — a seat's reply line `load_skill: <name>` makes the engine append that skill's body on the next turn (CLI seats) or immediately for API seats. Bodies are fenced as reference material, never as higher-priority instructions than the system prompt; a skill cannot grant permissions.
4. `assentor skills list | show <name> | new <name>` (scaffold), validation errors like prompts; RPC `skill.list/get` (read).
5. Events `skill.loaded {seatId, name, tokens}` so usage shows what skills cost.

**Acceptance** — index size bounded (test with 50 skills); trigger and on-request loading tested; a project skill can't escape via symlink; a skill naming a forbidden role is refused; loading is idempotent per seat.

---

### TE-08 · Built-in token-saver skills
**Tier:** 🟢 H · **Review:** O (quality) · **Size:** M · **Depends:** TE-07

**Built 2026-11-01 (branch `claude/card-te-08`):** the eight skills ship in `skills/`, all **off** (`optIn: true`; turned on by `skills.enabled`, by name or preset). Mock benchmark: every skill raises net tokens per task (+4% to +33%; all eight together +92% (3 bodies per seat), the owner's failure mode); the mock models costs (index + body) and no behavioural saving, so none passes the ship-on rule and the `lean` preset (`SKILL_PRESETS`) is empty. Numbers: `docs/benchmarks/tokens.md`; each description carries its own. Needs the owner: a `--live` A/B per skill; best candidates `review-signal-only` and `plan-in-bullets`. Passing skills go into `SKILL_PRESETS.lean`; TE-06's `economy` profile should expand that preset.

**Goal** — Ship a strong default set; on in `economy`, opt-in elsewhere.

**Skills** (each ≤ 400 words, concrete do/don't lists, one short example):
1. `answer-first` — lead with the result; no preamble, no restating the task, no closing summary of what was just said.
2. `targeted-reading` — search before reading, read line ranges not whole files, stop when the answer is found, never dump the repo.
3. `minimal-diff-edits` — edit the smallest region; never re-print unchanged files or code; prefer patches.
4. `smallest-solution` — the least code that fully solves the task; reuse before adding; no speculative options.
5. `test-triage` — read only the failing test and the first error; rerun the single test, not the suite.
6. `compact-handoff` — end with a fixed-shape handoff (done / changed files / open issues / next step) in ≤ 120 words.
7. `review-signal-only` — reviewers report only actionable findings with evidence; no praise, no restating the diff.
8. `plan-in-bullets` — plans as numbered steps ≤ 12 words each; no prose.

Plus a playbook preset `lean` that wires them to roles (builders: 2–6, reviewers: 1, 7; planners: 1, 8).

**Acceptance** — all load with zero errors; each passes a quality review for conflicts with the built-in role prompts; **each skill is benchmarked on its own and in the `lean` set** (TE-10 mock + live A/B): a skill that does not cut net tokens per successful task by ≥ 10% without lowering success ships off (opt-in, with its measured numbers in its description) or is dropped. The `lean` preset only includes skills that passed.

---

### TE-09 · Pre-run estimate and confirm
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** TE-01, TE-06

**Merged 2026-11-01:** `c440f51` + review fixes `0646d00`; Sonnet review. One estimate line before every run (tokens; dollars from this project's own observed prices — recent sessions' costUsd per model — never invented; "not enforced" line when a dollar limit has no observed price); solo includes the executor, mode runs say "excludes executor"; `limits.confirmAboveTokens/Usd` (no defaults written): ask on a TTY, refuse without one unless `--yes`; resume skips the gate; `session.estimate` event and estimate vs actual in the usage report.

**Goal** — No surprise bills.

**Deliverables**
1. Before a run: estimated tokens and cost for the chosen mode, team, profile (existing estimator + seat counts + rounds); shown in one line.
2. Config `limits.confirmAboveUsd` / `confirmAboveTokens`: above it, ask (TTY) or refuse (non-TTY) unless `--yes`.
3. After the run, the usage report shows estimate vs actual.

**Acceptance** — estimate shown for every mode; confirm/refuse paths tested; `--yes` skips.

---

### TE-10 · Token benchmark, A/B gate and prompt-size guard
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** TE-01 · **Built first, with TE-01** — every other card is judged by it.

**Merged 2026-11-01:** `1e08600` + O2 fixes `6ffe7cb`; PASS. `pnpm bench:tokens` (scripts/bench, dev only): 5 fixture tasks with success checks, mock (deterministic, CI) and `--live` (owner's CLIs, budget required) runners; net tokens per successful task; gate fails on < 10% saving, success drop, cached-share drop > 5 points, or always-on overhead over the variant's own size. Prompt-size snapshot (`scripts/bench/prompt-sizes.json`): ±5% fails; style + skills index measured from the shipped defaults, capped at 300 tokens. Needs the owner: live A/B runs to turn any saving on by default.

**Goal** — Prove net savings per completed task and stop regressions.

**Deliverables**
1. `pnpm bench:tokens [--modes …] [--variants baseline,concise,economy,skills:<name>]`: a fixed set of small fixture tasks (bug fix, add test, refactor, review a diff, plan a feature) each with an automatic success check. Every task × variant runs N times; the report gives, per variant vs baseline: prompt tokens, output tokens, cached tokens, calls/turns, retries, success rate, and **net tokens per successful task** with spread.
2. Two runners: `mock` (deterministic seats that echo realistic sizes — for CI, measures prompt structure, dedupe, caching, overhead) and `--live` (real CLIs/API keys the owner has; small budgets; never in CI) for behavioural effects.
3. The gate: `bench:tokens --gate <variant>` exits non-zero unless net tokens per success are down ≥ 10% with no success-rate drop (live) or prompt overhead stays within budget (mock). Card owners attach the gate output when asking to turn something on by default.
4. Prompt-size snapshot test (CI): the rendered always-on part of every role prompt (role + style + skills index) is pinned; growth > 5% fails until the snapshot is updated in review. Hard cap for styles + skills index: 300 tokens per seat prompt.
5. Results written to `docs/benchmarks/tokens.md` (mock numbers in CI; live numbers committed by the owner).

**Acceptance** — mock runs deterministic on repeat; a deliberately bloated skill fails the snapshot and the gate; a skill whose body is always injected (the owner's failure mode) shows higher net tokens and is rejected by the gate; live mode refuses to run without explicit `--live` and a budget.
