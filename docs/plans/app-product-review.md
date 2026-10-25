# Assentor app: consolidated product plan and review

Date: 2026-10-24. Status: proposed plan, reviewed in discussion with Opus; no implementation authorized by this document.

Sources: `docs/plans/app-and-multi-model.md` and `desktop-app-system-design.md` on `claude/multi-model-cli-app-9319c3`, commit `f920db6`. Codex also inspected the current main checkout, which contains existing uncommitted reviewer/evidence changes. Opus reviewed the committed baseline. Findings below distinguish existing foundations from proposed work; implementation must start from the integrated current code, preserving those changes.

## Recommendation

Build a reliable local review and orchestration engine, then a useful browser app, then consider a desktop shell. Keep TypeScript, the existing supervisor, TUI, adapters, evidence-request protocol, and persistence. Evolve them instead of introducing competing stores or rewriting the engine in Rust.

The first product promise is: **know which revision was reviewed, what each reviewer actually received, what failed, and why the result can be trusted.** More models and more debate do not substitute for this.

Codex initially favored an earlier browser vertical slice. Opus argued that panel correctness must come first; Codex accepted that after checking the code. Subsequent discussion moved prompt provenance and reviewer evidence quality ahead of negotiation. There is no remaining material disagreement. The snapshot storage implementation and desktop shell remain open technical choices.

## Problems to fix in the original plan

| Finding | Evidence in existing code | Consequence |
|---|---|---|
| A panel can PASS with failed members | `PanelReviewer` errors only when all fail; `decide` accepts one surviving result | Count configured members and their terminal outcomes, not only returned verdicts |
| Multiple reviewer instances already partly work | Config has `reviewers[]`; coordinator accepts `Reviewer[]` | Extend identity, scheduling and policy; do not rebuild fan-out |
| CLI reviewer model is silently dropped | `createReviewerTransport` does not forward `options.model`; CLI recipes lack model selection | Verify flags per adapter/version; reject unsupported explicit model requests |
| Codex is an executor, not a reviewer adapter | Reviewer schema and `resolveCliAdapter` exclude Codex | Add it deliberately after scheduling/cancellation prerequisites |
| Identities can collide | Backend names fall back to profiles, which cycle | Separate unique seat ids from display names, provider and role |
| Persistence is observability, not a durable command log | `Supervisor.emit` calls observers before fire-and-forget append and suppresses errors | Append before publish; define recovery and command semantics |
| Existing persistence is under `.assentor/tasks` | `TaskStore` already stores snapshots, history and events | Version/migrate it; avoid a parallel sessions store |
| No API tool loop exists | `AIProvider.generate` takes a prompt and returns text | Evidence requests first; API tools/MCP client require new execution machinery |
| MCP inspection is only a request type | Evidence collector returns unfulfilled for `McpInspection` | Do not present it as an existing MCP integration |
| Agent profiles and memory already persist | `AgentRegistry` and `AgentMemoryStore` | Migrate these into the prompt/profile design |
| Evidence is repeatedly cut by character limits | Builder limits files/diff; formatter cuts file bodies, diff and the final block again | Replace truncation with allocation and explicit coverage |
| Risk selection depends primarily on task text | Review-member construction passes task text to complexity analysis | Derive risk from the actual changed code too |
| A workspace filename does not mean a package split exists | Current workspace configuration has no package layout | A monorepo move is real migration work; postpone it |

These are source-review findings, not results from executing provider CLIs or tests in this planning task.

## Product concepts

| Concept | Responsibility |
|---|---|
| Prompt template | Instructions, variables, output schema and declared capability requirements |
| Skill | A reusable `SKILL.md` workflow with optional references, scripts and assets |
| Agent profile | A role with prompt/skill references, recommended models and default policy |
| Seat specification | One configured member: unique id, provider, transport, model request, role and budget |
| Seat instance | One runtime identity, harness session, effective model and context epoch |
| Attempt/turn | Identified execution with inputs, evidence revision, terminal outcome and usage |
| Team | Saved collection of seat specifications |
| Playbook | Initially a fixed pipeline of built-in stage types, parameterized by teams |
| MCP connection | External tools, resources and prompts; separate from the agent itself |
| Task/session | One owned, persisted run with artifacts, decisions and recovery state |

