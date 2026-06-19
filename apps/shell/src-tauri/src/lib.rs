use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Default server the thin client points at; override with the `MARA_URL` env var.
const DEFAULT_URL: &str = "http://localhost:5050";

fn server_url() -> String {
    std::env::var("MARA_URL").unwrap_or_else(|_| DEFAULT_URL.to_string())
}

/// Native capability exposed to the hosted web UI: append a line to the local log.
#[tauri::command]
fn mara_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("mara.log"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Called by the bootstrap page once the server is reachable: navigate the
/// window to the live hosted UI. Rust-initiated navigation reliably loads the
/// remote origin (the bootstrap page handles retrying until this fires).
#[tauri::command]
fn open_app(app: tauri::AppHandle) -> Result<(), String> {
    let url: tauri::Url = server_url()
        .parse()
        .map_err(|e| format!("invalid MARA_URL: {e}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    window.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![mara_log, open_app]);

    // Signed auto-update is desktop-only; mobile updates ship through app stores.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // Load the local bootstrap page first; it polls the server and asks
            // us to navigate to the live UI once it is reachable (retry-on-start).
            let init = format!(
                "window.__MARA_URL__ = {};",
                serde_json::to_string(&server_url()).unwrap_or_else(|_| "\"\"".to_string())
            );
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mara 3")
                .inner_size(980.0, 720.0)
                .min_inner_size(480.0, 400.0)
                .initialization_script(&init)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mara 3");
}
