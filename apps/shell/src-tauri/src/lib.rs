use std::fs::create_dir_all;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Static JSON manifest the picker polls to learn about newer desktop builds, baked
/// in at build time via the `MARA_UPDATE_URL` env var (self-hosted). Empty — the
/// default — disables the check entirely (no banner ever shows). The manifest is
/// `{ "version": "3.0.1", "url": "https://…/Mara3-windows-x64-….zip", "notes": "…" }`
/// (its own `latest-windows-x64.json`);
/// the bootstrap picker compares `version` to this build's version and, if newer,
/// shows a non-blocking "update available" banner linking to `url`. We deliberately
/// keep the portable single-exe model — this only *notifies*; it never self-installs.
const UPDATE_MANIFEST_URL: &str = match option_env!("MARA_UPDATE_URL") {
    Some(u) => u,
    None => "",
};

/// The value used to seed the server address the first time (no settings file yet).
/// There is **no** built-in default — the picker starts empty so the client never
/// suggests a server the user didn't choose; `MARA_URL`, if set, seeds it (after that
/// the saved choice wins).
fn seed_url() -> String {
    std::env::var("MARA_URL").unwrap_or_default()
}

/// Saved window geometry (physical pixels), so the client reopens where you left it.
/// Position is in virtual-desktop coordinates, which inherently encodes the monitor;
/// on restore we recenter if it no longer overlaps any display (e.g. a monitor was
/// unplugged). When maximized we keep the last *restored* bounds here so un-maximizing
/// returns to the right place. All optional → a fresh/older settings file just centers.
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

/// Persisted client settings — a small JSON file kept **next to the executable**
/// (portable), so copying the exe folder carries its configuration with it.
#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    /// The Mara server this client connects to.
    #[serde(rename = "serverUrl")]
    server_url: String,
    /// Recently-used servers, most-recent first — drives the picker's suggestions.
    #[serde(default)]
    recent: Vec<String>,
    /// Whether to auto-connect to `server_url` on launch. Off by default, so a
    /// fresh install asks first; the user ticks it (it persists) once they've
    /// picked a server they want to stick.
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

/// The bundled bootstrap (picker) page URL, captured at startup so "Switch server"
/// can navigate the window back to it from any loaded server.
struct BootstrapUrl(String);

/// Path to `settings.json` beside the running executable (portable storage).
fn settings_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "cannot resolve executable directory".to_string())?;
    Ok(dir.join("settings.json"))
}

/// Load settings, falling back to defaults (seeded from `MARA_URL`/the default) on
/// a missing or unparsable file, so the client always has a usable server URL.
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
fn window_on_screen(window: &tauri::WebviewWindow) -> bool {
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
fn apply_window_state(window: &tauri::WebviewWindow, ws: &WindowState) {
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

/// Native capability exposed to the hosted web UI: append a line to the local log.
#[tauri::command]
fn mara_log(app: AppHandle, line: String) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("mara.log"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Return the current settings to the bootstrap picker.
#[tauri::command]
fn get_settings() -> Settings {
    load_settings()
}

/// Persist a chosen server URL (validated) and record it in the recent list.
#[tauri::command]
fn set_server_url(url: String) -> Result<Settings, String> {
    let trimmed = url.trim().to_string();
    let parsed = tauri::Url::parse(&trimmed).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("URL must start with http:// or https://".to_string());
    }
    let mut s = load_settings();
    s.server_url = trimmed.clone();
    // Most-recent-first, deduped, capped — the picker's suggestion list.
    s.recent.retain(|u| u != &trimmed);
    s.recent.insert(0, trimmed);
    s.recent.truncate(5);
    save_settings(&s)?;
    Ok(s)
}

/// Persist the auto-connect-on-launch preference.
#[tauri::command]
fn set_auto_connect(enabled: bool) -> Result<Settings, String> {
    let mut s = load_settings();
    s.auto_connect = enabled;
    save_settings(&s)?;
    Ok(s)
}

/// Called by the bootstrap page once the chosen server is reachable: navigate the
/// window to the live hosted UI. Rust-initiated navigation reliably loads the
/// remote origin (the bootstrap page handles retrying until this fires).
#[tauri::command]
fn open_app(app: AppHandle) -> Result<(), String> {
    let url: tauri::Url = load_settings()
        .server_url
        .parse()
        .map_err(|e| format!("invalid server URL: {e}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    window.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}

/// Return to the picker from a loaded server (the in-app "Switch server" action).
/// The `?switch=1` marker tells the picker to show even if auto-connect is on.
#[tauri::command]
fn switch_server(app: AppHandle) -> Result<(), String> {
    let base = app.state::<BootstrapUrl>().inner().0.clone();
    let mut url = tauri::Url::parse(&base).map_err(|e| format!("bootstrap url: {e}"))?;
    url.set_query(Some("switch=1"));
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
        .invoke_handler(tauri::generate_handler![
            mara_log,
            get_settings,
            set_server_url,
            set_auto_connect,
            open_app,
            switch_server
        ]);

    // Signed auto-update is desktop-only; mobile updates ship through app stores.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // Load the local bootstrap page first; it shows the server picker, polls
            // the chosen server, and asks us to navigate to the live UI once it is
            // reachable. Seed the picker with the saved settings.
            let settings = load_settings();
            // Seed the picker with the saved settings and the update-check context
            // (this build's version + the configured manifest URL). The picker does
            // the actual fetch/compare/banner in JS — see bootstrap/index.html.
            let init = format!(
                "window.__MARA_SETTINGS__ = {settings}; \
                 window.__MARA_UPDATE__ = {{ current: {current}, manifestUrl: {url} }};",
                settings = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_string()),
                current = serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap_or_default(),
                url = serde_json::to_string(UPDATE_MANIFEST_URL).unwrap_or_default(),
            );
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
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

            // Remember the bundled picker URL so "Switch server" can return to it.
            let boot = window.url().map(|u| u.to_string()).unwrap_or_default();
            app.manage(BootstrapUrl(boot));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mara 3");
}