Capabilities are versioned by adapter and reported as enforced, best effort, unsupported or unknown. Track model requested, resolved and provider-reported effective model separately. If effective model cannot be verified, display that. A context reset increments the context epoch.

## Reviewer quality: the central workstream

### 1. Freeze and identify the reviewed state

Every review binds to a revision: base commit, captured content manifest, diff hash and referenced artifacts. Include staged, unstaged, committed-since-baseline and eligible untracked changes. CLI and API reviewers must review this same state. A verdict becomes stale if its required inputs change.

Enumerate scope before capture. Exclude sensitive content, oversized content and unsupported external/submodule state according to a visible policy. Record exclusions and their consequences for completeness. Do not blanket `git add -A`: that can retain secrets in Git objects before redaction. Do not modify the user's index, refs or object database.

Two viable mechanisms: an isolated Git object directory with a temporary index, or a task-local content-addressed copy. Spike these with renames, deletions, untracked files, submodules, large files and worktrees before choosing. Detect changes during capture, retry within a bound, then mark the revision unstable if consistency cannot be established. State explicitly what is outside the snapshot, including ignored files, environment and external services.

Sensitive rows contain safe metadata only; avoid exporting content or secret hashes. Retain sensitive filenames only under the applicable policy. Snapshot redaction and outbound provider redaction are separate steps.

### 2. Classify changes and record coverage

Build a deterministic manifest, independent of model output. Each row records path/old path, change type, language, size, line counts, class, risk tags, revision references and inclusion/omission reasons.

Classes: source, tests, configuration, build, CI, infrastructure, migrations, documentation, lockfiles, generated, vendored, binary and sensitive. Risk tags include authentication, permissions, process execution, network, filesystem paths, SQL, deserialization, dependencies, public interfaces, concurrency and weakened tests. Use these signals alongside task complexity, never merely the user's description.

Special handling:

- New files need actual contents; ordinary `git diff` does not include untracked contents.
- Deletions need old-side evidence and caller checks. Renames need old/new identity plus content changes.
- Lockfiles need dependency deltas and resolution/integrity checks, with exact sections available on request. A summary is not proof that the change is safe.
- Generated/minified/vendor content should not consume the entire budget. Show provenance and source relationships, run configured generation checks, and retain a route to inspect meaningful changes.
- Migrations, CI and infrastructure get high priority. Large ones require batches rather than a promise to fit everything.
- Binary files get appropriate metadata; images use vision only where supported. Unsupported content remains explicit.

The full manifest lives on disk. Very large changes use deterministic manifest shards, with global counts and an index. Every omitted changed path remains accounted for by the engine.

### 3. Allocate model context deliberately

Budget the complete request: instructions, contract, manifest/shards, evidence, history, tool schemas if present, and output reserve. Use provider/model token counting where available; otherwise label conservative estimates and retain headroom. Treat context capacity as finite for CLI seats too.

Allocate in this order: scope/contract and gate summaries; high-risk changed hunks; other changed hunks; full small files or enclosing functions; relevant types/imports/callers/tests/config; optional background. Avoid duplicating the same file in both the evidence pack and additional artifacts. Do not cut the final assembled request in a way that removes its diff, manifest or coverage declaration.

Start with hunk/function context and deterministic import/caller heuristics. Add language-aware indexing when evaluations show it improves recall. Record heuristic limitations rather than implying exact semantic analysis.

Each specialty sees the same revision and manifest, with different allocation weights: security gets trust boundaries and dependencies; testing gets changed behavior, tests and gate output; architecture gets public interfaces, callers and dependency direction. Compute union coverage centrally so all reviewers do not miss the same files.

### 4. Give API and CLI reviewers bounded ways to inspect

