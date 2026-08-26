# Changelog

All notable changes to Assentor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MasterAkbariDev/Assentor/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MasterAkbariDev/Assentor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MasterAkbariDev/Assentor/releases/tag/v0.1.0
