# Changelog

All notable changes to Assentor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.13] — 2026-08-29

### Fixed

- Antigravity and Qwen print-mode executors no longer pass `--dangerously-skip-permissions` (or other unattended flags) as the `-p` prompt. Unattended flags are ordered first and the task text is attached as `-p=<prompt>`.

## [0.3.12] — 2026-08-29

### Added

- **Autopilot run mode** — Phase steering (next-phase directives, anti-stall, PASS downgrade) is opt-in via `--mode autopilot` / `--autopilot` or `run.mode: autopilot`; default remains supervised.
- **Verification gates** — Configurable local checks run after evidence collection; hard failures skip the LLM reviewer and emit a synthetic `NEEDS_WORK` with stdout.
- **Phase progress** — Reviewer prompts and supervisor steering track multi-phase tasks (`PhaseItem`, stall detection, continuation prompts on Cursor).
- **Multi-CLI executors** — TUI/CLI can select any detected coding CLI (Claude, Antigravity, Codex, Qwen, OpenCode) via a shared print-mode adapter, not only mock/Cursor.
- **Antigravity (`agy`)** — Google coding CLI replaces Gemini CLI for executor/reviewer roles; Gemini API reviewer remains API-only.
- **Cursor CLI reviewer** — Cursor can be added as a CLI reviewer alongside Claude and Antigravity.
- **Command detection** — `assentor init` populates `verification.*` and binary paths from installed ecosystem CLIs.

### Changed

- Executor registry and preflight now resolve all registered provider binaries instead of hardcoding mock/Cursor.
- TUI: `m` cycles run mode on Workspace; status bar shows supervised/autopilot; AI defaults and Executors screen list all detected CLIs.

## [0.3.11] — 2026-08-26

### Fixed

- The Evidence step is local-only: Assentor reads files, git, and runs safe reviewer-requested commands itself. It no longer starts a second Cursor session during evidence collection, and reviewer evidence requests are never escalated back to the executor.
- Large uncommitted changes no longer flood the reviewer: changed-file lists are capped in the evidence summary, diffs and inline file bodies stay bounded, and changed paths are prioritized over alphabetically sorted unrelated files.
- Ctrl+C / interrupt now kills tracked Cursor and shell child processes (`taskkill /T` on Windows, `pkill -P` on Unix) instead of leaving hundreds of orphaned node/python processes running.

## [0.3.10] — 2026-08-26

### Fixed

- Cursor runs no longer hang on “closing stuck Cursor process” or “saving” after Ctrl+C. Assentor stops waiting for the CLI process to exit (Windows `cmd.exe` often keeps stdout open), kills the process tree, and continues with the result it already has.

## [0.3.9] — 2026-08-26

### Fixed

- Windows `assentor update` no longer dies in PowerShell 5.1 with “The string is missing the terminator”. `update.ps1` is ASCII-only (an em dash was being read as a stray quote), and a failed update falls back to `install.ps1`.

## [0.3.8] — 2026-08-26

### Fixed

- Cursor no longer sits on “waiting, finishing up” after the agent has already emitted its result. Assentor waits a short grace period, then closes the stuck CLI process and continues the run.
- Gemini (and other reviewers) can send `issues[].evidence` as a single string; Assentor now coerces it to an array instead of failing the whole task with `Invalid review result`.

## [0.3.7] — 2026-08-26

### Fixed

- `assentor update` / `assentor uninstall` on Windows no longer spawn `bash` (the WSL stub). They run `update.ps1` / `uninstall.ps1` via PowerShell instead of printing “Windows Subsystem for Linux has no installed distributions”.

## [0.3.6] — 2026-08-26

### Fixed

- CLI discovery no longer hardcodes macOS Cursor paths. Assentor searches PATH (including Windows `.cmd`/`.exe`), then well-known install folders such as `%LOCALAPPDATA%\cursor-agent\agent.cmd`, and stores the resolved path in `~/.assentor/config.yaml` under `binaries`.
- Windows `.cmd` CLIs (Cursor, Claude, Gemini, Codex, Qwen, OpenCode) are spawned via `cmd.exe` so they actually run.

## [0.3.5] — 2026-08-26

### Added

- GitHub Actions CI on `main` and pull requests (pnpm install, typecheck, test, build)

### Fixed

- First review no longer fails every run because Section G only saw a dirty working tree; committed Cursor changes (and files named in the executor response) are included as evidence

## [0.3.4] — 2026-08-26

### Fixed

- `assentor run` / Continue show a loading spinner before the executor starts (no more blank screen)
- Start task from the TUI no longer hangs on a 45s Cursor probe; the terminal is restored after the menu exits
- Ctrl+C stops Cursor, saves the task as FAILED (resumable), and no longer leaves status stuck on INITIALIZING
- Long Cursor “reasoning” stretches keep the last tool/file line instead of looking frozen

