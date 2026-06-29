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

/// Self-hosted manifest the picker polls for newer Win7 builds, baked in at build
/// time via `MARA_UPDATE_URL` (this client points at its OWN manifest —
/// `latest-windows7-x64.json` — not the modern desktop's, since it's a separate download).
/// Empty (the default) disables the check. Mirrors the modern shell's nudge; see
/// `bootstrap/index.html`. Only NOTIFIES — the client stays a portable exe.
const UPDATE_MANIFEST_URL: &str = match option_env!("MARA_UPDATE_URL") {
    Some(u) => u,
    None => "",
};

/// First-run seed for the server address. No built-in default (the picker starts
/// empty so the client never suggests a server the user didn't pick); `MARA_URL`, if
/// set, seeds it.
fn seed_url() -> String {
    std::env::var("MARA_URL").unwrap_or_default()
}

/// Saved window geometry (physical pixels), so the client reopens where you left it.
/// Position is in virtual-desktop coordinates, which inherently encodes the monitor;
/// on restore we recenter if it no longer overlaps any display (e.g. a monitor was
/// unplugged). When maximized we keep the last *restored* bounds here so un-maximizing
/// returns to the right place. Mirrors the modern shell's WindowState.
#[derive(Serialize, Deserialize, Clone, Default)]
struct WindowState {
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    maximized: bool,
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
    /// Window position/size/maximized state, restored on the next launch.
    #[serde(default)]
    window: WindowState,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server_url: seed_url(),
            recent: Vec::new(),
            auto_connect: false,
            window: WindowState::default(),
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

/// Merge the window geometry into settings.json without disturbing the rest. Window
/// state is non-critical, so failures are swallowed (we never block close on it).
fn save_window_state(window: &WindowState) {
    let mut s = load_settings();
    s.window = window.clone();
    let _ = save_settings(&s);
}

/// True if the window has any visible overlap with a connected monitor. Guards against
/// restoring onto a display that's since been unplugged or rearranged (which would
/// strand the window off-screen). Unknown geometry/monitors → assume on-screen.
fn window_on_screen(window: &tauri::Window) -> bool {
    let (Ok(pos), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    let (wl, wt) = (pos.x, pos.y);
    let (wr, wb) = (pos.x + size.width as i32, pos.y + size.height as i32);
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let overlap_x = wr.min(mp.x + ms.width as i32) - wl.max(mp.x);
        let overlap_y = wb.min(mp.y + ms.height as i32) - wt.max(mp.y);
        overlap_x > 0 && overlap_y > 0
    })
}

/// Apply saved geometry to the freshly-built (still hidden) window: size, then
/// position (recentering if it lands off-screen), then maximize. Setting the restored
/// bounds before maximizing means un-maximizing later returns to them.
fn apply_window_state(window: &tauri::Window, ws: &WindowState) {
    if let (Some(w), Some(h)) = (ws.width, ws.height) {
        let _ = window.set_size(tauri::PhysicalSize::new(w, h));
    }
    if let (Some(x), Some(y)) = (ws.x, ws.y) {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        if !window_on_screen(window) {
            let _ = window.center();
        }
    }
    if ws.maximized {
        let _ = window.maximize();
    }
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
            let window =
                tauri::WindowBuilder::new(app, "main", tauri::WindowUrl::App("index.html".into()))
                    .title(concat!("Mara 3 v", env!("CARGO_PKG_VERSION")))
                    .inner_size(980.0, 720.0)
                    .min_inner_size(480.0, 400.0)
                    .visible(false) // restore saved geometry first, then show (no flash)
                    .initialization_script(&init)
                    .build()?;
            apply_window_state(&window, &settings.window);
            let _ = window.show();

            // Persist position/size/maximized so the next launch reopens here. Track
            // the live geometry in-session — ignoring maximized/minimized frames so the
            // stored bounds stay the *restored* ones — and write it back on close.
            let tracked = std::sync::Arc::new(std::sync::Mutex::new(settings.window.clone()));
            let ev_window = window.clone();
            window.on_window_event(move |event| {
                use tauri::WindowEvent;
                match event {
                    WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                        let maximized = ev_window.is_maximized().unwrap_or(false);
                        let minimized = ev_window.is_minimized().unwrap_or(false);
                        let mut t = tracked.lock().unwrap();
                        t.maximized = maximized;
                        if !maximized && !minimized {
                            if let Ok(p) = ev_window.outer_position() {
                                (t.x, t.y) = (Some(p.x), Some(p.y));
                            }
                            if let Ok(s) = ev_window.inner_size() {
                                if s.width > 0 && s.height > 0 {
                                    (t.width, t.height) = (Some(s.width), Some(s.height));
                                }
                            }
                        }
                    }
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                        save_window_state(&tracked.lock().unwrap());
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mara 3 (legacy)");
}
