# Assentor Desktop

The desktop app runs the Assentor workspace, sessions, and review UI with a
bundled engine. It connects over local native IPC. Open a project from the
header, then create a session or use **Settings → CLIs** to check discovery.

## Build and run on a native host

Install [Tauri's native prerequisites](https://v2.tauri.app/start/prerequisites/)
and use a native Node.js 24 executable and Rust toolchain for the chosen
architecture. Run from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm build:ui
node scripts/desktop/build-sidecar.mjs
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

To verify the same host-to-engine handshake without opening a window, run
`cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -- --smoke-test`.
The desktop spike workflow runs that check with the native sidecar on each
supported OS and architecture.

Run `node scripts/desktop/lifecycle/run.mjs` to verify that force-quitting the
probe owner shuts down a launcher and its child on the current OS. To use the
actual Codex app-server as the child, append the path to the native Codex
executable. It stays idle for the test. On macOS and Linux the probe covers
descendants that remain in the launcher's process group.

Open `apps/desktop/src-tauri/target/debug/assentor-desktop` from the OS file
manager (`assentor-desktop.exe` on Windows). The header shows the active
project and engine connection. An absolute project path can also be passed
as the first command-line argument.

The native session test starts the actual desktop host, worker, sidecar, and
CLI subprocesses. It substitutes a small executable for the Codex provider
and a mock reviewer, streams a completed session, then force-quits the host
with a second provider subprocess still running.

```sh
node scripts/desktop/session-smoke.mjs apps/desktop/src-tauri/target/debug/assentor-desktop
```

The sidecar builder emits one executable for the OS and architecture running
it. Run it natively for each target.

| OS | x64 | ARM64 |
| --- | --- | --- |
| Windows | `x86_64-pc-windows-msvc` | `aarch64-pc-windows-msvc` |
| macOS | `x86_64-apple-darwin` | `aarch64-apple-darwin` |
| Linux | `x86_64-unknown-linux-gnu` | `aarch64-unknown-linux-gnu` |

The macOS builder applies an ad hoc signature after injecting the SEA blob.
Installers include the built-in prompts, playbooks, and skills. Preview
packaging validates the handshake and prompt lookup with the packaged files.
Uninstalling the application leaves the Assentor vault and project files
available to the CLI.

## Keychain and updates

**Settings → API keys** can copy credentials into the OS keychain. The CLI's
encrypted vault remains available for older builds and when the OS store
cannot be reached. Remove the keychain copies before deleting mirrored keys
from the CLI. The webview receives only metadata and counts.

The tag workflow builds the shared npm package and signed desktop artifacts
for a draft release. Align the package, Rust, and Tauri versions before pushing
a `desktop-v<version>` tag. Beta versions use `-beta.<number>`.

- Repository variables supply the public Tauri verification key and the
  stable and beta HTTPS manifest URLs. Each release produces a
  `latest.json` manifest. Point the corresponding channel at that asset only
  after publishing its release.
- GitHub secrets supply the updater private key and the Windows and macOS
  signing credentials. Tests use preview bundles and do not need these
  credentials. Review the draft bundle signatures and hashes before publishing.
- To roll back a channel, point its manifest at the last trusted release.
  Clients on a newer version can reinstall that release manually. Publish a
  higher-version corrective release for automatic rollback.

## Phase 5 validation

### Windows x64, November 21, 2026

- Node.js 24.16.0 packaged the engine into an 89.5 MiB sidecar. The smoke
  run took 845 ms from process launch through handshake and exit.
- The Tauri debug build opened in WebView2 and showed Assentor 0.3.19,
  RPC protocol 1. The unpackaged desktop executable was 12.0 MiB.
- Tauri built an unsigned x64 NSIS preview installer at 24.57 MiB. Its
  installer script includes the sidecar beside the host executable.
- GUI discovery found Antigravity, Cursor, and the standalone Codex CLI.
  The Codex binary bundled with the ChatGPT desktop app had previously been
  visible only from the test shell. Neither launch environment detected
  Claude. The Assentor check tested file discovery only. The standalone
  Codex CLI independently reported an active cached ChatGPT sign-in.
- The [streaming benchmark](../../docs/benchmarks/streaming.md#windows-x64--webview2-157-november-21-2026)
  completed across 21 WebView2 cases with three repetitions each. All 63 runs
  applied their full event stream.
- In the isolated Windows lifecycle probe, force-terminating the Job Object
  owner stopped both the Node launcher and the real idle Codex app-server.
  The probe does not yet supervise provider processes launched by the GUI.

### Native build matrix, November 21, 2026

All six Windows, macOS, and Linux targets built their own Node SEA sidecar
and passed the Rust host-to-engine handshake. The build uses ad hoc signing
for the macOS sidecar.
[Native build results](https://github.com/MasterAkbariDev/Assentor/actions/runs/44928307191)

The following CI smoke times include starting the sidecar, exchanging the
handshake, and waiting for the sidecar to exit. Each is a single sample.

| OS | x64 | ARM64 |
| --- | ---: | ---: |
| Windows | 191 ms | 2,225 ms |
| macOS | 529 ms | 123 ms |
| Linux | 99 ms | 91 ms |

| Preview package | Size | Verified |
| --- | ---: | --- |
| Windows x64 NSIS | 24.57 MiB | Installer script includes the sidecar next to the app |
| macOS ARM64 DMG | 44.18 MiB | The app on the mounted image completed the handshake and its nested sidecar passed strict ad hoc signature verification |
| Linux x64 DEB | 81.67 MiB | The binaries extracted from the package completed the handshake |

[Native packaging results](https://github.com/MasterAkbariDev/Assentor/actions/runs/44929782193)

### Remaining checks

- Verify the production-signed installer and updater flow with release
  credentials and hosted manifests.
- Verify notification-click navigation on each native platform. Tray and
  session deep links already use the session selector.
- Run three-repetition benchmarks with process CPU and memory in WKWebView
  and WebKitGTK.

See the [desktop task cards](../../docs/tasks/phase-5-desktop-tauri.md) for the
go/no-go criteria.
