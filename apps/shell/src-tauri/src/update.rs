//! The client's side of an in-app update: fetch this build's manifest, fetch the archive it
//! names, and hand both to `mara-swap`, which does the file work (see that crate for how a
//! running executable replaces itself, and why Tauri's updater plugin can't do this job for
//! a portable install).
//!
//! What gets installed is never the caller's choice. The page asks to update and nothing
//! more: the manifest URL baked into this build at compile time (`MARA_UPDATE_URL`) is
//! re-fetched here, and the download URL and checksum come from *that*, so even a caller
//! that shouldn't be asking can only ever install the operator's own build. On top of that
//! the commands are granted to the local picker in `capabilities/default.json` and left out
//! of `grant_remote_ipc`, so a server you connect to can't reach them at all.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::UPDATE_MANIFEST_URL;

pub use mara_swap::clear_stale_backup;

/// Refuse an absurd download outright rather than filling the disk: the largest client
/// archive is ~15 MB, so this is orders of magnitude of headroom and still bounded.
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

/// Where the executable was installed, remembered across the swap. Afterwards
/// `current_exe()` no longer answers reliably — on Linux it resolves through /proc to the
/// renamed backup — so the relaunch uses the path we actually wrote to.
static INSTALLED_AT: OnceLock<PathBuf> = OnceLock::new();

/// Download progress, emitted to the picker as `update://progress` so the button can show a
/// real figure instead of pretending to be busy. `total` is 0 when the host sends no length.
#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

/// The published update manifest (`latest-<platform>.json`), as written by zip-dist.mjs.
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
/// page, and the host it's published on answers without CORS headers, so the browser threw
/// every response away and the banner never appeared on any shipped client. Rust has no such
/// rule. Fetching it here also means the Android build — which can't self-install, but can
/// certainly tell you an update exists — gets the same banner as the desktop ones.
#[tauri::command]
pub async fn check_update() -> Result<Option<Manifest>, String> {
    if UPDATE_MANIFEST_URL.is_empty() {
        return Ok(None); // updates deliberately off for this build
    }
    fetch_manifest(UPDATE_MANIFEST_URL).await.map(Some)
}

/// Install the build this client's own update manifest points at. Returns the version that
/// was installed, for the picker to name. Nothing is touched on disk until the bytes are in
/// hand and the checksum matches.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<String, String> {
    if UPDATE_MANIFEST_URL.is_empty() {
        return Err("this build has no update manifest — updates are off".to_string());
    }
    let manifest = fetch_manifest(UPDATE_MANIFEST_URL).await?;
    let sha256 = manifest.sha256.clone().unwrap_or_default();
    let parsed =
        tauri::Url::parse(manifest.url.trim()).map_err(|e| format!("invalid update URL: {e}"))?;
    // The archive is verified by checksum, but that checksum arrives over the same channel
    // as the manifest — so insist the transport was authenticated too.
    if parsed.scheme() != "https" {
        return Err("updates must be downloaded over https".to_string());
    }
    let exe = std::env::current_exe().map_err(|e| format!("can't locate this client: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "this client has no install directory".to_string())?
        .to_path_buf();
    // Fail here, before a long download, when the install lives somewhere this user can't
    // write (Program Files, /usr/local) — a manual download is their only route then.
    mara_swap::ensure_writable(&dir)?;

    // Which archive shape to expect, read before the URL is consumed by the download.
    let targz = {
        let path = parsed.path().to_ascii_lowercase();
        path.ends_with(".tar.gz") || path.ends_with(".tgz")
    };
    let bytes = download(&app, parsed).await?;
    mara_swap::verify(&bytes, &sha256)?;
    mara_swap::install(&bytes, targz, &exe)?;

    let _ = INSTALLED_AT.set(exe);
    Ok(manifest.version)
}

/// Relaunch the client — after an update, into the executable that just replaced it. Split
/// from `install_update` so the picker can report success and say what happens next before
/// the window disappears.
#[tauri::command]
pub fn restart_client(app: AppHandle) -> Result<(), String> {
    let exe = match INSTALLED_AT.get() {
        Some(path) => path.clone(),
        None => std::env::current_exe().map_err(|e| format!("can't locate this client: {e}"))?,
    };
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("couldn't start the updated client: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Read the update manifest this build was compiled to trust. Deliberately re-fetched here
/// rather than accepted from the caller — see the module docs.
async fn fetch_manifest(url: &str) -> Result<Manifest, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("invalid manifest URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("the update manifest must be served over https".to_string());
    }
    let response = reqwest::get(parsed)
        .await
        .map_err(|e| format!("couldn't reach the update manifest ({e})"))?;
    if !response.status().is_success() {
        return Err(format!("the update manifest returned {}", response.status()));
    }
    response
        .json::<Manifest>()
        .await
        .map_err(|e| format!("the update manifest didn't parse ({e})"))
}

/// Stream the archive into memory, emitting progress as it goes. Held in memory rather than
/// spooled to disk: these are megabytes, and nothing should touch the install directory
/// until the checksum has cleared.
async fn download(app: &AppHandle, url: tauri::Url) -> Result<Vec<u8>, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("couldn't reach the download ({e})"))?;
    if !response.status().is_success() {
        return Err(format!("the download returned {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_ARCHIVE_BYTES {
        return Err(format!("that download is implausibly large ({total} bytes)"));
    }
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("the download stopped early ({e})"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err("that download is implausibly large".to_string());
        }
        let _ = app.emit(
            "update://progress",
            Progress {
                received: bytes.len() as u64,
                total,
            },
        );
    }
    Ok(bytes)
}
