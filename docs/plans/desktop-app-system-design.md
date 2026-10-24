# System Design: Assentor Desktop (Tauri + React + Rust)

Status: **Draft for review — design only, no code** · Companion to [app-and-multi-model.md](./app-and-multi-model.md)

---

## 1. Verdict

**Yes — Tauri v2 + React + Rust is a good choice and it runs on Linux, macOS and Windows**, with one condition:

> **Keep the Assentor engine in TypeScript/Node and ship it as a Tauri sidecar. Rust is a thin, security-focused host — not a rewrite of the engine.**

Rewriting the supervisor, review coordinator, CLI recipes, stream parsers, vault and routing in Rust would mean months of duplicate work and two engines drifting apart (the npm CLI would still need the TS one). The Rust layer should do what Rust and Tauri are best at: windows, OS integration, process supervision, secure IPC, keychain, updates.

### Platform support

| OS | Webview Tauri uses | Status | Notes |
|---|---|---|---|
| **macOS** 10.15+ (Intel + Apple Silicon) | WKWebView (Safari engine) | ✅ Solid | Needs notarization for a clean install |
| **Windows** 10/11 (x64, arm64) | WebView2 (Chromium/Edge) | ✅ Solid | WebView2 is preinstalled on Win 11 and current Win 10; installer can bootstrap it otherwise |
| **Linux** (Ubuntu 22.04+, Fedora, Arch…) | WebKitGTK 4.1 | ✅ Works, weakest of the three | Slower rendering for heavy UIs; must test animations/virtual lists; distro packages need `libwebkit2gtk-4.1` |

### Tauri vs Electron for *this* project — honest comparison

| | Tauri (sidecar design) | Electron |
|---|---|---|
| Installer size | Shell ~5–15 MB **+ bundled Node engine ~40–60 MB** → the famous size win shrinks to roughly half of Electron | ~90–130 MB |
| RAM at idle | Lower (system webview) | Higher (bundled Chromium) |
| Security model | Strong: capability-based permissions per window, no Node in the webview | Good if configured carefully |
| Rendering consistency | 3 different engines → test on each | Identical everywhere |
| Engine reuse | Via sidecar process (extra moving part) | In-process |
| Toolchains | Rust + Node + React | Node + React |
| Auto-update | `tauri-plugin-updater` (signed manifests) | `electron-updater` |

**Bottom line:** Tauri gives a lighter, more locked-down app at the cost of a sidecar and cross-webview testing. Both are viable; Tauri is the better *product* if you accept those costs. This design assumes Tauri.

---

## 2. Architecture overview

```
┌──────────────────────────────── Assentor.app / .exe / AppImage ───────────────────────────────┐
│                                                                                                │
│  ┌──────────────────────────── Webview (React UI) ─────────────────────────────┐              │
│  │  Session board · Seat drawers · Negotiation · Review · Diffs · Prompts ·      │              │
│  │  Teams/Playbooks · Settings · Command palette                                 │              │
│  │                                                                               │              │
│  │  Event store (per-session, seq-ordered)   RPC client (typed, @assentor/protocol)│             │
│  └───────────────▲──────────────────────────────────────┬────────────────────────┘              │
│                  │ Tauri Channel (ordered event stream)  │ Tauri invoke (commands)               │
│  ┌───────────────┴──────────────────────────────────────▼────────────────────────┐              │
│  │                          Rust host (src-tauri)                                  │             │
│  │  • Engine supervisor: spawn / health-check / restart sidecar                    │             │
│  │  • RPC broker: webview ⇄ engine (envelope only, payload passthrough)            │             │
│  │  • Job object / process group: engine + all CLIs die with the app               │             │
│  │  • OS: tray, notifications, single-instance, deep links, window state           │             │
│  │  • Keychain bridge (macOS Keychain / Win Credential Manager / Secret Service)     │             │
│  │  • Login-shell PATH resolution · updater · capability permissions               │             │
│  └───────────────▲──────────────────────────────────────┬────────────────────────┘              │
│                  │ stdout: NDJSON events/responses       │ stdin: NDJSON JSON-RPC requests        │
│  ┌───────────────┴──────────────────────────────────────▼────────────────────────┐              │
│  │                  Engine sidecar (Node SEA binary, TypeScript)                   │             │
│  │  Session manager · Stage runner · Seat scheduler · Negotiate/Review strategies  │             │
│  │  Prompt library · Model catalog · Worktree manager · Budgets · Event log        │             │
│  │  Existing: supervisor, review coordinator, recipes, vault, routing, evidence    │             │
│  └──────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────────┘              │
└─────────┼─────────────┼─────────────┼─────────────┼─────────────┼────────────────────────────────┘
          ▼             ▼             ▼             ▼             ▼
     claude (CLI)   codex (CLI)   agy (CLI)    cursor agent    HTTPS → Gemini/OpenAI APIs
     Opus#1..#3     Codex#1..#2                                (API seats)
          │             │
          ▼             ▼
   .assentor/worktrees/<session>/<seat>   ← one git worktree per editing seat
```

