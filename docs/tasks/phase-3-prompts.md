# Phase 3 — Prompt library & playbooks

Phase exit criteria:
- [ ] Built-in roles and playbooks ship with the package.
- [ ] A user can fork a built-in prompt or create a new one in `~/.assentor/prompts/`, override it per project, and use it in a team by id.
- [ ] Templating cannot execute code or read files.

---

### T03-01 · Prompt format, layered loader, safe templating
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T00-01

**Status: ✅ done.** Implemented by the planner (Opus); independent Opus review round 1 NEEDS_WORK (quadratic tag scan, error attribution, no override info) — fixed, round 2 PASS. Decisions (later cards build on these):
- `src/prompts/`: `PromptLibrary.load({ projectPath, builtinDir?, userDir? })`, `PromptLibrary.loadBuiltinSync()`, `get/has/list(role?)/render(id, vars)/versions(id)`, `errors[]` (`{ file, layer, message }`, each failure once, against the file at fault).
- Front-matter is `.strict()` (unknown keys are errors); `id` must equal the file name; required `id, role, title, version`. `PromptDefinition` adds `body, layer, file, overrides?` (the layer it replaced).
- Layers: `prompts/builtin` → `~/.assentor/prompts` → `<project>/.assentor/prompts`. A failed override keeps the lower prompt. `extends` resolves to a same-layer prompt, else the effective lower one, so a prompt can extend its own id. A child's `variables` replaces the parent's. Cycles: every member reports `extends cycle: a → b → a`.
- Templating: `{{name}}`, `{{#each list}}…{{/each}}` (`{{this}}`, item fields), `\{{` = literal `{{` (so a backslash right before a variable can't be written). Linear scanner; values literal; missing variables listed; syntax checked at load. `templateVariables` does not list names used inside each blocks.
- Path safety: only `.md` (lowercase; `.MD` is reported) directly in a layer dir; symlinks must resolve inside it; 256 KB cap. Layer dirs hold prompt files only (no README). `/prompts/*.md` is git-ignored because `~/.assentor` is the install checkout.
- `SPECIALTY_PROMPT_ADDENDA` reads `prompts/builtin/specialty-*.md` lazily on first access; parity is pinned by `tests/fixtures/specialty-addenda.json`. Only the built-in layer feeds it for now.
- Open: `output` enum has no value for Lead/moderator JSON (decide in T02B-10/T03-03); symlinked `.assentor/prompts` dir not checked against the project root.
- **Merge note:** `main` has an uncommitted edit to the architecture specialty text in `src/review/specialty-prompts.ts`; when merging, move it into `prompts/builtin/specialty-architecture.md` and the fixture.

**Goal** — Load prompts from built-in → user → project layers with validated front-matter and a minimal, safe template engine.

**Context to read** — plan §4.5, `src/review/specialty-prompts.ts`, `src/agents/index.ts` (`DEFAULT_AGENT_PROFILES`), `src/config/paths.ts`, `src/security/paths.ts`.

**Deliverables**
1. Format: Markdown with YAML front-matter. Schema: `id` (kebab-case), `role` (`builder | reviewer | meta`), `title`, `icon`, `description`, `recommendedModels[]`, `permissions` (`read-only | edit`), `variables[]`, `output` (`text | review-result | negotiation-proposal | ranking | synthesis | subtasks`), `version` (int), `extends?` (id).
2. Built-ins live in `prompts/builtin/*.md` at package root and are included in `package.json` `files`.
3. Loader: `PromptLibrary.load({ projectPath })` → map by id; later layers replace earlier (whole prompt, not merge) except `extends` which inherits front-matter then appends body. Detect cycles.
4. Templating: only `{{name}}` and `{{#each list}}…{{/each}}`; values inserted literally; unknown variables → error listing missing ones; **no** expressions, includes, or file access.
5. Path safety: only `.md` files directly inside the prompt directories; symlinks resolved and must stay inside the directory.
6. Errors per file are collected (`library.errors`) — a bad user prompt never prevents loading the rest.
7. Migrate `SPECIALTY_PROMPT_ADDENDA` to read from the library with identical text (snapshot test).

**Acceptance** — layer override, extends, cycle detection, missing variables, symlink escape rejected, invalid front-matter reported, specialty parity snapshot.

---

### T03-02 · Built-in builder roles
**Tier:** 🟢 H · **Review:** O (prompt quality) · **Size:** M · **Depends:** T03-01

**Status: ✅ done.** Shipped in `61448c1` + `61aa32b`. Opus prompt-quality review round 1 NEEDS_WORK (output parseability, safety rules, review handoff), round 2 PASS. Decisions:
- 11 builder prompts, variables only `{{name}}` from a fixed vocabulary (goal, acceptanceCriteria, projectSummary, plan, subtask, diff, testOutput, errorLog, conflicts, reviewFeedback); no vendor names; no stall phrases (tests import `STALL_PATTERNS`, now exported from `src/orchestrator/phase-steering.ts` — the one change outside the card's files).
- `planner` always outputs one JSON block `{ subtasks, notes?, question? }` (blocked / no-work shapes included); a directory in `ownedPaths` owns its subtree.
- Read-only roles may not edit or run repo-changing commands. Edit roles end with a `### Handoff` fenced JSON block (`whatChanged, why, assumptions, unchanged, risks, limitations, architectureSummary`) read by `findExecutorHandoff`.
- Safety rules: integrator never stages with markers and never uses ours/theirs shortcuts; devops never publishes/pushes/deploys; db-migrations never edits an applied migration or touches non-test databases.
- Follow-ups (FU-03): Handoff when blocked; engineer "outside the subtask" wording vs build outputs; planner blocked shape may carry `notes`; the `expected-fail:` test prefix is not read by the review pipeline yet.

**Goal** — Write the built-in prompts for roles that produce work.

**Context to read** — `docs/plans/app-and-multi-model.md` §4.5; `prompts/builtin/` format from T03-01 (and its README/example); `src/review/specialty-prompts.ts` (tone & evidence rules); `src/orchestrator/phase-steering.ts` (how executor prompts are phrased today).

**Allowed files** — create: `prompts/builtin/{planner,architect,engineer,refactorer,debugger,test-writer,docs-writer,devops,db-migrations,requirements-analyst,integrator}.md`, `tests/unit/builtin-prompts-builders.test.ts`.

**Spec (each file)**
1. Front-matter valid per T03-01; `role: builder`; `permissions: edit` except `planner`, `architect`, `requirements-analyst` (`read-only`).
2. Body sections in this order: `## Mission` · `## Inputs` (list the variables used) · `## Process` (numbered steps) · `## Output format` (exact structure; JSON schema-like block when `output` isn't `text`) · `## Rules` (must include: cite files you read; don't claim tests pass without running them; stay within the goal; ask via a question when blocked).
3. 300–900 words each. Imperative voice. No model-specific instructions, no vendor names.
4. `planner` output = `subtasks` (id, description, ownedPaths, dependsOn); `integrator` handles merge conflicts by explaining, never by deleting the other side silently.

**Tests** — load all with the library: zero errors; every variable used in the body is declared; word counts within range.

**Review focus** — clarity, no contradictions with the evidence protocol, outputs parseable by the strategies.

---

### T03-03 · Built-in reviewer & meta roles
**Tier:** 🟢 H · **Review:** O (prompt quality) · **Size:** M · **Depends:** T03-01

**Status: 🔶 partly done (T03-03a).** Reviewer half shipped in `cbb03b7` + `f4051cf` (+ two planner wording fixes in the merge: the ux example's evidence request is a `file` kind; the clean-PASS sentence says "where criteria are given"). Opus prompt-quality review: NEEDS_WORK → fixed → one contradiction left → fixed by the planner. **Not done (gated with negotiation):** `moderator`, `judge`, `negotiate-*`. Decisions:
- Six reviewers contain every specialty "Required checks"/"Evidence rules" bullet verbatim; `output: review-result` with one fenced JSON example that passes `makeReviewResult`; valid evidence-request kinds listed; BLOCKED for a human decision, FAILED only when the review could not be done; leaked secrets cited with `[REDACTED]` (counts as evidence for the veto).
- ux-reviewer covers CLI behaviour (help, exit codes, stdout/stderr, TTY/NO_COLOR, progress); performance-reviewer covers Node hotspots.
- `devils-advocate` (text, "What would change my mind") and `summarizer` (meta, no verdict) both redact secrets.
- FU-03 (`c98c190`): edit roles end with Handoff even when blocked; engineer may run builds; planner `notes` omitted when empty.

**Allowed files** — create: `prompts/builtin/{code-reviewer,security-reviewer,performance-reviewer,ux-reviewer,test-reviewer,architecture-reviewer,devils-advocate,moderator,judge,summarizer}.md` and negotiation step prompts `prompts/builtin/{negotiate-propose,negotiate-critique,negotiate-revise,negotiate-rank,negotiate-synthesize}.md`, `tests/unit/builtin-prompts-reviewers.test.ts`.

**Spec**
1. Reviewer roles: `role: reviewer`, `permissions: read-only`, `output: review-result`; reuse and expand the matching `SPECIALTY_PROMPT_ADDENDA` text (architecture/code/testing/security/performance/ui) — keep every "Required checks" and "Evidence rules" bullet.
2. `devils-advocate`: must argue the strongest alternative, cite evidence, and state what would change its mind.
3. `moderator`: decides whether consensus is reached; outputs `{ consensus: boolean, preferred, reasons[] }`.
4. `judge`: compares anonymized candidates (`Proposal A/B/…`) only; must not guess authorship.
5. Negotiation step prompts use variables `goal`, `proposals`, `critiques` as defined by T02-03; outputs match T02-03 schemas (`negotiation-proposal`, `ranking`, `synthesis`).
6. Same section structure and word limits as T03-02.

**Tests** — load with zero errors; reviewer prompts contain every bullet from the matching specialty addendum (string containment); variable declarations complete.

---

### T03-04 · Built-in playbooks
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T03-01, T02-09

**Goal** — Ready-made scenarios users pick instead of wiring stages by hand.

**Context to read** — `SessionSpec`/`StageSpec` (T00-01), `SessionRunner` (T02-09) docs, built-in prompt ids (T03-02/03).

**Allowed files** — create: `playbooks/builtin/{feature-build,bug-hunt,refactor-safely,security-audit,pr-review,write-tests,migrate-dependency,explain-codebase,incident-debug}.yaml`, `tests/unit/builtin-playbooks.test.ts`.

**Spec**
1. Each file: `id`, `title`, `description`, `stages[]` valid against `SessionSpec`, team **templates** using role ids and `provider: AUTO` placeholders (users bind real providers), `requireApproval` before any merge stage.
2. Read-only playbooks (`security-audit`, `pr-review`, `explain-codebase`) must have no `execute` stage and only read-only seats.
3. `feature-build`: plan(negotiate debate) → execute(best-of-n, 2) → review(panel, security-veto).

**Tests** — all parse; referenced prompt ids exist in the library; read-only rule enforced.

---

### T03-05 · `assentor prompts` CLI commands
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T03-01

**Status: ✅ done.** Shipped in `bfabd77`. Sonnet review PASS. Decisions: `-p, --project <path>` everywhere; `fork --to <user|project> [--as <id>]` writes with `wx` (never overwrites) and only renames the front-matter `id:` line; `edit` opens the project copy, else the user copy, via `resolveEditor` (VISUAL → EDITOR → notepad/vi, whitespace-split, no shell) and `spawnCliProcess`; `validate` exits 1 on any load error. Follow-up: tests for CRLF/`id:`-in-body/traversal ids (behaviour already correct).

**Allowed files** — modify: `src/cli/index.ts` (new `prompts` command group only); create: `src/cli/prompts.ts`, `tests/unit/cli-prompts.test.ts`.

**Spec**
- `assentor prompts list [--role <r>]` → table: id, title, role, source layer (`builtin|user|project`), overridden?
- `assentor prompts show <id>` → front-matter summary + body.
- `assentor prompts fork <id> [--as <newId>] [--project]` → copies to user (or project) dir; refuses to overwrite an existing file (exit 1, message `Prompt "<id>" already exists at <path>`).
- `assentor prompts edit <id>` → opens `$VISUAL`/`$EDITOR` (fallback: `notepad` on Windows, `vi` elsewhere) on the user/project copy; if only built-in exists, tells the user to `fork` first.
- `assentor prompts validate` → prints `library.errors`; exit 1 if any.

**Tests** — list/show/fork/validate with temp dirs; overwrite refusal; editor resolution function unit-tested (don't spawn editors in tests).

---

### T03-06 · TUI Agents screen: fork/edit prompts
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T03-01, T03-05

**Context to read** — `src/tui/screens/agents.tsx`, `src/tui/keymap.ts`, `src/tui/components/*`, `src/cli/prompts.ts` (reuse fork/editor helpers), `tests/unit/tui-keyboard.test.ts`.

**Allowed files** — modify: `src/tui/screens/agents.tsx`, `src/tui/keymap.ts` (new bindings only), `src/tui/screens/help.tsx` (document keys); create: `tests/unit/tui-agents-prompts.test.ts`.

**Spec**
1. List prompts grouped by role with source badge (`builtin/user/project`).
2. Keys: `f` fork (asks user vs project), `e` edit (suspends Ink, opens editor, resumes and reloads), `v` validate, `Enter` preview body in a scroll panel.
3. Errors from `library.errors` shown in a warning panel.
4. Update Help screen with the keys.

**Tests** — keyboard tests for f/e/v/Enter using existing test helpers (editor launch injected as a mock).
