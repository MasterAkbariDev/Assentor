use serde_json::Value;
use tauri::{menu::MenuBuilder, tray::TrayIconBuilder, App, AppHandle, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "assentor";
const DOCUMENTATION: &str = "https://github.com/MasterAkbariDev/Assentor";

pub fn select_session(app: &AppHandle, id: Option<&str>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Some(id) = id.filter(|id| valid_id(id)) {
        let fragment =
            serde_json::to_string(&format!("#/sessions?session={id}")).unwrap_or_default();
        let _ = window.eval(format!("location.hash = {fragment}"));
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn install_tray(app: &App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "Open Assentor")
        .text("quit", "Quit")
        .build()?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Assentor")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => select_session(app, None),
            "quit" => app.exit(0),
            id => select_session(app, id.strip_prefix("session:")),
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
pub async fn update_tray(window: WebviewWindow, sessions: Vec<Value>) -> Result<(), String> {
    super::trusted(&window)?;
    let app = window.app_handle();
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let mut menu = MenuBuilder::new(app).text("show", "Open Assentor");
    for (id, label) in session_menu_entries(&sessions) {
        menu = menu.text(id, label);
    }
    let menu = menu
        .separator()
        .text("quit", "Quit")
        .build()
        .map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

fn session_menu_entries(sessions: &[Value]) -> impl Iterator<Item = (String, String)> + '_ {
    sessions
        .iter()
        .filter_map(|session| {
            let id = session["id"].as_str().filter(|id| valid_id(id))?;
            let status = match session["status"].as_str()? {
                "running" | "executing" | "reviewing" | "planning" => "●",
                "waiting" | "paused" => "◐",
                _ => return None,
            };
            let name: String = session["title"]
                .as_str()
                .unwrap_or("Session")
                .chars()
                .filter(|c| !c.is_control())
                .take(70)
                .collect();
            Some((
                format!("session:{id}"),
                format!("{status} {}", name.replace('&', "&&")),
            ))
        })
        .take(12)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_running_and_waiting_sessions_and_omits_other_entries() {
        let sessions = serde_json::json!([
            {"id": "one", "title": "Build & review", "status": "running"},
            {"id": "two", "title": "Needs approval", "status": "waiting"},
            {"id": "three", "status": "completed"},
            {"id": "invalid&session", "status": "running"}
        ]);
        assert_eq!(
            session_menu_entries(sessions.as_array().unwrap()).collect::<Vec<_>>(),
            vec![
                ("session:one".into(), "● Build && review".into()),
                ("session:two".into(), "◐ Needs approval".into()),
            ],
        );
    }
}

#[tauri::command]
pub async fn os_notify(
    window: WebviewWindow,
    kind: String,
    session_id: String,
) -> Result<(), String> {
    super::trusted(&window)?;
    if !valid_id(&session_id) {
        return Err(String::from("Invalid notification session"));
    }
    if window.is_focused().unwrap_or(true) {
        return Ok(());
    }
    let message = match kind.as_str() {
        "completed" => "An Assentor session completed.",
        "failed" => "An Assentor session needs attention.",
        "waiting" => "An Assentor session is waiting for input.",
        _ => return Err(String::from("Unknown session notification")),
    };
    window
        .app_handle()
        .notification()
        .builder()
        .title("Assentor")
        .body(message)
        .extra("sessionId", session_id)
        .show()
        .map_err(|error| error.to_string())
}

pub fn install_notification_actions(app: &App) -> tauri_plugin_notification::Result<()> {
    let handle = app.handle().clone();
    app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        let session = action
            .notification()
            .and_then(|notification| notification.extra().get("sessionId"))
            .and_then(Value::as_str);
        select_session(&handle, session);
    })
}

#[tauri::command]
pub async fn os_open_external(window: WebviewWindow, url: String) -> Result<(), String> {
    super::trusted(&window)?;
    if url != DOCUMENTATION {
        return Err(String::from("This documentation URL is not allowed"));
    }
    window
        .app_handle()
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}
