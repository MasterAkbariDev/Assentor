# Phase 5 — Desktop app (Tauri v2 + React + Rust)

Design: [desktop-app-system-design.md](../plans/desktop-app-system-design.md). Almost everything here is on the Danger list (process lifecycle, secrets, capabilities, signing), so most cards are 🔴. Haiku gets the bounded pieces.

The development cards use the owner-approved fixture scope. A hosted
release has separate acceptance checks.

- [ ] Verify Developer ID and Authenticode signing, macOS notarization,
  and signature or checksum verification of the published packages.
- [ ] Verify a beta upgrade through the hosted HTTPS manifest on each OS.
- [ ] Qualify live provider accounts from graphical launchers on macOS and
  Linux. The development suite uses stand-in Codex and Claude executables
  with the real host, engine, and operating-system process guard.

Windows x64 preview build and GUI smoke results are in the
[desktop preview README](../../apps/desktop/README.md).

---

### T05-01 · Spike: Node SEA engine sidecar on 3 OSes ✅
**Tier:** 🔴 O · **Review:** human · **Size:** M · **Depends:** T04-02

**Status** — Verified native x64 and ARM64 sidecars and Rust-to-engine
handshakes on all three OSes. The [preview report](../../apps/desktop/README.md)
records the startup samples, installer sizes, and macOS nested signature check.
The launch and stdio APIs passed the smoke checks. Built-in resources still
need to be bundled for real sessions.

**Deliverables** — build script producing `assentor-engine-<target-triple>[.exe]` via Node SEA for: aarch64/x86_64 apple-darwin, x86_64/aarch64 pc-windows-msvc, x86_64/aarch64 unknown-linux-gnu; hello-world Tauri app that spawns it and completes `engine.hello` over stdio; macOS signing of the nested binary; report: installer sizes, cold-start time, any Node APIs that broke under SEA. Bun-compile comparison optional.

---

### T05-02 · Spike: streaming perf harness ✅
**Tier:** 🟡 S · **Review:** O · **Size:** S · **Depends:** T04-07

**Status** — Windows WebView2 completed all 63 measured runs, with process
CPU and memory sampled at six seats and 500 events/s/seat. WKWebView and
WebKitGTK measurements remain open. [Benchmark report](../benchmarks/streaming.md)

**Deliverables** — `fake-engine` mode emitting 6 seats × configurable rate of deltas; measure FPS, CPU, memory in WKWebView, WebView2, WebKitGTK (dev builds) with the real Session board; report + recommended coalescer interval and list virtualization limits per OS.

---

### T05-03 · Spike: GUI-launched CLIs, PATH + kill-all ✅
**Tier:** 🔴 O · **Review:** human · **Size:** S · **Depends:** —

