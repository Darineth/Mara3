use std::fs::create_dir_all;
use std::io::Write;
use std::path::PathBuf;

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

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

/// Log line terminator. Windows text viewers (e.g. Notepad) need CRLF — a lone LF shows
/// the whole file as one line — so use the platform-native ending. Rust file writes are
/// byte-exact (no text-mode translation), hence the explicit choice.
#[cfg(windows)]
const LINE_END: &str = "\r\n";
#[cfg(not(windows))]
const LINE_END: &str = "\n";

/// Cap on a single logged line (bytes of `line`); longer lines are truncated with a
/// marker. Real chat lines are far under this — the server bounds message input to 8 KB
/// and a log line is `<name> text` — so this only stops a malicious server (whose page
/// drives `mara_log` over IPC) from writing a giant string per call.
const MAX_LOG_LINE: usize = 8 * 1024;

/// Per-file size ceiling. Once a month's log reaches this, further lines are dropped
/// (silent no-op) instead of appended, bounding the disk one channel can consume under a
/// hostile server. Years of real logs top out ~5 MB/file, so 32 MB never trips normally.
const MAX_LOG_FILE: u64 = 32 * 1024 * 1024;

/// Cap on the channel label (characters) before it becomes a folder name — bounds an
/// otherwise attacker-controlled path segment (`sanitize_segment` can up to 4× its length
/// when percent-encoding). Real channel names are short.
const MAX_LOG_CHANNEL: usize = 128;

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
    /// Where logs are written. Absent/`null` → `logs/` relative to the current working
    /// directory (where the client is launched from). A relative path resolves against
    /// the working directory; an absolute path is used as-is. An explicit blank string
    /// (`""`) disables disk logging entirely. See `log_dir()`.
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

/// The bundled bootstrap (picker) page URL, captured at startup so "Switch server"
/// can navigate the window back to it from any loaded server.
struct BootstrapUrl(String);

/// Directory of the running executable — the portable storage root for `settings.json`
/// and, by default, the `logs/` folder.
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "cannot resolve executable directory".to_string())
}

/// Path to `settings.json` beside the running executable (portable storage).
fn settings_path() -> Result<PathBuf, String> {
    Ok(exe_dir()?.join("settings.json"))
}

/// Resolve the directory the local log file lives in, or `None` when disk logging is
/// switched off. Defaults to `logs/` relative to the **current working directory** (the
/// directory the client is launched from) — a plain relative `PathBuf`, so the OS
/// resolves it per-platform (cross-platform, no hardcoded separators). The `logDir`
/// setting overrides it: an absolute path is used as-is, a relative one (like the
/// default) resolves against the working directory. **Only an explicit blank string
/// (`""`) disables logging** — a missing or `null` `logDir` keeps the default.
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
/// where files actually land. Purely informational — nothing is created here.
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
/// Desktop-only: mobile has a single OS-managed window with no geometry to persist.
#[cfg(desktop)]
fn save_window_state(window: &WindowState) {
    let mut s = load_settings();
    s.window = window.clone();
    let _ = save_settings(&s);
}

/// True if the window has any visible overlap with a connected monitor. Guards against
/// restoring onto a display that's since been unplugged or rearranged (which would
/// strand the window off-screen). Unknown geometry/monitors → assume on-screen.
#[cfg(desktop)]
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
#[cfg(desktop)]
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

/// Reduce a channel name to one safe, **collision-free** path segment for its log
/// sub-folder. Anything unsafe in a filename is percent-encoded (uppercase hex of its
/// UTF-8 bytes), so distinct names stay distinct — e.g. `./test/` → `%2E%2Ftest%2F` and
/// `../test/` → `%2E.%2Ftest%2F` no longer collapse onto the same folder. We encode the
/// Windows-illegal set, control chars and `%` itself; a leading dot (so the segment can
/// never be `.`/`..` or a hidden file); a trailing dot (Windows silently strips those);
/// and the first char of a Windows reserved device name (CON/PRN/AUX/NUL, COM1-9,
/// LPT1-9). Outer whitespace is trimmed (insignificant). Empty → `unknown`.
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

