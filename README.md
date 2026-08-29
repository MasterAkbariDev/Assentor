# Assentor

**Assentor** is a local supervisor CLI for AI coding agents.

It does not write your code itself. It **coordinates**:

- an **executor** that edits the project
- a **reviewer** that decides `PASS` / `NEEDS_WORK` / `BLOCKED` from evidence
- budgets, git safety, resumable task state, encrypted keys, and routing

Reviewers must request evidence instead of guessing. Executors work in rounds until the reviewer grants assent — or the budget runs out.

---

## Install (one line)

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/MasterAkbariDev/Assentor/main/scripts/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/MasterAkbariDev/Assentor/main/scripts/install.ps1 | iex
```

Requires **Node.js 20+** and **git**.

---

## Quick start

```bash
# Check environment
assentor doctor

# Initialize config in a project
assentor init --project ./my-app

# Set defaults in the TUI (recommended)
cd ./my-app && assentor
# → Configure → AI defaults → executor=cursor → Save
# → Configure → Reviewers → Add Gemini (API) and/or Claude (CLI) → Save
# → Configure → API keys → Add a Gemini key if you use API review

# Or run with explicit flags
export GEMINI_API_KEY=...
assentor run --project ./my-app --executor cursor --reviewer gemini \
  "Build a simple Todo app with index.html, styles.css, app.js."

# After saving defaults, flags are optional
assentor run --project ./my-app "Implement the requested feature."
```

Demo / offline (no API keys):

```bash
assentor run --project ./my-app --executor mock --reviewer mock \
  "Implement the requested feature."
```

---

## Terminal UI

```bash
assentor          # or: assentor ui
```

| Menu | What it does |
|------|----------------|
| **Workspace** | Start a task (shows current folder), continue latest, explain reviewers, diagnostics |
| **Tasks** | History. `r` resumes **FAILED** / **TIMEOUT** only. `d` deletes a task. `n` new. |
| **Agents** | Specialty roles (architecture, security, …) — **view-only**. Add backends under Reviewers. |
| **Review** | **Explain reviewers for a goal** — offline score of the text (no LLM). Shows *your* Gemini/Claude rows plus suggested specialties and why. |
| **Configure** | AI defaults (executor, models), **API keys**, executors, **Reviewers** (add mix of API/CLI), advanced, update/uninstall |
| **Diagnostics** | Environment health check |
| **Help** | Shortcuts and CLI reminders |

Navigate with ↑ ↓ Enter Esc · **Tab** switches nav/main · **q** quit from nav · **/** command palette.

**Reviewers:** Configure → Reviewers → `a` add. Pick Gemini/OpenAI/Claude/mock, then API or CLI (Claude is always CLI). Each row is a real reviewer on the panel — there is no global “run via API or CLI” switch.

**API keys:** only keys you add appear. Environment variables (`GEMINI_API_KEY`, …) still work at run time as a fallback; they are **not** copied into the vault.

Version: see `assentor -V`, `assentor version --check`, and [CHANGELOG.md](./CHANGELOG.md).

---

## How it works

```
┌────────────┐     edits      ┌──────────┐
│  Executor  │ ─────────────► │  Project │
└─────▲──────┘                └────┬─────┘
      │                            │
      │ change / evidence          │ evidence
      │                            ▼
      │                      ┌──────────┐
      └──────────────────────│ Reviewer │──► PASS | NEEDS_WORK | BLOCKED
                             └──────────┘
```

1. **Contract** — freezes the goal and acceptance criteria  
2. **Execute** — coding agent applies changes  
3. **Evidence** — Assentor collects file contents / git signal (ignores `.assentor/`)  
4. **Review** — reviewer returns a structured decision  
5. **Loop** — on `NEEDS_WORK`, feedback goes back to the executor  

State lives under `.assentor/tasks/<id>/`. Resume a failed or timed-out task from **Tasks** (`r`) or `assentor resume`. Delete history with `d` on the Tasks screen.

---

## Multi-agent & routing

Assentor separates:

| Concept | Meaning |
|---------|---------|
| Logical agent | Stable identity + memory (e.g. Architecture Reviewer) |
| Provider | Gemini, OpenAI, OpenRouter, Qwen |
| Model | Capability-ranked; `AUTO` picks the best fit |
| API key | Multiple per provider, encrypted vault, health-aware rotation |
| Executor | Coding CLI (Cursor today; others detectable) |

```bash
assentor keys list
assentor keys add --provider gemini --name Personal --secret "$GEMINI_API_KEY"
assentor keys check --all
assentor executors
assentor agents
assentor diagnostics
```

**Routing strategies:** `FREE_FIRST` · `CHEAPEST` · `BALANCED` · `BEST` · `CUSTOM`  
**Review strategies:** `SINGLE` · `ADAPTIVE` · `PANEL` · `FULL`

Set executor/models under **Configure → AI defaults**. Add reviewers under **Configure → Reviewers** (persisted in `~/.assentor/config.yaml`).

---

## Providers

| Role | Provider | Notes |
|------|----------|--------|
| Executor | `mock` | Deterministic, offline |
| Executor | `cursor` | Cursor Agent CLI (`agent` / `cursor agent`) |
| Executor | `antigravity` | Google Antigravity CLI (`agy`) |
| Reviewer | `mock` | Deterministic, offline |
| Reviewer | `gemini` | Vault key or `GEMINI_API_KEY` (Gemini API) |
| Reviewer | `openai` | Vault key or `OPENAI_API_KEY` (API only) |
| Reviewer | `claude` | Claude Code CLI (`transport: cli`) |
| Reviewer | `cursor` | Cursor Agent CLI (`agent` / `cursor agent`, `transport: cli`) |
| Reviewer | `antigravity` | Antigravity CLI (`agy`, `transport: cli`) |

### Cursor

```bash
# Login once (or set CURSOR_API_KEY)
agent login

