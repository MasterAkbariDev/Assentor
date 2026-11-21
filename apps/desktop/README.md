# Assentor desktop preview

This is the Phase 5 sidecar and GUI discovery spike. The preview performs an
`engine.hello` handshake over stdin and stdout, then closes the engine. The
provider CLI check uses Assentor's normal binary discovery without launching a
provider or changing configuration.

## Build and run on a native host

Install [Tauri's native prerequisites](https://v2.tauri.app/start/prerequisites/)
and use a native Node.js 24 executable and Rust toolchain for the chosen
architecture. Run from the repository root.

```sh
pnpm install --frozen-lockfile
node scripts/desktop/build-sidecar.mjs
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

To verify the same host-to-engine handshake without opening a window, run
`cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -- --smoke-test`.
The desktop spike workflow runs that check with the native sidecar on each
supported OS and architecture.

Open `apps/desktop/src-tauri/target/debug/assentor-desktop` from the OS file
manager (`assentor-desktop.exe` on Windows). The window should report the engine
and protocol versions. Select **Check provider CLIs** to see what the app can
discover in its GUI-launched environment.

The sidecar builder emits one executable for the OS and architecture running
it. Run it natively for each target.

| OS | x64 | ARM64 |
| --- | --- | --- |
| Windows | `x86_64-pc-windows-msvc` | `aarch64-pc-windows-msvc` |
| macOS | `x86_64-apple-darwin` | `aarch64-apple-darwin` |
| Linux | `x86_64-unknown-linux-gnu` | `aarch64-unknown-linux-gnu` |

The macOS builder applies an ad hoc signature after injecting the SEA blob.
Production signing, notarization, installers, and installer size measurements
are still pending. The SEA smoke test covers the handshake and the preview
exercises CLI discovery. The packaged engine still needs the built-in prompts,
playbooks, and skills resources before it can host real sessions.

## Phase 5 validation

### Windows x64, November 21, 2026

- Node.js 24.16.0 packaged the engine into an 89.5 MiB sidecar. The smoke
  run took 845 ms from process launch through handshake and exit.
- The Tauri debug build opened in WebView2 and showed Assentor 0.3.19,
  RPC protocol 1. The unpackaged desktop executable was 12.0 MiB.
- GUI discovery found Antigravity, Cursor, and the standalone Codex CLI.
  The Codex binary bundled with the ChatGPT desktop app had previously been
  visible only from the test shell. Neither launch environment detected
  Claude. The Assentor check tested file discovery only. The standalone
  Codex CLI independently reported an active cached ChatGPT sign-in.
- The [streaming benchmark](../../docs/benchmarks/streaming.md#windows-x64--webview2-157-november-21-2026)
  completed its Windows WebView2 exploratory run. All 21 cases applied all
  events.

### Remaining checks

- Record native startup and installer size for Windows, macOS and Linux.
- Compare discovery from the OS launcher with discovery from a login shell.
- In a disposable project, check that force-quit leaves no provider child
  processes after a long-running Claude or Codex invocation. The current
  preview only starts short-lived sidecar processes. Whole-tree cleanup is
  still unverified.
- Run three-repetition benchmarks with process CPU and memory in WebView2,
  WKWebView, and WebKitGTK.

See the [desktop task cards](../../docs/tasks/phase-5-desktop-tauri.md) for the
go/no-go criteria.