API seats receive self-contained evidence; a path alone gives them no filesystem access. First send prioritized evidence, then fulfill bounded structured requests for additional ranges, files, searches or gate artifacts from the frozen revision. If necessary, split into file/risk groups and aggregate coverage before deciding. Cap evidence rounds and total request budget.

CLI seats get the manifest, revision id and relevant high-risk hunks explicitly, plus access to a frozen review workspace through verified adapter capabilities. Harness-native tools can inspect more context. A worktree is isolation from concurrent edits, not a filesystem sandbox; project hooks, skills and native MCP may have effects outside it.

Use one coverage contract for all providers: assigned, available, delivered, acknowledged and cited evidence are distinct. Observed Read/Grep events are useful telemetry; they do not prove comprehension. A returned citation is evidence of location, not proof that the claimed bug is real.

A general API tool loop is conditional later work. Begin with the evidence-request mechanism already present.

### 5. Keep defect verdict separate from completeness

Use two axes:

- Verdict: PASS, NEEDS_WORK, BLOCKED or FAILED.
- Completeness: COMPLETE, DEGRADED or INCOMPLETE, with coverage gaps and per-member operational outcomes.

Default quorum requires all configured required members. Optional reduced quorum must be explicit and still reports DEGRADED. Accepting a degraded result under user policy records DEGRADED-ACCEPTED; it never becomes a full PASS.

PASS requires sufficient assigned coverage, no unresolved required findings, and contract-required verification on this revision. Incomplete evidence triggers repacking, more evidence or a user decision. It must not tell the executor to invent edits to solve an evidence gap. Legacy consumers map non-complete results to a stop state with a clear reason.

Use settled per-member outcomes, deadlines and schema validation. Failed, timed-out, missing and malformed reviews remain visible. Never reduce the denominator silently.

### 6. Make findings verifiable

Findings reference revision, path, old/new side, range/hunk, evidence references, rationale, severity and optional reproduction. Validate that paths/ranges/quotes exist. Allow old-side citations for deletions and unchanged files used as context.

Invalid major/security citations trigger bounded repair or more evidence. An unresolved severe claim cannot disappear through an automatic downgrade. Explicit dismissal needs a recorded reason. Valid citations still require reasoning or reproduction to establish the defect.

Correlate by location, overlapping ranges and category; retain original findings, disagreement and evidence. One valid critical finding survives a majority of clean reviews. Security policy uses evidence and severity, not an agent name. Agreement counts remain descriptive, not confidence estimates.

Gate artifacts include command, environment identity where relevant, exit code, time, revision and bounded log references. Running tests executes repository code and follows the user's command policy. Passing tests do not prove every requirement; NOT_RUN matters when that verification is required.

## Prompts and skills

Adopt the Agent Skills format instead of inventing a competing skill format. Load metadata first, instructions when activated, and resources as needed. Prompt templates remain smaller, typed text assets with required-variable and output-schema validation.

Resolve built-in < user < project by id, with explicit per-run selection. Show shadowed definitions and provenance. Record resolved versions/hashes, builder version, capability policy and model identity in a run manifest. Retain immutable non-secret prompt/skill content needed for reproduction; credentials remain references.

Project content is untrusted. Loading instructions does not grant execution, network or filesystem permissions. Importing or editing a skill never executes its scripts automatically. Executable project integrations need trust tied to their content/version; changed code invalidates that grant. Avoid shell interpolation in template substitution, path escapes and uncontrolled reference expansion.

Use two clearly labelled delivery modes:

- Harness-native: the CLI loads its own skills/tools. Assentor can configure supported scoped delivery, but cannot promise mediation or complete auditing of internal tool calls. Do not overwrite global harness configuration or duplicate installed tools.
- Engine-owned: API tool/script execution runs through Assentor's permission, timeout, budget and audit layer. This requires a real tool loop; it is not part of the initial evidence-pack reviewer.

Migrate existing agent instructions/memory. Separate reusable role instructions from task memory, and keep task memory scoped by project/session/seat to prevent unrelated runs contaminating reviews. Show compaction and reset events. Ship a small evaluated role set first: planner, implementer, correctness, testing, security and synthesizer.