**Three processes, three responsibilities:**

| Layer | Language | Owns | Never does |
|---|---|---|---|
| UI | React + TS | Rendering, interaction, local view state | Spawn processes, read secrets, touch files |
| Host | Rust | OS integration, engine lifecycle, IPC broker, security boundary | Business logic (modes, prompts, reviews) |
| Engine | TS/Node | All orchestration logic (shared with the npm CLI) | Know it's inside a desktop app |

The **same engine** powers: the desktop app (stdio transport), the npm CLI/TUI (in-process), and an optional browser mode `assentor serve` (WebSocket transport). One engine, three transports.

---

## 3. Component design

### 3.1 Engine sidecar (TypeScript)

**Packaging:** compiled to a single executable per target with **Node SEA** (Single Executable Applications). Bun `--compile` is an alternative but must first be validated against the engine's `child_process` / stream usage — Node SEA is the safe default.

Targets (Tauri requires the binary named with the target triple):

```
assentor-engine-aarch64-apple-darwin
assentor-engine-x86_64-apple-darwin
assentor-engine-x86_64-pc-windows-msvc.exe
assentor-engine-aarch64-pc-windows-msvc.exe
assentor-engine-x86_64-unknown-linux-gnu
assentor-engine-aarch64-unknown-linux-gnu
```

**Internal modules (new ones in bold):**

```
engine/
  rpc/            ** transport-agnostic JSON-RPC server (stdio | websocket | in-process)
  sessions/       ** Session, Stage, stage-graph runner (playbooks)
  seats/          ** Seat lifecycle, scheduler, concurrency limiter, rate-limit queue
  modes/
    negotiate/    ** debate | vote | best-of-n | divide | synthesize
    review/          N-seat panel (generalized PanelReviewer + ReviewCoordinator)
    execute/         existing Supervisor loop, now seat-aware
  prompts/        ** loader (built-in → user → project), templating, validation
  models/            registry + ** per-CLI catalog & discovery
  worktrees/      ** create / list / diff / merge / cleanup
  events/         ** event bus + append-only NDJSON log + coalescer
  providers/         existing executors/reviewers + recipes (+ modelFlag)
  keys/ routing/ security/ git/ persistence/   existing
```

**Headless contract:** the engine has no UI code. Ink stays in the CLI package only.

### 3.2 Rust host (src-tauri)

| Module | Responsibility | Tauri / crates (indicative) |
|---|---|---|
| `engine_supervisor` | Spawn sidecar, handshake (protocol version), heartbeat, restart with backoff, graceful shutdown | `tauri-plugin-shell` sidecar API, `tokio` |
| `rpc_broker` | Map `invoke` → JSON-RPC request; route responses by id; forward events to the right window's Channel | `serde_json` (envelope only) |
| `proc_guard` | Ensure **no orphan CLIs**: Windows Job Object with kill-on-close; Unix process group + kill on exit | `windows` crate, `nix` |
| `env_resolver` | Resolve the user's **login-shell PATH** (GUI apps on macOS/Linux don't inherit `~/.zshrc` PATH → CLIs "not found") and pass it to the engine | spawn `$SHELL -ilc env` once |
| `secrets` | Store vault master key / API keys in the OS keychain | `keyring` |
| `os` | Tray (running sessions + status), native notifications, single instance, `assentor://` deep links, window state, global shortcut | official Tauri v2 plugins |
| `updater` | Check/download/verify signed updates (app + bundled engine update together) | `tauri-plugin-updater` |
| `capabilities` | Per-window allow-list of commands; webview gets **only** `rpc_call`, `subscribe`, `os_*` — no shell, no fs | Tauri v2 capability files |

