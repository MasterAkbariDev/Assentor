# Changelog

All notable changes to Assentor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MasterAkbariDev/Assentor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MasterAkbariDev/Assentor/releases/tag/v0.1.0