## MCP integration

Two separate products:

1. **Assentor as an MCP server, earlier:** local stdio integration lets another coding agent request reviews and retrieve reports. Read-only status/report/findings methods are distinct from spending operations. Starting a review requires authorized scope, bounded budget/time and a returned handle; provide get/cancel operations. Enforce ownership and lineage/depth guards against recursive Assentor invocation.
2. **Assentor as an MCP client, later:** engine-owned API seats can consume approved external tools/resources/prompts if evidence requests are insufficient. Start with local stdio; remote HTTP adds transport/version negotiation and an appropriate OAuth/credential flow. Pin the implemented protocol/SDK revision and test compatibility instead of copying a moving draft.

Use per-server/tool allowlists, scoped credentials, schema validation, bounded results, cancellation, connection health and reconnect rules. Tool annotations are hints, not authorization. Tool errors and disconnects remain visible. Resources, prompts and tool output are untrusted data; they cannot change quorum, permissions or outcome policy. Deny unsupported sampling/elicitation capabilities rather than enabling them implicitly.

CLI seats initially retain harness-native MCP configuration. Report what can be detected; do not imply tools are centrally controlled when they are not. Choose one execution route per tool per seat. Import/setup flows show the command/server, credential scope and requested capabilities before activation. Do not silently install servers or expose a remote listener.

## Runtime and ownership

One owner per task on the same host/local filesystem. CLI, browser and later desktop can observe an owned task; shared files alone do not permit multiple engines to mutate it. Initial takeover requires verified owner death using host, pid and process-start identity. An expired heartbeat does not authorize replacing a live/paused owner.

Evolve the existing store with schema versions, sequenced append-before-publish events, snapshots with last sequence, attempt records and command ids. Log failures stop scheduling further mutations and trigger controlled shutdown rather than silently losing state. Observers ignore incomplete final bytes and never modify the log; the owner repairs/quarantines under lock during recovery. Mid-file corruption is surfaced.

Use ownership epochs/fencing, potentially segmented logs, so stale writers cannot rejoin. Final mechanism needs crash/lock-contention tests, not only a design assertion. Detect network/remote/unsupported filesystems and refuse ownership there; allow observer-only use where safe. Bound transcripts, coalesce output deltas, retain artifact references and provide retention/deletion controls.

Command deduplication prevents duplicate accepted requests, not duplicate external side effects. Recovery marks unfinished attempts interrupted, reconciles files/processes and does not blindly rerun edits or integrations.

Before adding parallel seat types, ship per-provider concurrency limits, per-member deadlines/abort, process-tree cancellation and session-scoped process ownership. Default provider concurrency is one. Usage distinguishes reported, estimated and unknown. Hard limits cover controllable time/attempts/rounds/concurrency; token/cost estimates are not exact prepaid limits, and unknown subscription costs never display as zero.

Where read-only capability is not provider-enforced, compare the scoped content manifest before and after the attempt, including tracked and eligible untracked content. Label ignored paths, submodule contents and external writes as outside detection scope unless separately covered. A detected change records `policy_violated`, excludes that member's verdict and requires reconciliation. This is change detection, not protection.

Model switches apply between turns. Interrupt-now creates an interrupted attempt and preserves partial side effects for reconciliation. Queue steering messages with visible acknowledgement and delivery state. Only expose pause/resume semantics an adapter supports.

## App experience and desktop options

The main flow is: choose project -> environment checks -> select workflow/team -> preview -> run/steer -> inspect findings/diff -> apply under policy -> recover/export.

Onboarding detects CLI versions, login readiness and supported capabilities without pretending a binary's presence proves authentication. API keys and CLI subscriptions are separate choices. Preview shows resolved prompts/skills, model selection, data sent to providers, workspaces, permissions, coverage strategy, concurrency, required gates and usage uncertainty.

Start with session list, live board, transcript/seat drawer, grouped findings, diff/evidence viewer and settings/doctor. Give errors, waiting, incomplete coverage and recovery prominent actions. Preserve keyboard navigation, accessible labels, reduced motion, search and usable narrow layouts. Virtualize long transcripts; keep protocol parsing/rendering away from the orchestration loop.