**Why the broker passes payloads through:** types are defined once in TypeScript (zod). Rust only understands the envelope `{id, method, params}` / `{seq, sessionId, type, data}`. This avoids maintaining the same types in three places.

### 3.3 React UI

| Concern | Choice (recommended) | Why |
|---|---|---|
| Build | Vite + React 18 + TypeScript | Standard for Tauri |
| Routing | TanStack Router | Typed routes |
| Server state (RPC) | TanStack Query | Caching for prompts, teams, settings |
| Live state (events) | Zustand store fed by event stream | Fine-grained subscriptions per seat → no full re-renders |
| Components | Radix primitives + Tailwind (shadcn-style) | Accessible, themeable |
| Long streams | Virtualized lists (TanStack Virtual) | 5+ seats streaming without jank, esp. on WebKitGTK |
| Raw CLI output | xterm.js (read-only) | Faithful ANSI rendering of CLI streams |
| Diffs | Monaco diff editor (lazy-loaded) | Side-by-side best-of-N comparison |
| Prompt editor | CodeMirror 6 | Lighter than Monaco, markdown + front-matter |
| Icons | Lucide + provider marks (check each vendor's brand guidelines) | Status icon set from main plan §4.6 |
| Motion | CSS transitions; respect `prefers-reduced-motion` | Smooth status changes without CPU cost |

**Screens** (unchanged from main plan §4.6): Session board · Seat drawer · Negotiation · Review · Diff & worktrees · Prompts/Teams/Playbooks · Settings · Onboarding.

**UI package is transport-agnostic:** a `Transport` interface with `TauriTransport` (invoke + Channel) and `WebSocketTransport` (browser mode). Same UI, both shells.

---

## 4. Protocol design

### 4.1 Requests (UI → engine), JSON-RPC 2.0

| Namespace | Methods (examples) |
|---|---|
| `session.*` | `create`, `start`, `pause`, `resume`, `cancel`, `list`, `get`, `export` |
| `seat.*` | `setModel`, `inject`, `stop`, `restart`, `approve` |
| `team.*` / `playbook.*` | CRUD, `validate`, `estimateCost` |
| `prompt.*` | `list`, `get`, `save`, `fork`, `preview` (render with sample variables), `reset` |
| `models.*` | `catalog`, `discover(provider)` |
| `worktree.*` | `diff`, `apply`, `discard`, `merge` |
| `env.*` | `doctor`, `detectClis`, `authStatus` |
| `events.*` | `subscribe(sessionId, fromSeq)` |

### 4.2 Events (engine → UI)

Envelope: `{ seq, sessionId, seatId?, stageId?, at, type, data }` — full catalog in main plan §4.6.

**Ordering & reliability**
- `seq` is monotonic per session; every event is appended to `.assentor/sessions/<id>/events.ndjson` **before** it's emitted.
- On reconnect (UI reload, engine restart) the UI calls `events.subscribe(sessionId, lastSeq)` → engine replays the gap. No lost or duplicated state.

**Backpressure & smoothness**
- High-frequency `seat.output.delta` events are **coalesced in the engine** into frames (~30–50 ms) per seat.
- Rust forwards over a Tauri **Channel** (ordered, designed for streaming), not global events.
- UI applies frames inside `requestAnimationFrame`; inactive tabs keep only the last N lines per seat in a ring buffer.

### 4.3 Versioning
- Handshake on startup: `{engineVersion, protocolVersion, capabilities[]}`. Host refuses mismatched major versions (only possible if someone swaps the sidecar — engine and app ship together).

---

## 5. Key runtime flows

### 5.1 App start
```
Rust: single-instance check → resolve login-shell PATH → spawn engine sidecar (in job object)
Engine: handshake → load config/prompts → env.detectClis (claude, codex, agy, cursor…)
UI: Onboarding if first run (detect CLIs, auth status, keys) else Session list
```

### 5.2 Negotiate + review session ("3× Opus + 2× Codex", panel review)
```
UI  session.create(playbook="feature-build", teams=…) → session.start
Eng stage Plan/Negotiate(debate):
      seats Opus#1..3, Codex#1..2 queued → scheduler admits per-provider concurrency
      R1 proposals → R2 anonymized critiques → R3 revisions → consensus 0.8 ✓
Eng stage Implement(best-of-n=2): worktrees created, gates run per worktree, judge picks
Eng stage Review(panel): N reviewer seats (read-only) → findings correlated → verdict
      NEEDS_WORK → back to Implement with findings   |   PASS → merge worktree → done
UI  live: seat cards, stage rail, consensus meter, findings; notification on finish/needs-input
```

### 5.3 Realtime model switch
```
UI seat.setModel(Opus#2, "sonnet") → Engine marks pending → seat.model.changed{pending}
At turn boundary: restart CLI with --model sonnet (resume session id when supported)
User may choose "apply now" → engine kills current turn (proc tree) and restarts it
```

### 5.4 Engine crash
```
Rust detects exit → status "Engine restarting" → respawn (backoff 1s,2s,5s)
Engine reloads sessions from disk → marks interrupted seats → UI resubscribes from lastSeq
User: "Resume" per session (existing resume logic)
```

### 5.5 App quit
```
Rust → engine.shutdown (grace 5s: persist, stop seats) → job object / process group kill
Guarantees no orphaned claude/codex processes on any OS.
```

---

## 6. Data & storage

| Data | Location | Notes |
|---|---|---|
| Global config, teams, playbooks | `~/.assentor/config.yaml` | Shared with CLI |
| User prompts | `~/.assentor/prompts/*.md` | Shared with CLI |
| Project prompts/config | `<project>/.assentor/` | Versionable in git |
| Sessions, events, reports | `<project>/.assentor/sessions/<id>/` | NDJSON event log + snapshots |
| Worktrees | `<project>/.assentor/worktrees/` | Auto-cleaned; keep on failure for inspection |
| Secrets | **OS keychain** (desktop) / existing encrypted vault (CLI) | Engine asks host for secrets through a narrow RPC; never sent to webview |
| App/UI prefs | Tauri app data dir | Window layout, theme |

The CLI and desktop app read the **same files**, so users can start in the terminal and watch in the app (or the reverse).

---

## 7. Security model

1. **Webview is untrusted-by-default:** CSP with no remote scripts; capability file allows only the broker commands; no shell/fs plugins exposed.
2. **No network port in desktop mode** — stdio between Rust and engine. (Browser mode `serve` binds 127.0.0.1 with a random token + Origin check.)
3. **Secrets** live in the OS keychain; redaction (existing `security/redact`) applied to all events before they leave the engine.
4. **Seat permissions:** read-only seats never receive `--dangerously-*`/bypass flags; editing seats are confined to their worktree.
5. **Signed updates** (Tauri's update signature, mandatory) on top of OS code signing.
6. **External paths** policy (existing `allowExternalPaths`) enforced by the engine for every RPC that takes a path.

---

## 8. Cross-platform specifics & gotchas

| Topic | macOS | Windows | Linux |
|---|---|---|---|
| PATH for CLIs | GUI apps miss shell PATH → resolve via login shell | Respect `PATHEXT`, `.cmd` shims (existing locator handles) | Same as macOS; AppImage env quirks |
| Kill process trees | Process group | **Job Object** (taskkill as fallback) | Process group |
| Webview | WKWebView | WebView2 (bootstrap if missing) | WebKitGTK 4.1 — perf testing needed |
| Installer | `.dmg` (universal or per-arch) | NSIS `.exe` (+ optional MSI) | AppImage, `.deb`, `.rpm` (Flatpak later) |
| Signing | Developer ID + notarization | Authenticode (e.g. Azure Trusted Signing or OV/EV cert) | Optional GPG for repos |
| Auto-update | ✅ | ✅ | ✅ AppImage; deb/rpm via package manager or manual |
| Worktree paths | — | Long-path limits → keep worktree paths short | — |
| CLI login flows | Some CLIs need an interactive TTY to log in → "Open terminal to log in" button, then re-detect | same | same |

---

## 9. Repository layout (proposed)

```
assentor/
  packages/
    engine/        ← today's src/ minus TUI (orchestration core)
    protocol/      ← zod schemas → TS types + JSON Schema (single source of truth)
    cli/           ← commander + Ink TUI (depends on engine, in-process transport)
    ui/            ← React app (transport-agnostic)
  apps/
    desktop/
      src-tauri/   ← Rust host, capabilities, icons, tauri.conf
      (uses packages/ui)
  scripts/ docs/ tests/
```

pnpm workspaces already exist, so this is a reorganization, not new tooling.

---

## 10. Build, test & release

**CI matrix (native runners — Tauri does not cross-compile macOS reliably):**

| Job | Runners |
|---|---|
| Engine unit + integration tests | ubuntu, macos, windows |
| UI unit tests (Vitest + Testing Library) | ubuntu |
| Rust host tests (`cargo test`, clippy) | ubuntu, macos, windows |
| E2E desktop (WebDriver via `tauri-driver`) | ubuntu, windows (macOS lacks WKWebView WebDriver → rely on Playwright against browser mode + manual smoke) |
| Contract tests for CLI recipes (recorded stream fixtures) | ubuntu |
| Release: build sidecars → `tauri build` → sign/notarize → upload + update manifest | macos (x64+arm64), windows (x64+arm64), ubuntu (x64+arm64) |

**Release channels:** `stable` and `beta` update feeds. Desktop version = engine version (one release train with the npm CLI).

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| WebKitGTK performance with many streaming seats | Janky Linux UI | Coalescing, virtualization, reduced animations on Linux, perf budget tests |
| Sidecar packaging (Node SEA per triple, signing nested binaries on macOS) | Release friction | Spike it first (see §12), automate in CI early |
| Three toolchains (Rust, Node, React) | Contributor friction | Rust layer kept small (<~2k lines), documented |
| CLI auth / PATH differences when launched from GUI | "CLI not found" support load | Login-shell PATH, Onboarding doctor, manual binary override (existing `binaries` config) |
| Webview rendering differences | Visual bugs per OS | Visual regression screenshots per OS in CI |

---

## 12. Spikes before committing (recommended, ~1 week)

1. **Sidecar spike:** Node SEA build of today's engine on all 3 OSes, launched from a hello-world Tauri app, signed on macOS. Measure installer size and cold start.
2. **Streaming spike:** 6 fake seats emitting deltas at CLI-like rates through Rust Channel → React; measure FPS/CPU on WebKitGTK, WebView2, WKWebView.
3. **Process spike:** spawn `claude`/`codex` from the GUI-launched app on each OS; verify PATH resolution and that quitting kills all children.

Go/no-go: if (1) or (3) fails badly, fall back to Electron with the same engine + UI packages — the design keeps that door open because UI and engine don't depend on Tauri.

---

## 13. Decisions needed

1. Accept **"engine stays TypeScript, Rust is a thin host"**? (Recommended; a Rust engine rewrite is a separate, much larger project.)
2. Secrets: move desktop secrets to the **OS keychain**, or keep the existing encrypted vault for both CLI and app?
3. Linux formats for v1: AppImage + `.deb` only, or also `.rpm`/Flatpak?
4. arm64 builds for Windows/Linux in v1, or x64 only at first?
5. Code signing accounts (Apple Developer, Windows signing) — who owns them?