/// Native capability exposed to the hosted web UI: append a line to the local log,
/// split per `channel` into its own sub-folder and per-month file
/// (`<logDir>/<channel>/Mara3_YYYY-MM.log`). `logDir` defaults to `logs/` beside the
/// exe; a blank `logDir` disables logging, so this becomes a silent no-op.
#[tauri::command]
fn mara_log(channel: String, line: String) -> Result<(), String> {
    let Some(root) = log_dir() else {
        return Ok(());
    };
    // Clamp the (attacker-controllable) channel label before it becomes a folder name.
    let channel: String = channel.chars().take(MAX_LOG_CHANNEL).collect();
    let dir = root.join(sanitize_segment(&channel));
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = Local::now();
    let file_name = format!("Mara3_{}.log", now.format("%Y-%m"));
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
    write!(
        file,
        "[{channel} {}] {line}{LINE_END}",
        now.format("%Y-%m-%d %H:%M:%S")
    )
    .map_err(|e| e.to_string())?;
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

/// Grant the just-chosen server's origin IPC access at runtime, so the loaded remote
/// page can reach the native commands (logging, opener, updater) — without hardcoding
/// any hostname. We trust only the exact origin the user connected to (not a wildcard).
/// Failures are swallowed: a re-opened origin is a duplicate (already granted), and
/// logging must never block opening the server.
fn grant_remote_ipc(app: &AppHandle, url: &tauri::Url) {
    let origin = url.origin().ascii_serialization();
    if origin == "null" {
        return;
    }
    // Capability identifiers must be a clean slug — keep alphanumerics, collapse every
    // other run (`://`, `:`, `.`) to a single dash so the id is always valid and stable.
    let mut id = String::from("remote-");
    let mut prev_dash = false;
    for c in origin.chars() {
        if c.is_ascii_alphanumeric() {
            id.push(c);
            prev_dash = false;
        } else if !prev_dash {
            id.push('-');
            prev_dash = true;
        }
    }
    // Minimal set the loaded server page actually needs. Deliberately NOT granted:
    // `opener:default` (replaced by the scheme-checked `open_external` command below) and
    // `updater:default` (the update flow is a plain manifest fetch + external link — the
    // updater plugin is never invoked from the page, so it stays unreachable to servers).
    let cap = CapabilityBuilder::new(id)
        .remote(origin)
        .local(false)
        // Pop-out windows load the same remote page and need the same IPC (their
        // labels all match `popout-*`; see `open_popout`).
        .window("main")
        .window("popout-*")
        .permission("core:default")
        // App commands the loaded page calls — these need their autogenerated
        // `allow-<command>` permissions (see build.rs AppManifest) to clear the ACL.
        .permission("allow-mara-log")
        .permission("allow-switch-server")
        .permission("allow-open-external")
        .permission("allow-request-attention")
        .permission("allow-open-popout")
        .permission("allow-close-self")
        .permission("allow-focus-self");
    let _ = app.add_capability(cap);
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
    grant_remote_ipc(&app, &url);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    window.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}

/// Open an external link in the system browser on behalf of the loaded (remote) page —
/// e.g. the update-download link. Validates the scheme in Rust and only ever opens
/// `http`/`https`. This is deliberately a narrow command instead of granting the opener
/// plugin to the server's origin: the server page can open web links but can never reach
/// the opener's file-path or `with`-program forms.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http/https URLs may be opened".to_string());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
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

/// Flash the taskbar button (Windows) / bounce the dock (macOS) / set the urgency hint
/// (Linux) to alert the user to a private message that arrived while the window was in the
/// background. `Critical` keeps the taskbar flashing until the window regains focus (the OS
/// clears it automatically), which is the standard "you have a message" behaviour. Called
/// from the hosted chat page only when it's already determined the window is unfocused; we
/// additionally guard on `is_focused()` here so a call while the window is in front is a
/// no-op (never flash the window the user is looking at). Flashes the *calling* window,
/// so a PM pop-out flashes its own taskbar entry rather than the main window's.
/// Desktop-only (no taskbar/dock urgency on mobile — the web app tolerates its absence).
#[cfg(desktop)]
#[tauri::command]
fn request_attention(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_focused().unwrap_or(false) {
        return Ok(());
    }
    window
        .request_user_attention(Some(tauri::UserAttentionType::Critical))
        .map_err(|e| e.to_string())
}

/// Stable window label for a pop-out view. Labels only allow a limited charset, so the
/// view is slugged; a hash rides along so distinct views that slug identically (e.g.
/// `channel:a b` vs `channel:a-b`) still get their own windows. Deterministic within a
/// process, which is all reuse-by-label needs.
#[cfg(desktop)]
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
/// server address, so a hostile page can never point a native window at another origin.
// Async, not sync: window creation from a synchronous command deadlocks on
// Windows (wry#583) — async commands run off the event loop thread.
// Desktop-only: mobile has a single window; the web app falls back to tabs.
#[cfg(desktop)]
#[tauri::command]
async fn open_popout(app: AppHandle, view: String) -> Result<(), String> {
    let valid_channel = view
        .strip_prefix("channel:")
        .is_some_and(|name| !name.is_empty());
    let valid_pm = view
        .strip_prefix("pm:")
        .is_some_and(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()));
    if !valid_channel && !valid_pm {
        return Err("invalid view".to_string());
    }
    let mut url: tauri::Url = load_settings()
        .server_url
        .parse()
        .map_err(|e| format!("invalid server URL: {e}"))?;
    url.query_pairs_mut().clear().append_pair("view", &view);
    // One window per conversation: an existing window for this view is refocused
    // instead of duplicated (mirrors the browser's named-target behaviour).
    let label = popout_label(&view);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    // Idempotent: ensures the origin's capability (which covers `popout-*`) exists even
    // if this shell session somehow skipped open_app.
    grant_remote_ipc(&app, &url);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title("Mara 3")
        .inner_size(560.0, 680.0)
        .min_inner_size(360.0, 320.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the calling pop-out window (JS `window.close()` is a no-op in a webview).
/// Restricted to pop-outs: the loaded page must never be able to close the main window.
#[cfg(desktop)]
#[tauri::command]
fn close_self(window: tauri::WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("popout-") {
        return Err("only pop-out windows may close themselves".to_string());
    }
    window.close().map_err(|e| e.to_string())
}

/// Raise the calling pop-out window (the cross-window "focus this conversation" nudge).
#[cfg(desktop)]
#[tauri::command]
fn focus_self(window: tauri::WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("popout-") {
        return Err("only pop-out windows may focus themselves".to_string());
    }
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())
}

/// True when Windows relaunched us after a Restart Manager reboot — i.e. we were running
/// when an OS update rebooted the machine, and Windows started us again with the
/// `--resumed` argument we registered (see `register_for_restart`). The picker reads this
/// (via `window.__MARA_RESUME__`) to auto-connect to the last server even when
/// auto-connect is off, restoring the session the reboot interrupted. Harmless on other
/// platforms and in normal launches: the flag is simply absent.
fn resumed_after_restart() -> bool {
    std::env::args().any(|a| a == "--resumed")
}

/// Windows only: ask the OS to relaunch this client after a Restart Manager reboot (the
/// mechanism Windows Update uses). Windows records the current exe path plus the
/// `--resumed` argument now, and if the machine is rebooted for an update while we're
/// running, starts us again after the user logs back in. We deliberately exclude
/// crash/hang restarts (`RESTART_NO_CRASH | RESTART_NO_HANG`) so this only ever fires for
/// a reboot/patch — never to revive a client that crashed. Best-effort: a registration
/// failure is swallowed (the client still runs normally, it just won't auto-resume).
///
/// Note: Windows only relaunches apps that were running for at least ~60 s and only for
/// Restart-Manager-initiated reboots — not a hard power-off. The portable single-exe
/// model fits well: the path is captured at call time and nothing persists in the
/// registry.
#[cfg(windows)]
fn register_for_restart() {
    use windows::core::PCWSTR;
    use windows::Win32::System::Recovery::{
        RegisterApplicationRestart, RESTART_NO_CRASH, RESTART_NO_HANG,
    };
    // Null-terminated UTF-16 argument string. Do NOT include the exe name — Windows
    // prepends it automatically from the running process's image path.
    let args: Vec<u16> = "--resumed\0".encode_utf16().collect();
    // SAFETY: `args` outlives this synchronous call and is a valid, NUL-terminated UTF-16
    // buffer for its whole duration.
    unsafe {
        let _ =
            RegisterApplicationRestart(PCWSTR(args.as_ptr()), RESTART_NO_CRASH | RESTART_NO_HANG);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // Pop-outs, taskbar attention, and window management are desktop-only, so the mobile
    // build registers only the cross-platform commands — the web app tolerates the rest
    // being absent (pop-outs fall back to tabs, attention just doesn't fire).
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        mara_log,
        get_settings,
        set_server_url,
        set_auto_connect,
        open_app,
        switch_server,
        open_external,
        request_attention,
        open_popout,
        close_self,
        focus_self
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        mara_log,
        get_settings,
        set_server_url,
        set_auto_connect,
        open_app,
        switch_server,
        open_external
    ]);

    // Signed auto-update is desktop-only; mobile updates ship through app stores.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // Ask Windows to relaunch us after a Restart Manager reboot (Windows Update),
            // so a client that was open when the machine rebooted comes back and, via the
            // `--resumed` flag, reconnects to the last server. No-op on other platforms.
            #[cfg(windows)]
            register_for_restart();

            // Load the local bootstrap page first; it shows the server picker, polls
            // the chosen server, and asks us to navigate to the live UI once it is
            // reachable. Seed the picker with the saved settings.
            let settings = load_settings();
            // __MARA_UPDATE__ (this build's version + the public manifest URL) is read by
            // the hosted web UI's update banner on the *remote* page and is non-sensitive,
            // so it's set unconditionally. __MARA_SETTINGS__ (recent-servers list, logDir,
            // window geometry) and __MARA_LOG__ (an absolute local path — often the OS
            // username) are read only by the local picker, so they're gated to the local
            // page: an initialization script runs on *every* navigation, and without this
            // guard the loaded server's page could read them (info leak). The picker is
            // served from the app protocol (`tauri://localhost`, or `http://tauri.localhost`
            // on Windows); the remote server page never matches, so it gets only
            // __MARA_UPDATE__. The picker does the fetch/compare/banner in JS — see
            // bootstrap/index.html.
            let init = format!(
                "window.__MARA_UPDATE__ = {{ current: {current}, manifestUrl: {url} }}; \
                 (function () {{ \
                   var l = window.location; \
                   if (l.protocol !== 'tauri:' && l.hostname !== 'tauri.localhost') return; \
                   window.__MARA_SETTINGS__ = {settings}; \
                   window.__MARA_LOG__ = {log}; \
                   window.__MARA_RESUME__ = {resume}; \
                 }})();",
                settings = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_string()),
                current = serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap_or_default(),
                url = serde_json::to_string(UPDATE_MANIFEST_URL).unwrap_or_default(),
                log = log_location_json(),
                resume = resumed_after_restart(),
            );
            // The main window loads the bundled picker page. On desktop we start it
            // hidden, restore saved geometry, then show it, and track geometry to persist
            // on close. Mobile has a single OS-managed fullscreen window — none of the
            // sizing/geometry applies — so it just builds the window and loads the page.
            #[cfg(desktop)]
            {
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
            }
            #[cfg(mobile)]
            {
                let window =
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                        .initialization_script(&init)
                        .build()?;
                let boot = window.url().map(|u| u.to_string()).unwrap_or_default();
                app.manage(BootstrapUrl(boot));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mara 3");
}