User authorization persists within its granted scope. Stage gates are policy choices, not repeated confirmations for already authorized actions. New privilege/scope, external publication or spending outside authorized limits follows explicit policy. The UI shows where an inherited grant came from.

| Option | Recommendation | Condition |
|---|---|---|
| Local server + system browser | First app release | Loopback binding, session token, validated Origin/Host and authenticated HTTP/WebSocket |
| Tauri + shared React UI + TS engine | Preferred desktop candidate | Packaging, GUI CLI discovery, streaming and process cleanup spikes succeed |
| Electron + shared engine/UI | Viable fallback | Packaging/rendering simplicity outweighs footprint/toolchain cost |
| Rust engine rewrite | Defer | No demonstrated need for replacing existing tested orchestration |

Keep browser and desktop transports behind the same typed engine contract. A stdio-only desktop owner cannot transparently control a separate live CLI owner: observer/attach architecture must remain explicit. A per-user daemon is a later option when background execution is required.

Do not freeze installer-size, OS-minimum or schedule claims from the draft. Pin target Node/Tauri versions and measure them. Desktop spikes cover packaged engine/assets, CLI discovery without terminal PATH, Windows shims, subprocess trees, update/recovery, and streaming on target webviews. Signing, notarization, installer formats and supported architectures follow the validated release matrix.

Release readiness also includes configuration migration and backup/recovery, project switching without state leakage, offline/provider-outage behavior, bounded disk use, export/delete controls and redacted diagnostic bundles. Keep telemetry opt-in. Define one credential-store interface shared by CLI and desktop, migrating the existing vault safely; an OS keychain is an implementation option rather than a second divergent secret store. Test credential expiry/revocation, app/engine version compatibility and rollback of failed updates. Add notifications/tray behavior only after background ownership and quit semantics are explicit.

## Quality and evaluation

Add deterministic fixtures for untracked new files, late diff bugs, large lockfiles, renames, deletions/callers, binary files, secrets, changed assertions, incomplete packs and clean changes. Include known regressions and realistic larger repositories. Assertions test what reached the reviewer, not only what the builder collected.

Track false-PASS rate, defect recall by severity/category, precision, citation validity, completeness, delivered coverage, tokens/known or estimated cost, and latency. Compare current single reviewer, current panel, improved packaging, specialty packaging and same-model/cross-provider teams. Record revision, prompt hashes, builder version and effective/unverified model. Keep a holdout set to limit tuning to fixtures.

Mock/provider contract checks run in normal CI. Real-model quality claims require opt-in, spend-capped evaluations and recorded baselines; no automatic paid nightly runs. Negotiation remains optional until it demonstrates benefit against independent reviews and a single-planner baseline.

Test panel failure combinations, cancellation/timeouts, ownership contention, crash points, torn logs, replay/command deduplication, redaction/path boundaries and recorded adapter streams. Exercise Linux/macOS/Windows before claiming support. Add release upgrade/downgrade/migration recovery checks. This planning task did not run those implementation checks.

## Delivery sequence

These are deliverables and gates, not reliable calendar estimates.

