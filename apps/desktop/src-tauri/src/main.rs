#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{env, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

fn engine_executable() -> Result<PathBuf, String> {
    let app = env::current_exe().map_err(|error| error.to_string())?;
    Ok(app.with_file_name(format!("assentor-engine{}", env::consts::EXE_SUFFIX)))
}

fn engine_command() -> Result<Command, String> {
    let mut command = Command::new(engine_executable()?);
    command
        .env_remove("NODE_OPTIONS")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    Ok(command)
}

#[tauri::command]
async fn engine_hello() -> Result<Value, String> {
    timeout(Duration::from_secs(10), handshake())
        .await
        .map_err(|_| String::from("The engine handshake timed out."))?
}

async fn handshake() -> Result<Value, String> {
    let mut child = engine_command()?
        .arg(env::temp_dir())
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut input = child.stdin.take().ok_or("The engine has no input pipe.")?;
    let output = child
        .stdout
        .take()
        .ok_or("The engine has no output pipe.")?;
    let request = json!({"jsonrpc":"2.0","id":1,"method":"engine.hello","params":{}});
    let frame = format!("{request}\n");
    input
        .write_all(frame.as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let mut lines = BufReader::new(output).lines();
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

    drop(input);
    let status = child.wait().await.map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("The engine exited with {status}."));
    }
    Ok(response["result"].clone())
}

#[tauri::command]
async fn check_provider_clis() -> Result<Value, String> {
    let output = timeout(
        Duration::from_secs(10),
        engine_command()?
            .arg("--check-clis")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| String::from("The CLI check timed out."))?
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("The CLI check exited with {}.", output.status));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn main() {
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--smoke-test")) {
        match tauri::async_runtime::block_on(engine_hello()) {
            Ok(result) => println!("{result}"),
            Err(error) => {
                eprintln!("Desktop engine smoke test failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_hello, check_provider_clis])
        .run(tauri::generate_context!())
        .expect("could not start the Assentor desktop preview");
}
