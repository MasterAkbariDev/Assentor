# Templates

## 1. Kickoff prompt (paste above the task card)

### 1a. For 🟢 Haiku

```text
You are implementing ONE task card in the Assentor repository (TypeScript, Node 20+, ESM, vitest, zod, Ink).

Rules:
1. Read every file listed under "Context to read" before writing any code.
2. Only modify or create files listed under "Allowed files". If you need any other file, STOP and write an escalation report.
3. Do not add dependencies unless the card lists them.
4. Do not refactor, rename, or reformat code outside the card's scope.
5. Follow existing style: `.js` suffix on relative imports, zod for schemas, strict TS (noUncheckedIndexedAccess), tests in tests/unit/*.test.ts importing from ../../src/...
6. Implement exactly the "Spec". Write every test listed under "Tests".
7. Before finishing, run: pnpm typecheck && pnpm test && pnpm build. All must pass.
8. Never touch anything on the Danger list (process kill/spawn changes, git mutations, permission flags, secrets, network servers, file deletion, release config) unless the card explicitly owns it.
9. If anything is ambiguous or the code contradicts the card, STOP and write an escalation report instead of guessing.

Finish with a completion report:
- Files changed (list)
- What you implemented (bullets mapped to Spec items)
- Test results (paste the summary lines)
- Anything you were unsure about
```

### 1b. For 🟡 Sonnet / 🔴 Opus implementers

```text
You are implementing ONE task card in the Assentor repository. Read the card's context files and the
plans in docs/plans/. You may make reasonable design decisions inside the card's scope; record each in
the PR description under "Decisions". Contract tasks must ship: types, doc comments, and tests (skipped
tests are allowed only where the card says later tasks will fill them). Danger-list work must include
tests for failure paths (crash, timeout, cancellation, Windows path) — not only the happy path.
Run pnpm typecheck && pnpm test && pnpm build (and cargo test/clippy in Phase 5).
```

---

## 2. Review checklist (reviewer prompt)

```text
You are reviewing a PR for task card <ID>. Return PASS, NEEDS_WORK, or BLOCKED.
Every finding must cite file:line and concrete evidence. No style-only findings unless they break a card rule.

Check:
[ ] Scope — only Allowed files touched; no unrelated refactors; no new deps unless listed.
[ ] Spec — every Spec item implemented; nothing extra that changes behavior.
[ ] Acceptance — each acceptance criterion demonstrably met (point at test or code).
[ ] Tests — listed tests exist, assert behavior (not just "doesn't throw"), cover edge cases named in the card.
[ ] Backward compatibility — existing configs, CLI flags, and `assentor run` behave the same unless the card says otherwise.
[ ] Cross-platform — paths use node:path, no shell-specific syntax, no POSIX-only assumptions, CRLF-safe parsing.
[ ] Danger list — if the diff touches any Danger-list area not owned by this card → BLOCKED.
[ ] Errors — failures produce actionable messages; no swallowed errors except where existing code does the same deliberately.
[ ] Secrets — nothing logs or emits API keys/tokens; redaction still applied to events.

For 🔴 tasks also check:
[ ] Failure paths tested (crash, timeout, cancel, partial write, Windows).
[ ] No data loss possible on interruption (atomic writes, idempotent cleanup).
[ ] Contract types documented and minimal; later cards can implement against them without guessing.

Output:
STATUS: PASS | NEEDS_WORK | BLOCKED
REQUIRED CHANGES: numbered, each with file:line + why + what to do
OPTIONAL: numbered
```

---

## 3. Escalation report

```text
ESCALATION — Task <ID>
Trigger: ambiguous spec | file outside scope | new dependency | Danger list | failing unrelated test | CLI behaves differently
What I found: <evidence: file:line, command + output>
Options I see: 1) … 2) …
What I need: <decision / file permission / re-tier>
Work so far: <branch, what is done, what is not>
```

---

## 4. Task card template (for adding new cards)

```markdown
### TXX-YY · <Title>
**Tier:** 🟢 H | 🟡 S | 🔴 O · **Review:** S | O | O2 + human · **Size:** S/M/L · **Depends:** …

**Goal** — one or two sentences on the outcome.

**Context to read**
- `path` — why

**Allowed files**
- modify: `path`
- create: `path`

**Spec**
1. …

**Acceptance**
- [ ] …

**Tests** (`tests/unit/<name>.test.ts`)
- …

**Out of scope** — …

**Escalate if** — …
```
