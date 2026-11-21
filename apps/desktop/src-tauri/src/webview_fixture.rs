use serde_json::Value;
use std::{env, fs, path::PathBuf};
use tauri::{Manager, State, WebviewWindow};

pub struct WebviewFixture(Option<PathBuf>);

impl WebviewFixture {
    pub fn from_args() -> Self {
        let mut args = env::args_os().skip(1);
        let output = if cfg!(debug_assertions)
            && args.next().as_deref() == Some(std::ffi::OsStr::new("--webview-fixture"))
        {
            args.next()
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        } else {
            None
        };
        Self(output)
    }
}

#[tauri::command]
pub async fn report_webview_fixture(
    window: WebviewWindow,
    state: State<'_, WebviewFixture>,
    report: Value,
) -> Result<(), String> {
    super::trusted(&window)?;
    let destination = state.0.as_ref().ok_or("This is not a benchmark session")?;
    if report["sampling"] == true {
        return fs::write(destination.with_extension("sampling"), b"ready")
            .map_err(|_| String::from("Could not begin the resource sample"));
    }
    let json = serde_json::to_vec(&report).map_err(|_| "Invalid benchmark results")?;
    if json.len() > 2 * 1024 * 1024 {
        return Err(String::from("Benchmark results exceed the output limit"));
    }
    fs::write(destination, json).map_err(|_| "Could not record the benchmark results")?;
    window.app_handle().exit(0);
    Ok(())
}
