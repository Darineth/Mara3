// Mara 3 legacy desktop client — a Tauri 1.x shell that can run on Windows 7 (with
// a bundled fixed-version WebView2 runtime). It mirrors the modern shell's server
// picker + portable settings, adapted to the Tauri 1 API. See ../README.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Win7 compatibility: neutralize the MSVC CRT's ETW imports (EventSetInformation is
// Win8+). Without this the binary won't load on Windows 7. See win7_compat.rs.
#[cfg(windows)]
mod win7_compat;

use std::fs::create_dir_all;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::scope::ipc::RemoteDomainAccessScope;
use tauri::Manager;

/// Self-hosted manifest the picker polls for newer Win7 builds, baked in at build
/// time via `MARA_UPDATE_URL` (this client points at its OWN manifest —
/// `latest-windows7-x64.json` — not the modern desktop's, since it's a separate download).
/// Empty (the default) disables the check. Mirrors the modern shell's nudge; see
/// `bootstrap/index.html`. Only NOTIFIES — the client stays a portable exe.
const UPDATE_MANIFEST_URL: &str = match option_env!("MARA_UPDATE_URL") {
    Some(u) => u,
    None => "",
};

/// Log line terminator. Windows text viewers (notably old Notepad on Win7) need CRLF — a
/// lone LF shows the whole file as one line — and Rust file writes are byte-exact (no
/// text-mode translation), so emit it explicitly.
#[cfg(windows)]
const LINE_END: &str = "\r\n";
#[cfg(not(windows))]
const LINE_END: &str = "\n";

/// Cap on a single logged line (bytes of `line`); longer lines are truncated with a
/// marker. Real chat lines are far under this, so this only stops a malicious server
/// (whose page drives `mara_log` over IPC) from writing a giant string per call.
/// Mirrors the modern shell.
const MAX_LOG_LINE: usize = 8 * 1024;

/// Per-file size ceiling. Once a month's log reaches this, further lines are dropped
/// (silent no-op) instead of appended, bounding the disk one channel can consume under a
/// hostile server. Years of real logs top out ~5 MB/file, so 32 MB never trips normally.
/// Mirrors the modern shell.
const MAX_LOG_FILE: u64 = 32 * 1024 * 1024;

/// Cap on the channel label (characters) before it becomes a folder name — bounds an
/// otherwise attacker-controlled path segment (`sanitize_segment` can up to 4× its length
/// when percent-encoding). Mirrors the modern shell.
const MAX_LOG_CHANNEL: usize = 128;

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
    /// Where logs are written. Absent/`null` → `logs/` relative to the current working
    /// directory (where the client is launched from). A relative path resolves against
    /// the working directory; an absolute path is used as-is. An explicit blank string
    /// (`""`) disables disk logging. Mirrors the modern shell's `logDir`.
    #[serde(rename = "logDir", default)]
    log_dir: Option<String>,
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
            log_dir: None,
            window: WindowState::default(),
        }
    }
}

/// Directory of the running executable — the portable storage root for `settings.json`
/// and, by default, the `logs/` folder. Mirrors the modern shell.
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "cannot resolve executable directory".to_string())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(exe_dir()?.join("settings.json"))
}

/// Resolve the directory the local log file lives in, or `None` when disk logging is
/// switched off. Defaults to `logs/` relative to the **current working directory** (the
/// directory the client is launched from) — a plain relative `PathBuf`, so the OS
/// resolves it per-platform. The `logDir` setting overrides it: an absolute path is used
/// as-is, a relative one (like the default) resolves against the working directory.
/// **Only an explicit blank string (`""`) disables logging** — a missing or `null`
/// `logDir` keeps the default. Mirrors the modern shell's resolver.
fn log_dir() -> Option<PathBuf> {
    match load_settings().log_dir {
        Some(d) if d.trim().is_empty() => None,
        Some(d) => Some(PathBuf::from(d.trim())),
        None => Some(PathBuf::from("logs")),
    }
}

/// JSON the picker's startup screen uses to tell the user where logs go, or that logging
/// is off: `{"enabled":false}` or `{"enabled":true,"path":"<absolute dir>"}`. A relative
/// `logDir` is resolved against the current working directory so the shown path matches
/// where files actually land. Purely informational — nothing is created here. Mirrors the
/// modern shell.
fn log_location_json() -> String {
    match log_dir() {
        None => serde_json::json!({ "enabled": false }).to_string(),
        Some(dir) => {
            let abs = if dir.is_absolute() {
                dir
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(&dir))
                    .unwrap_or(dir)
            };
            serde_json::json!({ "enabled": true, "path": abs.to_string_lossy() }).to_string()
        }
    }
}