assentor doctor --project . --executor cursor --reviewer gemini
```

### Models

Prefer setting models in **Configure → AI defaults** (`AUTO`, `gemini-3.6-flash`, `gpt-4o-mini`, …). Env overrides still work:

```bash
export ASSENTOR_GEMINI_MODEL=gemini-3.6-flash
export ASSENTOR_GEMINI_MODEL_FALLBACKS=gemini-2.5-flash,gemini-1.5-flash
export ASSENTOR_OPENAI_MODEL=gpt-4o-mini
```

---

## CLI

```bash
assentor                         # TUI
assentor ui [--project <path>]
assentor init [--project <path>]
assentor run [--project <path>] [--executor <name>] [--reviewer <name>] [--max-rounds <n>] [-v] "<prompt>"
assentor resume [taskId] [--project <path>]
assentor status <taskId> [--project <path>]
assentor logs <taskId> [--project <path>]
assentor doctor [--executor <name>] [--reviewer <name>] [--project <path>]
assentor keys list|add|check|…
assentor update
assentor uninstall [--purge]
assentor version [--check]
assentor changelog
assentor executors
assentor agents
assentor diagnostics
```

Prefer saving keys in the TUI (**Configure → API Keys → Add**) — they go to **`~/.assentor/secrets.json`** and work in every project. Env vars still work as a fallback and are **not** listed as extra vault keys.

The TUI checks GitHub on startup (cached ~6h under `~/.assentor/update-check.json`). Set `ASSENTOR_SKIP_UPDATE_CHECK=1` to disable.

CLI flags override config for a single run (`--reviewer gemini` uses that one backend for the run).

---

## Configuration

**Global (recommended)** — TUI **Configure → Save** and **API Keys** write here:

- `~/.assentor/config.yaml` — executor, reviewer, models, routing
- `~/.assentor/secrets.json` — encrypted API keys

These apply everywhere. You do **not** need to reconfigure in each folder.

**Per-project (optional)** — `assentor init` writes a project override at `.assentor/config.yaml`. Task state still lives under the project’s `.assentor/tasks/` when you run.

Merge order: built-in defaults → `~/.assentor/config.yaml` → project `.assentor/config.yaml` → CLI flags.

```yaml
# ~/.assentor/config.yaml (example)
executor:
  provider: cursor   # mock | cursor

reviewers:
  - provider: gemini # mock | gemini | openai | claude
    transport: api   # api | cli (claude is CLI-only)
    role: general
  - provider: claude
    transport: cli
    role: general

routing:
  strategy: BALANCED
  reviewStrategy: ADAPTIVE

models:
  default: AUTO
  gemini: AUTO
  openai: AUTO

limits:
  maxRounds: 8
  maxMessages: 50
  maxRuntimeMinutes: 120
  maxToolCalls: 200
```

**Tip:** Open `assentor` once → **Configure → AI** (`cursor`) → **Reviewers** (Gemini API + Claude CLI) → **Save**, then **API Keys → Add**. After that, `assentor run --project ~/any-app "…"` uses those globals.

---

## Develop from source

```bash
git clone https://github.com/MasterAkbariDev/Assentor.git
cd Assentor
pnpm install   # or: npm install
pnpm test
pnpm build
./scripts/install-cli.sh   # symlink into ~/.local/bin
```

---

## Requirements

- Node.js ≥ 20
- git
- Optional: Cursor Agent CLI, Gemini or OpenAI API key, Claude Code CLI

---

## License

MIT