#[cfg(test)]
mod tests {
    use super::sanitize_segment;

    #[test]
    fn distinct_names_stay_distinct() {
        // The core bug: these used to both collapse to `_test_`.
        assert_ne!(sanitize_segment("./test/"), sanitize_segment("../test/"));
        // Different separators no longer merge, and a trailing dot stays distinct.
        assert_ne!(sanitize_segment("a/b"), sanitize_segment("a\\b"));
        assert_ne!(sanitize_segment("test."), sanitize_segment("test"));
    }

    #[test]
    fn never_a_separator_or_traversal() {
        for s in ["..", ".", "../../etc", "a/b\\c", "...", " . "] {
            let seg = sanitize_segment(s);
            assert!(
                !seg.contains('/') && !seg.contains('\\'),
                "{s:?} -> {seg:?}"
            );
            assert_ne!(seg, ".");
            assert_ne!(seg, "..");
        }
    }

    #[test]
    fn plain_names_pass_through() {
        assert_eq!(sanitize_segment("Main"), "Main");
        assert_eq!(sanitize_segment("off-topic"), "off-topic");
        assert_eq!(sanitize_segment("  spaced  "), "spaced"); // outer whitespace trimmed
    }

    #[test]
    fn windows_reserved_names_neutralized() {
        assert_ne!(sanitize_segment("CON").to_ascii_uppercase(), "CON");
        assert_ne!(sanitize_segment("nul"), "nul");
        assert_ne!(sanitize_segment("COM1"), "COM1");
        // Not actually reserved — left intact.
        assert_eq!(sanitize_segment("COM0"), "COM0");
        assert_eq!(sanitize_segment("CONSOLE"), "CONSOLE");
    }

    #[test]
    fn empty_or_blank_is_unknown() {
        assert_eq!(sanitize_segment(""), "unknown");
        assert_eq!(sanitize_segment("   "), "unknown");
    }
}
