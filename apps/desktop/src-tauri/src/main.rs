#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod broker;
mod desktop_controls;
mod keychain;
mod login_path;
mod process_guard;
mod updates;
mod webview_fixture;

use broker::Broker;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::PathBuf,
    sync::atomic::{AtomicU8, Ordering},
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    time::timeout,
};

const DESKTOP_RUNNING: u8 = 0;
const DESKTOP_DRAINING: u8 = 1;
const DESKTOP_EXIT_READY: u8 = 2;

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(String::from(
            "Command is only available to the main Assentor window",
        ));
    }
    Ok(())
}

#[tauri::command]
async fn engine_connect(
    window: WebviewWindow,
    broker: State<'_, Broker>,
    channel: Channel<Value>,
) -> Result<Value, String> {
    trusted(&window)?;
    broker.connect(channel).await
}

#[tauri::command]
async fn rpc_call(
    window: WebviewWindow,
    broker: State<'_, Broker>,
    generation: u64,
    frame: String,
) -> Result<(), String> {
    trusted(&window)?;
    broker.request(generation, frame).await
}

#[tauri::command]
async fn current_project(
    window: WebviewWindow,
    broker: State<'_, Broker>,
) -> Result<PathBuf, String> {
    trusted(&window)?;
    Ok(broker.project().await)
}

#[tauri::command]
async fn choose_project(
    window: WebviewWindow,
    broker: State<'_, Broker>,
) -> Result<Option<PathBuf>, String> {
    trusted(&window)?;
    let (send, answer) = tokio::sync::oneshot::channel();
    window
        .app_handle()
        .dialog()
        .file()
        .set_title("Open Assentor project")
        .pick_folder(move |folder| {
            let _ = send.send(folder);
        });
    let Some(folder) = answer.await.map_err(|_| "Could not open project picker")? else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|_| "Choose a local project directory")?;
    let project = fs::canonicalize(path).map_err(|_| "The project directory is unavailable")?;
    if !project.is_dir() {
        return Err(String::from("Choose a project directory"));
    }
    let settings = window
        .app_handle()
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&settings).map_err(|error| error.to_string())?;
    let data = serde_json::to_vec(&project).map_err(|error| error.to_string())?;
    fs::write(settings.join("project.json"), data).map_err(|error| error.to_string())?;
    broker.set_project(project.clone()).await;
    Ok(Some(project))
}