## [0.3.3] — 2026-08-26

### Added

- Configure → Reviewers lets you add mixed backends (Gemini via API key, Claude via CLI, …)
- Tasks screen: resume failed/timed-out runs (`r`) and delete history (`d`)

### Changed

- Removed the global “reviewer runs via API or CLI” toggle; each reviewer has its own transport
- A run uses the reviewers you added (not N clones of the first one)
- “Explain reviewers for a goal” lists your backends plus recommended specialties (offline, no LLM)
- API Keys no longer copies env vars into the vault as fake “Env Gemini” rows
- Diagnostics nav label no longer wraps

## [0.3.2] — 2026-08-26

### Changed

- **TUI UX rewrite** — Workspace-first navigation (Tasks / Agents / Review / Configure / Diagnostics / Help); removed root Providers/Models/Logs/System destinations; command palette (`/` / Ctrl+K); contextual help (`?`); status bar; progressive configuration
- Start-task wizard uses the current folder (editable) and actually launches `assentor run`
- Reviewer explanation is plain language (who + why), not internal complexity codes
- Defaults/reviewer settings edit inline with ← → (left arrow no longer jumps tabs)
- Executor response is printed in full after each round
- `assentor resume` (optional id / prefix) retries timed-out, failed, and blocked tasks
- Cursor executor timeout defaults to 60 minutes (or `limits.maxRuntimeMinutes`); a kill is no longer reported as “authentication required”

## [0.3.1] — 2026-08-26

### Added

- Executors (and `assentor init` / task layout) automatically add `.assentor/` to the project `.gitignore`

## [0.3.0] — 2026-08-26

### Added

- **Evidence packs** — structured Project Review Evidence Pack (sections A–K) built locally, persisted under `.assentor/tasks/<id>/evidence/`
- Iterative evidence-request loop: Assentor fulfills file/git/search/test locally first; executor only for hard probes
- Pack-aware reviewer prompts (“do not guess”; executor claims vs evidence)
- Pre-review executor explanation turn (architecture + implementation summary)
- **Multi-reviewer path** — complexity analyzer, specialty prompts, `PanelReviewer` / correlate / adjudicate / security veto
- CLI reviewer transport (`transport: cli`) with API fallback (`FallbackReviewer`)
- Lazygit-style Ink TUI: sidebar + main pane + screens (Dashboard, Review, Keys, Executors, …)
- CLI: `assentor reviewers`, `assentor review`, `assentor keys delete`

### Changed

- Default `assentor run` uses evidence packs + optional panel reviewers from `routing.reviewStrategy`
- ReviewResult schema supports categories, affectedFiles, architecture/requirements assessment, verification

## [0.2.2] — 2026-08-25

### Fixed

- Update checker prefers GitHub Contents API over raw CDN to avoid stale remote versions
- Failed refresh no longer falsely reports “local ahead” from an old cache snapshot

## [0.2.1] — 2026-08-25

### Changed

- Keys and Defaults are global under `~/.assentor` (no per-cwd config for TUI)
- Config merge order: built-in → `~/.assentor/config.yaml` → project override → CLI flags
- API key resolution prefers the user vault over leftover project vaults
- Opening the TUI in a random folder no longer creates a local `.assentor/`

### Fixed

- Stale update-check cache no longer reports “local ahead” after pushing to GitHub

## [0.2.0] — 2026-08-25

### Added

- Interactive TUI API key flow (provider → label → paste secret) with encrypted vault storage
- TUI **Update** / **Uninstall** actions plus `assentor update` and `assentor uninstall`
- `scripts/update.sh` and `scripts/uninstall.sh`
- Project run **Defaults** screen (executor, reviewer, routing, models)
- API key resolution from environment and vaults
- Versioning, `CHANGELOG.md`, and startup update check in the TUI / `assentor version --check`

### Fixed

- Review parser normalizes Gemini `confidence` values on a 0–100 scale (and slight overshoots)
- Preflight no longer requires exported `GEMINI_API_KEY` when a vault key exists

### Changed

- README documents Defaults, Keys, Update, and Uninstall menu entries

## [0.1.0] — 2026-08-25

### Added

- Initial Assentor supervisor CLI (executor + evidence-based reviewer loop)
- Providers: mock / Cursor executors; mock / Gemini / OpenAI reviewers
- Ink terminal UI, encrypted multi-key vault, model registry, routing engine
- Logical agents, diagnostics, and resumable task state under `.assentor/tasks/`
- One-line install scripts for macOS/Linux and Windows

[Unreleased]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.13...HEAD
[0.3.13]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MasterAkbariDev/Assentor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MasterAkbariDev/Assentor/releases/tag/v0.1.0
