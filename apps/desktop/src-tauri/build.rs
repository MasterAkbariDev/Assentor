fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "engine_connect",
            "rpc_call",
            "current_project",
            "choose_project",
            "update_tray",
            "os_notify",
            "os_open_external",
            "desktop_update",
            "report_webview_fixture",
        ]),
    ))
    .expect("build desktop command capabilities");
}