fn project_for(app: &tauri::App) -> std::io::Result<PathBuf> {
    let explicit = env::args_os().nth(1).map(PathBuf::from);
    let saved = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|path| fs::read(path.join("project.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<PathBuf>(&bytes).ok());
    if let Some(path) = explicit.or(saved).filter(|path| path.is_dir()) {
        return fs::canonicalize(path);
    }
    if let Ok(dir) = env::current_dir() {
        if let Some(root) = dir.ancestors().find(|dir| dir.join(".git").exists()) {
            return Ok(root.to_path_buf());
        }
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(std::io::Error::other)?
        .join("workspace");
    fs::create_dir_all(&path)?;
    Ok(path)
}

async fn handshake() -> Result<Value, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let parent = executable
        .parent()
        .ok_or("The desktop executable has no parent directory")?;
    let resources = [
        parent.join("engine-resources"),
        parent.join("../Resources/engine-resources"),
        parent.join("../lib/Assentor Desktop/engine-resources"),
    ]
    .into_iter()
    .find(|path| path.join("prompts/builtin").is_dir())
    .ok_or("The bundled desktop resources are missing")?;
    let mut guard = process_guard::GuardedChild::start(&env::temp_dir(), &resources, false)
        .map_err(|error| error.to_string())?;
    let mut input = guard
        .child
        .stdin
        .take()
        .ok_or("The engine has no input pipe.")?;
    let output = guard
        .child
        .stdout
        .take()
        .ok_or("The engine has no output pipe.")?;
    let request = json!({"jsonrpc":"2.0","id":1,"method":"engine.hello","params":{}});
    let frame = format!("{request}\n");
    let mut lines = BufReader::new(output).lines();
    input
        .write_all(&[1])
        .await
        .map_err(|error| error.to_string())?;
    if lines
        .next_line()
        .await
        .map_err(|error| error.to_string())?
        .as_deref()
        != Some("ready")
    {
        return Err(String::from("The engine process guard did not start"));
    }
    input
        .write_all(frame.as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let line = lines
        .next_line()
        .await
        .map_err(|error| error.to_string())?
        .ok_or("The engine closed its output before responding.")?;
    let response: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if response["jsonrpc"] != "2.0"
        || response["id"] != 1
        || response["result"]["engineVersion"] != env!("CARGO_PKG_VERSION")
        || response["result"]["protocolVersion"] != 1
    {
        return Err(String::from(
            "The bundled engine returned an incompatible handshake.",
        ));
    }
    let prompts = json!({"jsonrpc":"2.0","id":2,"method":"prompt.list","params":{}});
    input
        .write_all(format!("{prompts}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let line = lines
        .next_line()
        .await
        .map_err(|error| error.to_string())?
        .ok_or("The engine did not enumerate its built-in prompts")?;
    let result: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if result["id"] != 2
        || !result["result"]["prompts"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    {
        return Err(String::from(
            "The desktop engine could not load its built-in prompts",
        ));
    }

    drop(input);
    let status = guard
        .child
        .wait()
        .await
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("The engine exited with {status}."));
    }
    Ok(response["result"].clone())
}

fn main() {
    #[cfg(debug_assertions)]
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--fixture-engine")) {
        let failure = tauri::async_runtime::block_on(fixture_engine());
        if let Err(error) = failure {
            eprintln!("Desktop fixture failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(keychain::HELPER_ARG)) {
        if keychain::run().is_err() {
            std::process::exit(1);
        }
        return;
    }
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(process_guard::WORKER_ARG)) {
        if let Err(error) = process_guard::run_worker() {
            eprintln!("Assentor worker failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--smoke-test")) {
        match tauri::async_runtime::block_on(async {
            timeout(Duration::from_secs(15), handshake()).await
        }) {
            Ok(Ok(result)) => println!("{result}"),
            failure => {
                eprintln!("Desktop engine smoke test failed: {failure:?}");
                std::process::exit(1);
            }
        }
        return;
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            desktop_controls::select_session(
                app,
                args.iter()
                    .find_map(|arg| arg.strip_prefix("assentor://session/")),
            );
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let project = project_for(app)?;
            let log = app.path().app_log_dir()?;
            fs::create_dir_all(&log)?;
            let resources = app.path().resource_dir()?.join("engine-resources");
            app.manage(Broker::new(project, resources, log.join("engine.ndjson")));
            app.manage(AtomicU8::new(DESKTOP_RUNNING));
            app.manage(webview_fixture::WebviewFixture::from_args());
            if let Err(error) = desktop_controls::install_tray(app) {
                eprintln!("Assentor tray unavailable: {error}");
            }
            desktop_controls::install_notification_actions(app)?;
            let desktop = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() == "assentor" && url.host_str() == Some("session") {
                        desktop_controls::select_session(
                            &desktop,
                            Some(url.path().trim_start_matches('/')),
                        );
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_connect,
            rpc_call,
            current_project,
            choose_project,
            desktop_controls::update_tray,
            desktop_controls::os_notify,
            desktop_controls::os_open_external,
            updates::desktop_update,
            webview_fixture::report_webview_fixture
        ])
        .build(tauri::generate_context!())
        .expect("could not start Assentor Desktop");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let exit = app.state::<AtomicU8>();
            if exit.load(Ordering::Acquire) == DESKTOP_EXIT_READY {
                return;
            }
            api.prevent_exit();
            if exit
                .compare_exchange(
                    DESKTOP_RUNNING,
                    DESKTOP_DRAINING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<Broker>().shutdown().await;
                    app.state::<AtomicU8>()
                        .store(DESKTOP_EXIT_READY, Ordering::Release);
                    app.exit(0);
                });
            }
        }
    });
}

#[cfg(debug_assertions)]
async fn fixture_engine() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(2);
    let project = PathBuf::from(args.next().ok_or("missing fixture project")?);
    let resources = PathBuf::from(args.next().ok_or("missing fixture resources")?);
    let mut guard = process_guard::GuardedChild::start(&project, &resources, true)?;
    let mut input = guard.child.stdin.take().ok_or("missing fixture input")?;
    let mut output = BufReader::new(guard.child.stdout.take().ok_or("missing fixture output")?);
    input.write_all(&[1]).await?;
    let mut marker = String::new();
    timeout(Duration::from_secs(10), output.read_line(&mut marker)).await??;
    if marker.trim_end() != "ready" {
        return Err("native fixture guard did not start".into());
    }
    let forward_input = async move {
        tokio::io::copy(&mut tokio::io::stdin(), &mut input).await?;
        input.shutdown().await
    };
    let forward_output = async move {
        let mut stdout = tokio::io::stdout();
        tokio::io::copy(&mut output, &mut stdout).await?;
        stdout.flush().await
    };
    tokio::try_join!(forward_input, forward_output)?;
    let status = guard.child.wait().await?;
    if !status.success() {
        return Err(format!("native fixture worker exited with {status}").into());
    }
    Ok(())
}