| Stage | Deliverable | Exit condition |
|---|---|---|
| 0 | Preserve/integrate existing reviewer edits; deterministic corpus; basic prompt provenance | Existing behavior documented; runs identify exact inputs; no competing stores |
| 1 | Panel correctness, unique identities, honest CLI models; immediate evidence omissions accounted for | Failed members cannot yield full PASS; unsupported model selection is explicit; unseen required code prevents complete success |
| 2 | Multi-seat safety: limiter, deadlines, abort, process ownership, usage tiers | Cancellation leaves no managed descendants; failures remain per-member; no new parallel adapter before this gate |
| 3 | Frozen scoped revision, manifest, context allocator, completeness and bounded evidence requests | New/late/omitted changes all accounted for; consistent revision; no secret capture; context fits or reports incomplete |
| 4 | Citation validation, specialty packs, diff-derived risk, panel aggregation | Single valid critical findings survive; missing evidence routes to repack; baseline comparisons recorded |
| 5 | Durable store v2 and ownership/recovery; capability matrix; Codex reviewer | Safe observer/recovery behavior demonstrated; new reviewer obeys the same completeness and cancellation rules |
| 6 | Fixed optional plan workflow: two independent proposals, one critique, explicit synthesis with dissent, existing implementer/gates/panel | Bounded cost/rounds; raw proposals retained; evaluations justify use |
| 7 | `serve` + React observer, then authorized steering/settings | Reconnect/replay works; useful review and recovery UX; control calls respect ownership |
| 8a | MCP server integration, independently after stage 5 or 7 | Bounded review handles; ownership, cancellation and recursion guard; no dependency on editor UI |
| 8b | Skill library/import/trust UI; prompt/team editors | Provenance and grants visible; no implicit script execution |
| 9 | Conditional API tool loop/MCP client, background daemon, richer workflows | Measured need; explicit tool policy and lifecycle; no duplicated execution paths |
| 10 | Desktop spikes, shell decision and signed distribution | Tested packaging/process/upgrade behavior on supported targets |

Move a minimal durable revision/attempt record into stage 3 as needed; do not ship revision-bound reviews that cannot persist their identity. Full event recovery can remain stage 5. A simple browser observer can begin once durable read semantics are available; it need not wait for every optional negotiation feature.

Later backlog: best-of-N worktrees, conflict-aware integration, divide-and-conquer, arbitrary playbook graphs, model scoreboards, remote/team hosting, plugin marketplace and broader package formats. Each needs usage evidence and its own acceptance criteria. Avoid automatic merging or calibrated-confidence claims in the initial release.

## First implementation PR

Scope: panel correctness and honest reviewer identity/model selection on the existing architecture. No new UI, mode, package split or storage namespace. Branch from the integrated current work, not the stale planning commit.

Acceptance:

- Three reviewers, two operational failures and one PASS cannot return complete PASS.
- A throwing or malformed reviewer yields a recorded member outcome, not an unhandled panel failure or reduced quorum.
- An evidenced minority security blocker survives majority PASS; an unsupported severe claim requests verification and cannot silently clear.
- Security veto authority comes from finding category, severity and evidence; neither reviewer name nor a majority-PASS precondition is required.
- Repeated same-provider seats have stable unique ids; duplicate explicit ids fail validation.
- A configured model is forwarded using verified adapter arguments or rejected clearly; requested model is never presented as verified effective model.
- Single-reviewer behavior remains compatible except where correcting unsafe or misleading outcomes.
- Meaningful deterministic regressions and the existing required checks pass.

Closely scoped untracked-content and truncation-completeness fixes may ship alongside or immediately after this PR; paid model evaluations do not block obvious correctness fixes.

## Decisions still needed before feature implementation

1. First app delivery target: browser-first is recommended; native desktop can follow validated spikes.
2. Background runs after closing the UI/terminal: defer a daemon unless this is a first-release requirement.
3. Initial provider shortlist and target operating systems; verify actual installed CLI capabilities before committing to parity.
4. Default data-sharing, project trust and spending policies, including handling DEGRADED outcomes.
5. Snapshot mechanism and minimum supported platform/runtime versions, resolved by technical spikes rather than preference questions.

## Reference standards

- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx): skill directory/frontmatter conventions and progressive loading. Permission policy remains Assentor's responsibility.
- [MCP server primitives](https://modelcontextprotocol.io/specification/draft/server/index): tools, resources and prompts are separate interfaces. Pin a released revision during implementation.
- [MCP authorization specification source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/draft/basic/authorization/index.mdx): transport-specific authorization; HTTP and stdio credential handling differ.
- [Tauri v2 Node sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/): Node sidecars are a supported integration pattern, not evidence that this repository is already packageable.
- [Node SEA documentation source](https://github.com/nodejs/node/blob/main/doc/api/single-executable-applications.md): packaging/module/asset behavior depends on the pinned Node version and requires a spike.
