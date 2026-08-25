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
# → Defaults → set executor=cursor, reviewer=gemini → Save

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
| **Defaults** | Set project defaults for executor, reviewer, routing, models, max rounds — **Save** writes `.assentor/config.yaml` |
| Providers | List AI providers and key health |
| **API Keys** | **Add** key (pick provider → label → paste secret); **c** Check · **C** Check All · **d** Delete |
| Models | Capability-ranked model catalog (`AUTO` picks) |
| Executors | Detect / install plan for Cursor and other CLIs |
| Agents | Logical agent profiles |
| Diagnostics | Environment health check |
| Logs / Audit | Recent Assentor audit events |
| Settings | Shortcut into Defaults + config file locations |
| **Update** | Pull / rebuild Assentor; banner + menu label when a newer version is on GitHub |
| **Uninstall** | Remove the `assentor` command (project `.assentor/` data kept) |

Navigate with ↑ ↓ Enter Esc · **q** quit. ← → cycles values on the Defaults screen.

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

State lives under `.assentor/tasks/<id>/` (resumable when not terminal).

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

Set these under **Defaults** in the TUI (persisted in config).

---

## Providers

| Role | Provider | Notes |
|------|----------|--------|
| Executor | `mock` | Deterministic, offline |
| Executor | `cursor` | Cursor Agent CLI (`agent` / `cursor agent`) |
| Reviewer | `mock` | Deterministic, offline |
| Reviewer | `gemini` | Vault key or `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `ASSENTOR_GEMINI_API_KEY` |
| Reviewer | `openai` | Vault key or `OPENAI_API_KEY` / `ASSENTOR_OPENAI_API_KEY` |

### Cursor

```bash
# Login once (or set CURSOR_API_KEY)
agent login

assentor doctor --project . --executor cursor --reviewer gemini
```

### Models

Prefer setting models in **Defaults** (`AUTO`, `gemini-3.6-flash`, `gpt-4o-mini`, …). Env overrides still work:

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
assentor resume <taskId> [--project <path>]
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

Prefer saving keys in the TUI (**API Keys → Add**) so secrets are encrypted in `.assentor/secrets.json`. Env vars still work as a fallback seed.

The TUI checks GitHub on startup (cached ~6h under `~/.assentor/update-check.json`). Set `ASSENTOR_SKIP_UPDATE_CHECK=1` to disable.

CLI flags override `.assentor/config.yaml` for a single run.

---

## Configuration

`assentor init` (or TUI **Defaults → Save**) writes `.assentor/config.yaml`:

```yaml
project:
  path: .

executor:
  provider: mock   # mock | cursor

reviewers:
  - provider: mock # mock | gemini | openai
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

git:
  checkpoints: true
  autoCommit: false

security:
  redactSecrets: true
  allowExternalPaths: false
```

**Tip:** If `assentor run` finishes instantly with `mock` / `mock`, open the TUI → **Defaults**, switch to `cursor` + `gemini`, and **Save**.

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
- Optional: Cursor Agent CLI, Gemini or OpenAI API key

---

## License

MIT