**Status** — The original Windows graphical launch found Codex, Cursor,
and Antigravity. Desktop qualification uses standalone mock Codex and Claude
executables with the real native host, engine, and process tree. Each mock
streams a completed session and leaves no live descendants after force-quit.
The macOS and Linux cases obtain the providers from an isolated login shell.
[Native validation](https://github.com/MasterAkbariDev/Assentor/actions/runs/44935100427)

**Deliverables** — on each OS, launch the hello-world app from the GUI (not a terminal): verify which CLIs are found with inherited PATH vs login-shell PATH; spawn `claude -p` and `codex exec` long runs; force-quit the app; verify zero survivors. Document results and the exact strategy for T05-05/T05-06.

---

### T05-04 · Rust host: sidecar supervisor + RPC broker ✅
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T05-01

**Status** — The native host starts the bundled engine, checks the protocol, forwards supported requests over a per-window channel, and handles reconnect and shutdown.

**Deliverables** — `apps/desktop/src-tauri`: spawn sidecar with resolved env; handshake + version check; heartbeat; restart with backoff (1s, 2s, 5s, cap) and `engine.restarting` status to UI; `rpc_call` command (envelope passthrough, request id mapping, timeouts); `subscribe` command using a Tauri **Channel** per window/session; graceful shutdown sequence (5s grace) on quit; structured logging to app log dir; Rust unit + integration tests with a fake engine binary.

---

### T05-05 · Rust: process guard ✅
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** M · **Depends:** T05-04

**Status** — The Windows Job Object and Unix watchdog supervise provider subprocesses. The native fixture checks both provider and grandchild PIDs after force-quit.

**Deliverables** — Windows: create a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assign the sidecar (children inherit); Unix: sidecar as process-group leader, kill group on exit + on panic hook; crash of the Rust host must still kill children (test by aborting the host process in an integration test). Coordinate with engine `kill-tree` so double-kill is harmless.

---

### T05-06 · Rust: login-shell PATH resolver ✅
**Tier:** 🔴 O · **Review:** O2 · **Size:** S · **Depends:** T05-03

**Status** — The resolver merges valid absolute paths from an isolated login shell and tests noisy, failing, and slow shells. Windows uses the inherited PATH.

**Deliverables** — macOS/Linux: run `$SHELL -ilc 'printf "%s" "$PATH"'` once with timeout (3 s), sanitize output (take last line, validate entries are absolute paths), merge with inherited PATH (dedupe, inherited first unless missing), cache per launch; fallback to known install dirs (reuse engine's `cli-locator` default locations list via the engine, not duplicated); Windows: no-op. Never pass other env vars from the shell. Tests with fake shells (slow, noisy, failing).

---

### T05-07 · Capabilities + CSP lockdown ✅
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** S · **Depends:** T05-04

**Status** — The main window has an explicit native command allowlist and a restrictive CSP. The broker tests reject private and malformed requests.

**Deliverables** — capability files: main window allowed commands = `rpc_call`, `subscribe`, `os_notify`, `os_open_external` (https + allow-listed docs URLs only), window controls; **no** shell, fs, http plugins exposed to the webview; CSP: `default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'` (adjust only with justification); disable devtools in release; a test/checklist proving forbidden commands are rejected.

---

### T05-08 · Keychain bridge ✅
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** M · **Depends:** T05-04

**Status** — The desktop can opt in to a native keychain mirror. A fixture covers migration, fallback, and rollback when deleting a mirrored key fails.

**Deliverables** — Rust `keyring` integration (macOS Keychain, Windows Credential Manager, Linux Secret Service with clear error when unavailable → fall back to existing encrypted vault with a visible notice); engine-facing narrow RPC (`secrets.get/set/delete` by key id) only between Rust and engine — never callable from the webview; migration flow from existing vault (opt-in, reversible, no plaintext temp files).

---

### T05-09 · `TauriTransport` in UI ✅
**Tier:** 🟢 H · **Review:** S · **Size:** S · **Depends:** T05-04

**Status** — The UI uses the shared RPC transport contract over Tauri IPC and keeps the WebSocket transport for browser use. The transport suite covers reconnect and event subscriptions.

**Context to read** — `packages/ui/src/transport/Transport.ts` + `WebSocketTransport.ts` (T04-06), Rust command names/payloads from T05-04 README, `@tauri-apps/api` docs for `invoke` and `Channel`.

**Allowed files** — create: `packages/ui/src/transport/TauriTransport.ts`, its test; modify: `packages/ui/src/transport/index.ts` (auto-select Tauri when `window.__TAURI_INTERNALS__` exists, else WebSocket). **New deps:** `@tauri-apps/api` (v2).

**Spec**
1. `call(method, params)` → `invoke("rpc_call", { method, params })`; map Rust error payload `{ code, message, data }` to the same `RpcError` class `WebSocketTransport` throws.
2. `subscribe(sessionId, fromSeq, onEvent)` → create `Channel`, `invoke("subscribe", { sessionId, fromSeq, channel })`; returns unsubscribe that calls `invoke("unsubscribe", { subscriptionId })`.
3. `onStatus` listens to the `engine-status` event (`connected | restarting | failed`).
4. Behavior parity with `WebSocketTransport` — run the shared transport contract test suite from T04-06 against a mocked `invoke`.

**Tests** — shared contract suite passes; error mapping; auto-selection.

---

### T05-10 · Tray, notifications, single-instance, window state ✅
**Tier:** 🟢 H · **Review:** S · **Size:** M · **Depends:** T05-04

**Status** — The tray shows active sessions and their status. Native notification taps and second-instance links open the session. The native tray model is tested; OS notification delivery depends on the desktop environment.

**Context to read** — `apps/desktop/src-tauri/src/main.rs` + module layout from T05-04, Tauri v2 plugin docs: `notification`, `single-instance`, `window-state`, `deep-link`; T05-07 capability files (do not widen them — add only the exact permissions listed below).

**Allowed files** — `apps/desktop/src-tauri/src/os/{tray,notify,instance}.rs`, `apps/desktop/src-tauri/Cargo.toml` (only the listed plugins), `tauri.conf.json` (plugin config only), capability file (add only: `notification:default`, `window-state:default`); UI: `packages/ui/src/features/notifications/*`.

**Spec**
1. Tray menu: "Open Assentor", list of running sessions (title + status icon text), "Quit". Updates when sessions change (listen to engine events forwarded by host).
2. Native notification when a session finishes, fails, or enters `waiting` (needs approval/input) **and** the window is not focused. Clicking focuses the window and navigates to the session.
3. Single instance: second launch focuses the existing window and forwards `assentor://` deep-link args (`assentor://session/<id>` → navigate).
4. Window size/position persisted.
5. Linux: tray requires `libayatana-appindicator`; if unavailable, skip tray without crashing and log once.

**Tests** — Rust unit tests for menu model building from session list; UI test for notification-click navigation (mock).

**Escalate if** — any feature seems to need a capability not listed.

---

### T05-11 · Installer configs per OS ✅
**Tier:** 🟡 S · **Review:** O · **Size:** M · **Depends:** T05-04

**Status** — The unsigned preview workflow packages the Windows NSIS installer, macOS disk image, Linux DEB, and AppImage. [Preview packages](https://github.com/MasterAkbariDev/Assentor/actions/runs/44934566622)

**Deliverables** — `tauri.conf.json` bundle config: macOS `.dmg` (min 10.15, universal or per-arch per T05-01 findings), Windows NSIS (per-user install, WebView2 `downloadBootstrapper`), Linux AppImage + `.deb` (depends `libwebkit2gtk-4.1-0`, `libayatana-appindicator3-1`); icons for all sizes; file associations none; uninstall leaves `~/.assentor` untouched (document); CI job building unsigned artifacts on all 3 OSes.

---

### T05-12 · Updater + signing + release workflow ✅
**Tier:** 🔴 O · **Review:** O2 + human · **Size:** L · **Depends:** T05-11

**Status** — The draft-release workflow builds version-matched npm and desktop artifacts. A disposable Tauri key verifies a signed fixture and rejects changes to its payload or version. Production credentials and hosted update feeds are release prerequisites.

**Deliverables** — `tauri-plugin-updater` with update signing keypair (private key only in CI secrets); `stable`/`beta` manifests; macOS Developer ID signing + notarization (including sidecar), Windows Authenticode signing (e.g., Azure Trusted Signing), Linux checksums; release workflow on tags that builds npm + desktop together with the same version; rollback procedure documented; secrets never echoed in logs (masking verified).
