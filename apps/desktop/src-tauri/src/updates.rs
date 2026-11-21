use crate::{trusted, Broker};
use serde_json::{json, Value};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn desktop_update(
    window: WebviewWindow,
    broker: State<'_, Broker>,
    channel: String,
    confirm_version: Option<String>,
) -> Result<Value, String> {
    trusted(&window)?;
    let _installation = if confirm_version.is_some() {
        Some(
            INSTALLING
                .try_lock()
                .map_err(|_| "A desktop update is already in progress")?,
        )
    } else {
        None
    };
    let endpoint = match channel.as_str() {
        "stable" => option_env!("ASSENTOR_STABLE_UPDATE_URL"),
        "beta" => option_env!("ASSENTOR_BETA_UPDATE_URL"),
        _ => return Err(String::from("Unknown Assentor update channel")),
    };
    let Some((key, endpoint)) = option_env!("ASSENTOR_UPDATER_PUBLIC_KEY").zip(endpoint) else {
        return Ok(json!({"enabled": false}));
    };
    if key.is_empty() || !endpoint.starts_with("https://") {
        return Err(String::from("Invalid desktop updater configuration"));
    }
    let update = window
        .app_handle()
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![endpoint
            .parse()
            .map_err(|_| "Invalid desktop update URL")?])
        .map_err(|_| "Invalid desktop update channel")?
        .build()
        .map_err(|_| "Could not initialize the desktop updater")?
        .check()
        .await
        .map_err(|_| "Could not check the desktop update channel")?;
    if let Some(update) = update {
        let version = update.version.clone();
        if let Some(expected) = confirm_version {
            if expected != version {
                return Err(String::from("The available version changed; check again"));
            }
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|_| "Could not download or verify the signed update")?;
            broker.shutdown().await;
            if update.install(bytes).is_err() {
                broker.reopen_after_failed_update().await;
                return Err(String::from("Could not install the verified update"));
            }
            #[cfg(not(windows))]
            {
                use std::sync::atomic::{AtomicU8, Ordering};
                window
                    .app_handle()
                    .state::<AtomicU8>()
                    .store(crate::DESKTOP_EXIT_READY, Ordering::Release);
                window.app_handle().restart();
            }
        }
        Ok(json!({"enabled": true, "version": version}))
    } else {
        Ok(json!({"enabled": true}))
    }
}
