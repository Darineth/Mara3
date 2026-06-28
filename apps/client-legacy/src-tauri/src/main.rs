// Mara 3 legacy desktop client — a Tauri 1.x shell that can run on Windows 7 (with
// a bundled fixed-version WebView2 runtime). It mirrors the modern shell's server
// picker + portable settings, adapted to the Tauri 1 API. See ../README.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Win7 compatibility: neutralize the MSVC CRT's ETW imports (EventSetInformation is
// Win8+). Without this the binary won't load on Windows 7. See win7_compat.rs.
#[cfg(windows)]
mod win7_compat;

use std::fs::create_dir_all;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const DEFAULT_URL: &str = "http://localhost:5050";

/// Self-hosted `latest.json` the picker polls for newer Win7 builds, baked in at
/// build time via `MARA_UPDATE_URL` (this client points at its OWN manifest —
/// `latest-win7.json` — not the modern desktop's, since it's a separate download).
/// Empty (the default) disables the check. Mirrors the modern shell's nudge; see
/// `bootstrap/index.html`. Only NOTIFIES — the client stays a portable exe.
const UPDATE_MANIFEST_URL: &str = match option_env!("MARA_UPDATE_URL") {
    Some(u) => u,
    None => "",
};

fn seed_url() -> String {
    std::env::var("MARA_URL").unwrap_or_else(|_| DEFAULT_URL.to_string())
}

/// Persisted client settings — kept in settings.json next to the executable
/// (portable), matching the modern shell.
#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    #[serde(rename = "serverUrl")]
    server_url: String,
    #[serde(default)]
    recent: Vec<String>,
    #[serde(rename = "autoConnect", default)]
    auto_connect: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server_url: seed_url(),
            recent: Vec::new(),
            auto_connect: false,
        }
    }
}

fn settings_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "cannot resolve executable directory".to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings() -> Settings {
    let mut s = settings_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default();
    if s.server_url.trim().is_empty() {
        s.server_url = seed_url();
    }
    s
}

fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(dir) = path.parent() {
        create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings() -> Settings {
    load_settings()
}

#[tauri::command]
fn set_server_url(url: String) -> Result<Settings, String> {
    let trimmed = url.trim().to_string();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("URL must start with http:// or https://".to_string());
    }
    let mut s = load_settings();
    s.server_url = trimmed.clone();
    s.recent.retain(|u| u != &trimmed);
    s.recent.insert(0, trimmed);
    s.recent.truncate(5);
    save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
fn set_auto_connect(enabled: bool) -> Result<Settings, String> {
    let mut s = load_settings();
    s.auto_connect = enabled;
    save_settings(&s)?;
    Ok(s)
}

/// Navigate to the saved server. Tauri 1 has no Rust-side `navigate`, so we drive
/// the webview via JS (`location.replace`), which loads the remote hosted UI.
#[tauri::command]
fn open_app(window: tauri::Window) -> Result<(), String> {
    let url = load_settings().server_url;
    let js = format!(
        "window.location.replace({})",
        serde_json::to_string(&url).map_err(|e| e.to_string())?
    );
    window.eval(&js).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_server_url,
            set_auto_connect,
            open_app
        ])
        .setup(|app| {
            // Open the bundled picker page first; it persists the chosen server and
            // asks open_app to navigate to the live UI. Seed it with saved settings.
            let settings = load_settings();
            let init = format!(
                "window.__MARA_SETTINGS__ = {settings}; \
                 window.__MARA_UPDATE__ = {{ current: {current}, manifestUrl: {url} }};",
                settings = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_string()),
                current = serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap_or_default(),
                url = serde_json::to_string(UPDATE_MANIFEST_URL).unwrap_or_default(),
            );
            tauri::WindowBuilder::new(app, "main", tauri::WindowUrl::App("index.html".into()))
                .title("Mara 3")
                .inner_size(980.0, 720.0)
                .min_inner_size(480.0, 400.0)
                .initialization_script(&init)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mara 3 (legacy)");
}
