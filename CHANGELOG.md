# Changelog

All notable changes to Assentor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Broader multi-reviewer debate wiring into the default `run` path

## [0.2.0] — 2026-08-25

### Added

- Interactive TUI API key flow (provider → label → paste secret) with encrypted vault storage
- TUI **Update** / **Uninstall** actions plus `assentor update` and `assentor uninstall`
- `scripts/update.sh` and `scripts/uninstall.sh`
- Project run **Defaults** screen (executor, reviewer, routing, models) persisted to `.assentor/config.yaml`
- API key resolution: environment → **user vault** (`~/.assentor`) → project vault
- Global defaults in `~/.assentor/config.yaml` (TUI no longer scatters config into every cwd)
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

[Unreleased]: https://github.com/MasterAkbariDev/Assentor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MasterAkbariDev/Assentor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MasterAkbariDev/Assentor/releases/tag/v0.1.0
