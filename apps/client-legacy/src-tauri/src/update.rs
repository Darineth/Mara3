//! This client's side of an in-app update: fetch the manifest baked into the build, fetch
//! the archive it names, and hand both to `mara-swap`, which does the file work. The modern
//! shell has the same pair of commands (apps/shell/src-tauri/src/update.rs); everything that
//! could corrupt an install lives in the shared crate so the two can't drift apart.
//!
//! Two differences from the modern shell, both forced by Tauri 1:
//!
//! * There's no per-command ACL, so the picker-only guard is a runtime origin check
//!   (`is_local_window`), the same one the settings commands use.
//! * Commands run on the async runtime, so the blocking download and the file work go to a
//!   worker thread rather than stalling the UI.
//!
//! What gets installed is never the caller's choice: the manifest URL is compiled in, and
//! the download URL and checksum come from that manifest, so the page can ask for an update
//! but can't say what it is.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::{is_local_window, UPDATE_MANIFEST_URL};

pub use mara_swap::clear_stale_backup;

/// Refuse an absurd download rather than filling the disk: this client's archive is ~2 MB.
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

/// Where the executable was installed, remembered across the swap, so the relaunch starts
/// the file we wrote rather than whatever `current_exe()` resolves to afterwards.
static INSTALLED_AT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// Download progress for the picker's button (`update://progress`). `total` is 0 when the
/// host sends no content length.
#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

/// The published manifest (`latest-windows7-x64.json`), as written by zip-dist.mjs.
#[derive(Clone, Deserialize, Serialize)]
pub struct Manifest {
    version: String,
    url: String,
    #[serde(default)]
    notes: Option<String>,
    sha256: Option<String>,
}

/// Read this build's update manifest and hand it to the picker.
///
/// The picker used to fetch this itself, and couldn't: the manifest is cross-origin to the
/// page, and the host it was published on answers without CORS headers, so the browser threw
/// every response away and the banner never appeared. Rust has no such rule.
#[tauri::command]
pub async fn check_update(window: tauri::Window) -> Result<Option<Manifest>, String> {
    if !is_local_window(&window) {
        return Err("unavailable from a loaded server".to_string());
    }
    if UPDATE_MANIFEST_URL.is_empty() {
        return Ok(None); // updates deliberately off for this build
    }
    tauri::async_runtime::spawn_blocking(|| fetch_manifest(UPDATE_MANIFEST_URL).map(Some))
        .await
        .map_err(|e| format!("the update check failed: {e}"))?
}

/// Install the build this client's manifest points at, returning the version installed.
/// Nothing is touched on disk until the bytes are in hand and the checksum matches.
#[tauri::command]
pub async fn install_update(window: tauri::Window) -> Result<String, String> {
    if !is_local_window(&window) {
        return Err("unavailable from a loaded server".to_string());
    }
    if UPDATE_MANIFEST_URL.is_empty() {
        return Err("this build has no update manifest — updates are off".to_string());
    }
    // Blocking HTTP and file work on a worker: a sync Tauri 1 command would hold the UI
    // thread for the whole download.
    tauri::async_runtime::spawn_blocking(move || install_blocking(&window))
        .await
        .map_err(|e| format!("the update task failed: {e}"))?
}

/// Relaunch into the executable that just replaced this one. Separate from `install_update`
/// so the picker can report success before the window goes.
#[tauri::command]
pub fn restart_client(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    if !is_local_window(&window) {
        return Err("unavailable from a loaded server".to_string());
    }
    let remembered = INSTALLED_AT
        .get()
        .and_then(|cell| cell.lock().ok().and_then(|guard| guard.clone()));
    let exe = match remembered {
        Some(path) => path,
        None => std::env::current_exe().map_err(|e| format!("can't locate this client: {e}"))?,
    };
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("couldn't start the updated client: {e}"))?;
    app.exit(0);
    Ok(())
}

/// The whole job, off the UI thread: manifest, download, verify, swap.
fn install_blocking(window: &tauri::Window) -> Result<String, String> {
    let manifest = fetch_manifest(UPDATE_MANIFEST_URL)?;
    let sha256 = manifest.sha256.clone().unwrap_or_default();
    let url = reqwest::Url::parse(manifest.url.trim())
        .map_err(|e| format!("invalid update URL: {e}"))?;
    // The archive is verified by checksum, but that checksum arrives over the same channel
    // as the manifest — so insist the transport was authenticated too.
    if url.scheme() != "https" {
        return Err("updates must be downloaded over https".to_string());
    }
    let exe = std::env::current_exe().map_err(|e| format!("can't locate this client: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "this client has no install directory".to_string())?
        .to_path_buf();
    mara_swap::ensure_writable(&dir)?;

    let bytes = download(window, url)?;
    mara_swap::verify(&bytes, &sha256)?;
    // Windows only — this client ships as a .zip, never a tarball.
    mara_swap::install(&bytes, false, &exe)?;

    if let Ok(mut slot) = INSTALLED_AT.get_or_init(|| Mutex::new(None)).lock() {
        *slot = Some(exe);
    }
    Ok(manifest.version)
}

/// Read the manifest this build was compiled to trust — never one the caller names.
fn fetch_manifest(url: &str) -> Result<Manifest, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid manifest URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("the update manifest must be served over https".to_string());
    }
    let response = client()?
        .get(parsed)
        .send()
        .map_err(|e| format!("couldn't reach the update manifest ({e})"))?;
    if !response.status().is_success() {
        return Err(format!("the update manifest returned {}", response.status()));
    }
    response
        .json::<Manifest>()
        .map_err(|e| format!("the update manifest didn't parse ({e})"))
}

/// Read the archive, emitting progress as it lands.
fn download(window: &tauri::Window, url: reqwest::Url) -> Result<Vec<u8>, String> {
    let mut response = client()?
        .get(url)
        .send()
        .map_err(|e| format!("couldn't reach the download ({e})"))?;
    if !response.status().is_success() {
        return Err(format!("the download returned {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_ARCHIVE_BYTES {
        return Err(format!("that download is implausibly large ({total} bytes)"));
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut response, &mut buf)
            .map_err(|e| format!("the download stopped early ({e})"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..read]);
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err("that download is implausibly large".to_string());
        }
        let _ = window.emit(
            "update://progress",
            Progress {
                received: bytes.len() as u64,
                total,
            },
        );
    }
    Ok(bytes)
}

/// A blocking HTTPS client that brings its own TLS and its own roots. Windows 7's schannel
/// only speaks TLS 1.2 where the machine has been updated and the registry says so, and
/// GitHub won't talk to anything older — so rustls with bundled roots is what makes the
/// download work on the very machines this client exists for.
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("couldn't start the downloader: {e}"))
}