/// Reduce a channel name to one safe, **collision-free** path segment for its log
/// sub-folder. Anything unsafe in a filename is percent-encoded (uppercase hex of its
/// UTF-8 bytes), so distinct names stay distinct — e.g. `./test/` → `%2E%2Ftest%2F` and
/// `../test/` → `%2E.%2Ftest%2F` no longer collapse onto the same folder. We encode the
/// Windows-illegal set, control chars and `%` itself; a leading dot (so the segment can
/// never be `.`/`..` or a hidden file); a trailing dot (Windows silently strips those);
/// and the first char of a Windows reserved device name (CON/PRN/AUX/NUL, COM1-9,
/// LPT1-9). Outer whitespace is trimmed (insignificant). Empty → `unknown`. Mirrors the
/// modern shell.
fn sanitize_segment(name: &str) -> String {
    fn push_encoded(out: &mut String, c: char) {
        let mut buf = [0u8; 4];
        for &b in c.encode_utf8(&mut buf).as_bytes() {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    let chars: Vec<char> = name.trim().chars().collect();
    if chars.is_empty() {
        return "unknown".to_string();
    }
    let n = chars.len();
    let mut out = String::with_capacity(name.len());
    for (i, &c) in chars.iter().enumerate() {
        let illegal = matches!(
            c,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '%'
        ) || c.is_control();
        let leading_dot = i == 0 && c == '.';
        let trailing_dot = i == n - 1 && c == '.';
        if illegal || leading_dot || trailing_dot {
            push_encoded(&mut out, c);
        } else {
            out.push(c);
        }
    }
    // Neutralize Windows reserved device names (reserved even as a folder name) by
    // encoding the first character so the base before any dot no longer matches.
    let base = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        let mut it = out.chars();
        let first = it.next().unwrap();
        let rest = it.as_str().to_string();
        out.clear();
        push_encoded(&mut out, first);
        out.push_str(&rest);
    }
    out
}

/// Current local time as `(YYYY-MM, YYYY-MM-DD HH:MM:SS)` — the first for the monthly log
/// file name, the second for each line's timestamp prefix. The legacy client is
/// Windows-only and deliberately avoids a date crate (`chrono`'s `clock` feature pulls
/// `iana-time-zone`, whose Windows path uses WinRT — absent on Win7), so we read the wall
/// clock via Win32 `GetLocalTime` directly (one call → both strings stay consistent).
#[cfg(windows)]
fn local_now() -> (String, String) {
    #[repr(C)]
    struct SystemTime {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    extern "system" {
        fn GetLocalTime(lp_system_time: *mut SystemTime);
    }
    let mut st = SystemTime {
        w_year: 0,
        w_month: 0,
        w_day_of_week: 0,
        w_day: 0,
        w_hour: 0,
        w_minute: 0,
        w_second: 0,
        w_milliseconds: 0,
    };
    // SAFETY: GetLocalTime (kernel32, present since Win2000) only writes the struct.
    unsafe { GetLocalTime(&mut st) };
    let month = format!("{:04}-{:02}", st.w_year, st.w_month);
    let full = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        st.w_year, st.w_month, st.w_day, st.w_hour, st.w_minute, st.w_second
    );
    (month, full)
}

/// Non-Windows fallback (the legacy client only ships on Windows; this keeps `cargo
/// check` on a dev host compiling).
#[cfg(not(windows))]
fn local_now() -> (String, String) {
    ("0000-00".to_string(), "0000-00-00 00:00:00".to_string())
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

/// Native capability exposed to the hosted web UI: append a line to the local log,
/// split per `channel` into its own sub-folder and per-month file
/// (`<logDir>/<channel>/Mara3_YYYY-MM.log`). `logDir` defaults to `logs/`; a blank
/// `logDir` disables logging, so this becomes a silent no-op. Only the loaded server's
/// page can reach it — the origin is granted IPC at runtime (see `grant_remote_ipc`).
/// Mirrors the modern shell's `mara_log`.
#[tauri::command]
fn mara_log(channel: String, line: String) -> Result<(), String> {
    let root = match log_dir() {
        Some(dir) => dir,
        None => return Ok(()),
    };
    // Clamp the (attacker-controllable) channel label before it becomes a folder name.
    let channel: String = channel.chars().take(MAX_LOG_CHANNEL).collect();
    let dir = root.join(sanitize_segment(&channel));
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (month, stamp) = local_now();
    let file_name = format!("Mara3_{month}.log");
    let path = dir.join(file_name);
    // Drop the write if this month's file is already at the ceiling (bounds the disk a
    // single channel can use under a hostile server; real files never approach it).
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) >= MAX_LOG_FILE {
        return Ok(());
    }
    // Clamp an over-long line on a char boundary so one call can't write megabytes.
    let line = if line.len() > MAX_LOG_LINE {
        let mut end = MAX_LOG_LINE;
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}… [truncated]", &line[..end])
    } else {
        line
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    // One line per call, prefixed with the channel + an explicit local timestamp:
    // `[<channel> YYYY-MM-DD HH:MM:SS] <line>` (channel kept so merged logs stay legible).
    write!(file, "[{channel} {stamp}] {line}{LINE_END}").map_err(|e| e.to_string())?;
    Ok(())
}

/// True when a command was invoked from the local bootstrap picker (served from the app's
/// own protocol) rather than a loaded remote server page. Tauri 1 has **no per-command
/// ACL** — once the connected origin is granted IPC, the loaded page can reach every
/// registered command — so the picker-only commands below use this to refuse calls coming
/// from a server. Local content is `tauri://localhost` (or `http://tauri.localhost` with
/// dangerousUseHttpScheme); a remote server page never matches. This is safe because the
/// picker only calls these before navigating and there is no switch-back-to-picker flow.
fn is_local_window(window: &tauri::Window) -> bool {
    let url = window.url();
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

#[tauri::command]
fn get_settings(window: tauri::Window) -> Result<Settings, String> {
    if !is_local_window(&window) {
        return Err("unavailable from a loaded server".to_string());
    }
    Ok(load_settings())
}

#[tauri::command]
fn set_server_url(window: tauri::Window, url: String) -> Result<Settings, String> {
    if !is_local_window(&window) {
        return Err("unavailable from a loaded server".to_string());
    }
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
fn set_auto_connect(window: tauri::Window, enabled: bool) -> Result<Settings, String> {
    if !is_local_window(&window) {
        return Err("unavailable from a loaded server".to_string());
    }
    let mut s = load_settings();
    s.auto_connect = enabled;
    save_settings(&s)?;
    Ok(s)
}

/// Host (no scheme/port/path/userinfo) of a server URL, for the IPC access scope.
/// A hand-rolled parse keeps the legacy client dependency-light. Returns `None` for a
/// bare IP address — Tauri 1's remote-IPC matching can't match IPs (tauri#7009), so
/// granting one would silently do nothing; callers treat that as "no native bridge".
fn host_of(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?; // drop any userinfo
    let host = authority.split(':').next()?; // drop port
    if host.is_empty() || host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None; // empty, or a dotted-decimal IPv4 (won't match in Tauri 1)
    }
    Some(host.to_string())
}

/// Grant the just-chosen server's host IPC access at runtime, so the loaded remote page
/// can reach the native commands (logging) — without hardcoding any hostname. We trust
/// only the host the user connected to. Tauri 1 forbids wildcards in config, but this
/// runtime scope is the supported escape hatch.
fn grant_remote_ipc(window: &tauri::Window, url: &str) {
    if let Some(host) = host_of(url) {
        window.ipc_scope().configure_remote_access(
            RemoteDomainAccessScope::new(host)
                .add_window("main")
                // Exactly the scheme in use. NOT chained http+https: the scope holds a
                // single Option<String> scheme, so a second allow_on_scheme silently
                // replaces the first — which used to break IPC for http:// servers.
                .allow_on_scheme(scheme_of(url))
                .enable_tauri_api(),
        );
    }
}

/// Scheme of a server URL for the IPC scope ("https" or "http"). Defaults to http —
/// `set_server_url` only ever stores one of the two.
fn scheme_of(url: &str) -> &'static str {
    if url.trim_start().starts_with("https://") {
        "https"
    } else {
        "http"
    }
}

/// Stable window label for a pop-out view (mirrors the modern shell): labels only
/// allow a limited charset, so the view is slugged, with a hash so distinct views
/// that slug identically still get their own windows.
fn popout_label(view: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    view.hash(&mut hasher);
    let slug: String = view
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(32)
        .collect();
    format!("popout-{slug}-{:x}", hasher.finish())
}

/// Open (or refocus) a native pop-out window pinned to one conversation, on behalf of
/// the loaded server page. The page passes only the *view* descriptor
/// (`channel:<name>` / `pm:<numeric token>`); the URL is built here from the saved
/// server address, so a hostile page can never point a native window at another
/// origin. Mirrors the modern shell's `open_popout`.
// Async, not sync: window creation from a synchronous command deadlocks on
// Windows (wry#583) — async commands run off the event loop thread.
#[tauri::command]
async fn open_popout(
    app: tauri::AppHandle,
    window: tauri::Window,
    view: String,
) -> Result<(), String> {
    let valid_channel = view
        .strip_prefix("channel:")
        .map(|n| !n.is_empty())
        .unwrap_or(false);
    let valid_pm = view
        .strip_prefix("pm:")
        .map(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false);
    if !valid_channel && !valid_pm {
        return Err("invalid view".to_string());
    }
    let server = load_settings().server_url;
    let mut url = tauri::Url::parse(&server).map_err(|e| format!("invalid server URL: {e}"))?;
    url.query_pairs_mut().clear().append_pair("view", &view);
    let label = popout_label(&view);
    if let Some(existing) = app.get_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    // The pop-out's page needs IPC too (close_self/focus_self): extend the remote
    // scope to its label before the page loads. No-op for IP-addressed servers
    // (tauri#7009) — the pop-out still works there, just without native close/focus.
    if let Some(host) = host_of(&server) {
        window.ipc_scope().configure_remote_access(
            RemoteDomainAccessScope::new(host)
                .add_window(&label)
                // Single scheme only — see the note in grant_remote_ipc.
                .allow_on_scheme(scheme_of(&server))
                .enable_tauri_api(),
        );
    }
    tauri::WindowBuilder::new(&app, &label, tauri::WindowUrl::External(url))
        .title("Mara 3")
        .inner_size(560.0, 680.0)
        .min_inner_size(360.0, 320.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Flash the calling window's taskbar button to alert the user to a PM or an
/// @mention that arrived while the window is in the background. Mirrors the modern
/// shell's `request_attention`: flashes the *calling* window (so a pop-out flashes
/// its own taskbar entry), and is a no-op when that window is already focused —
/// never flash the window the user is looking at. `Critical` keeps flashing until
/// the window regains focus (the OS clears it automatically).
#[tauri::command]
fn request_attention(window: tauri::Window) -> Result<(), String> {
    if window.is_focused().unwrap_or(false) {
        return Ok(());
    }
    window
        .request_user_attention(Some(tauri::UserAttentionType::Critical))
        .map_err(|e| e.to_string())
}

/// Close the calling pop-out window (JS `window.close()` is a no-op in a webview).
/// Restricted to pop-outs: the loaded page must never be able to close the main window.
#[tauri::command]
fn close_self(window: tauri::Window) -> Result<(), String> {
    if !window.label().starts_with("popout-") {
        return Err("only pop-out windows may close themselves".to_string());
    }
    window.close().map_err(|e| e.to_string())
}

/// Raise the calling pop-out window (the cross-window "focus this conversation" nudge).
#[tauri::command]
fn focus_self(window: tauri::Window) -> Result<(), String> {
    if !window.label().starts_with("popout-") {
        return Err("only pop-out windows may focus themselves".to_string());
    }
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())
}

/// Navigate to the saved server. Tauri 1 has no Rust-side `navigate`, so we drive
/// the webview via JS (`location.replace`), which loads the remote hosted UI.
#[tauri::command]
fn open_app(window: tauri::Window) -> Result<(), String> {
    if !is_local_window(&window) {
        return Err("unavailable from a loaded server".to_string());
    }
    let url = load_settings().server_url;
    grant_remote_ipc(&window, &url);
    let js = format!(
        "window.location.replace({})",
        serde_json::to_string(&url).map_err(|e| e.to_string())?
    );
    window.eval(&js).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            mara_log,
            get_settings,
            set_server_url,
            set_auto_connect,
            open_app,
            open_popout,
            request_attention,
            close_self,
            focus_self
        ])
        .setup(|app| {
            // Open the bundled picker page first; it persists the chosen server and
            // asks open_app to navigate to the live UI. Seed it with saved settings.
            let settings = load_settings();
            // __MARA_UPDATE__ (version + public manifest URL) is non-sensitive and read by
            // the hosted update banner on the *remote* page, so it's set unconditionally.
            // __MARA_SETTINGS__ (recent-servers list, logDir, geometry) and __MARA_LOG__ (an
            // absolute local path — often the OS username) are only read by the local picker,
            // so they're gated to the local page: the init script runs on *every* navigation,
            // and without this guard the loaded server's page could read them (info leak). The
            // picker is served from the app protocol (`tauri://localhost`, or
            // `http://tauri.localhost` with dangerousUseHttpScheme); the remote server page
            // never matches. Mirrors the modern shell.
            let init = format!(
                "window.__MARA_UPDATE__ = {{ current: {current}, manifestUrl: {url} }}; \
                 (function () {{ \
                   var l = window.location; \
                   if (l.protocol !== 'tauri:' && l.hostname !== 'tauri.localhost') return; \
                   window.__MARA_SETTINGS__ = {settings}; \
                   window.__MARA_LOG__ = {log}; \
                 }})();",
                settings = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_string()),
                current = serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap_or_default(),
                url = serde_json::to_string(UPDATE_MANIFEST_URL).unwrap_or_default(),
                log = log_location_json(),
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
