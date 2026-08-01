//! In-place update of a portable Mara client: check an archive, then swap the running
//! executable for the one inside it.
//!
//! Mara's desktop clients ship as a folder you unzip anywhere — `Mara3.exe` sitting beside
//! its own `settings.json` — which is why Tauri's updater plugin is no help: it installs app
//! *bundles* (NSIS/MSI/AppImage), not a loose executable, and adopting it would mean giving
//! up the portable model. Doing it by hand turns out to be small, because the payload is a
//! single file.
//!
//! The swap is a rename dance rather than an overwrite: a running executable can't be
//! written to on either platform, but it *can* be renamed out from under itself (Windows
//! holds the image by handle, Linux by inode). So the outgoing binary steps aside as
//! `<name>.old`, the new one takes the path it vacated, and the next launch sweeps up — see
//! [`clear_stale_backup`].
//!
//! This crate is deliberately free of Tauri and of HTTP: it takes bytes and a checksum and
//! does files. Both clients — the Tauri 2 shell and the Tauri 1 Windows 7 build — share it,
//! so the half that can corrupt an install can't drift between them. Each keeps its own thin
//! command wrapper for fetching and progress.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Where the archive is unpacked before anything is moved into place. Kept *inside* the
/// install dir so every move that follows is a same-volume rename, which can't half-copy a
/// 15 MB executable, and named to look like the working file it is.
const STAGING_DIR: &str = ".mara-update";

/// What the outgoing executable is renamed to while the new one takes its place.
const BACKUP_EXT: &str = "old";

/// Archive entries under this directory are never written. The Win7 client ships the folder
/// with a README explaining how to obtain WebView2 (it can't be redistributed) and the user
/// puts the real runtime there — an update must not paint over what they installed.
const PRESERVED_DIR: &str = "webview2-runtime";

/// `<dir>/Mara3.exe` → `<dir>/Mara3.exe.old`. Appended, not substituted, so the backup of a
/// file with no extension (the Linux binary) stays distinct from the binary itself.
pub fn backup_path(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{BACKUP_EXT}"));
    exe.with_file_name(name)
}

/// Delete the executable a previous update stepped aside. Call once at startup: by then the
/// process that was running it — this one's predecessor — has exited, so Windows will let it
/// go. Best-effort; a locked or absent file just waits for the next launch.
pub fn clear_stale_backup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = fs::remove_file(backup_path(&exe));
    }
}

/// Prove the install directory is writable by this user, so an update that can't possibly
/// finish says so in the first second instead of after a long download. Portable installs
/// usually pass; one unzipped into Program Files or /usr/local won't.
pub fn ensure_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(".mara-update-probe");
    fs::write(&probe, b"").map_err(|e| {
        format!(
            "this copy can't update itself — {} isn't writable ({e}). \
             Move Mara somewhere you own, or download the update by hand.",
            dir.display()
        )
    })?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// Check the archive against the SHA-256 its manifest published. This is the whole trust
/// story for the payload, so a mismatch is fatal and says so plainly.
pub fn verify(bytes: &[u8], expected: &str) -> Result<(), String> {
    let want = expected.trim().to_ascii_lowercase();
    if want.len() != 64 || !want.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the update manifest carries no usable checksum".to_string());
    }
    let got = format!("{:x}", Sha256::digest(bytes));
    if got != want {
        return Err(format!(
            "the download doesn't match its checksum (expected {want}, got {got}) — \
             it may be corrupt or tampered with; nothing was installed"
        ));
    }
    Ok(())
}

/// Unpack `bytes` and put the build it contains in place of `exe`, leaving the previous
/// executable beside it as `<name>.old`. `targz` selects the archive shape: `.tar.gz` for
/// Linux, `.zip` otherwise.
///
/// Nothing under the install directory is touched until the whole archive has unpacked
/// cleanly into staging and the executable has been found in it, so a truncated or
/// wrong-platform download can't leave a client that won't start.
pub fn install(bytes: &[u8], targz: bool, exe: &Path) -> Result<(), String> {
    let dir = exe
        .parent()
        .ok_or_else(|| "this client has no install directory".to_string())?;
    let staging = dir.join(STAGING_DIR);
    let _ = fs::remove_dir_all(&staging);
    let result = unpack(bytes, targz, &staging).and_then(|()| swap_into_place(&staging, exe));
    let _ = fs::remove_dir_all(&staging);
    result
}

/// Reject anything that would escape the directory it's unpacked into: absolute paths, drive
/// letters, `..` segments. Archive entries are attacker-controlled the moment a download host
/// is, and this is the classic way out of one.
fn safe_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Whether this entry lives in the runtime folder the user owns (see [`PRESERVED_DIR`]).
fn is_preserved(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::Normal(p) if p.eq_ignore_ascii_case(PRESERVED_DIR)))
}

/// Unpack every usable entry into `staging`.
fn unpack(bytes: &[u8], targz: bool, staging: &Path) -> Result<(), String> {
    fs::create_dir_all(staging).map_err(|e| format!("couldn't prepare the staging dir: {e}"))?;
    if targz {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));
        let entries = archive
            .entries()
            .map_err(|e| format!("couldn't read the archive: {e}"))?;
        for entry in entries {
            let mut entry = entry.map_err(|e| format!("couldn't read the archive: {e}"))?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry
                .path()
                .map_err(|e| format!("couldn't read the archive: {e}"))?
                .into_owned();
            let Some(rel) = safe_relative(&path) else {
                continue;
            };
            if is_preserved(&rel) {
                continue;
            }
            let mode = entry.header().mode().ok();
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("couldn't read the archive: {e}"))?;
            write_staged(staging, &rel, &buf, mode)?;
        }
    } else {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| format!("couldn't read the archive: {e}"))?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("couldn't read the archive: {e}"))?;
            if entry.is_dir() {
                continue;
            }
            // `enclosed_name` already refuses escaping paths; run ours over it too, so both
            // archive shapes are judged by exactly one rule.
            let Some(rel) = entry.enclosed_name().as_deref().and_then(safe_relative) else {
                continue;
            };
            if is_preserved(&rel) {
                continue;
            }
            let mode = entry.unix_mode();
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("couldn't read the archive: {e}"))?;
            write_staged(staging, &rel, &buf, mode)?;
        }
    }
    Ok(())
}

/// Write one unpacked entry under `staging`, carrying its mode across on unix so the
/// executable bit survives the round trip.
fn write_staged(staging: &Path, rel: &Path, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    let target = staging.join(rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("couldn't stage {}: {e}", rel.display()))?;
    }
    fs::write(&target, bytes).map_err(|e| format!("couldn't stage {}: {e}", rel.display()))?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

/// Move the staged build over the installed one: the executable first — the step that can
/// fail, and the one worth rolling back — then everything else beside it.
fn swap_into_place(staging: &Path, exe: &Path) -> Result<(), String> {
    let name = exe
        .file_name()
        .ok_or_else(|| "this client has no file name".to_string())?;
    let staged_exe = staging.join(name);
    if !staged_exe.is_file() {
        return Err(format!(
            "that archive doesn't contain {} — it may be for a different platform",
            name.to_string_lossy()
        ));
    }

    let backup = backup_path(exe);
    let _ = fs::remove_file(&backup);
    fs::rename(exe, &backup)
        .map_err(|e| format!("couldn't move the running client aside ({e}) — nothing was changed"))?;
    if let Err(e) = fs::rename(&staged_exe, exe) {
        // Put the old one back rather than leave the install with no executable at all.
        let _ = fs::rename(&backup, exe);
        return Err(format!(
            "couldn't install the new client ({e}) — the old one is intact"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(exe, fs::Permissions::from_mode(0o755));
    }

    // The rest (BUILD-INFO, launcher script, README) is cosmetic: failing here still leaves a
    // working, updated client, so it must not fail the update.
    let install = exe.parent().unwrap_or(staging);
    move_remaining(staging, staging, install);
    Ok(())
}

/// Recursively move what's left of the staging tree into the install dir, overwriting.
/// Best-effort by design — see the caller.
fn move_remaining(root: &Path, dir: &Path, install: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let Ok(rel) = from.strip_prefix(root) else {
            continue;
        };
        let to = install.join(rel);
        if from.is_dir() {
            let _ = fs::create_dir_all(&to);
            move_remaining(root, &from, install);
        } else {
            if let Some(parent) = to.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::remove_file(&to);
            let _ = fs::rename(&from, &to);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch install directory of its own, so the tests can run side by side.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mara-update-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A zip holding a new build, the file beside it, and a placeholder for the runtime dir.
    fn archive() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut w = zip::ZipWriter::new(Cursor::new(&mut bytes));
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        for (name, body) in [
            ("Mara3.exe", "new build"),
            ("BUILD-INFO.txt", "3.0.34"),
            ("webview2-runtime/README.txt", "placeholder"),
        ] {
            w.start_file(name, opts).unwrap();
            std::io::Write::write_all(&mut w, body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        bytes
    }

    #[test]
    fn checksum_must_match() {
        let bytes = b"mara";
        let good = format!("{:x}", Sha256::digest(bytes));
        assert!(verify(bytes, &good).is_ok());
        assert!(verify(bytes, &good.to_uppercase()).is_ok()); // hex case is not meaningful
        assert!(verify(b"other", &good).is_err());
        assert!(verify(bytes, "not-a-hash").is_err());
        assert!(verify(bytes, "").is_err());
    }

    #[test]
    fn archive_paths_cannot_escape() {
        assert_eq!(safe_relative(Path::new("Mara3.exe")), Some("Mara3.exe".into()));
        assert_eq!(
            safe_relative(Path::new("sub/dir/file.txt")),
            Some(PathBuf::from("sub").join("dir").join("file.txt"))
        );
        assert_eq!(safe_relative(Path::new("../outside")), None);
        assert_eq!(safe_relative(Path::new("a/../../outside")), None);
        assert_eq!(safe_relative(Path::new("/etc/passwd")), None);
        assert_eq!(safe_relative(Path::new("")), None);
    }

    #[test]
    fn backup_sits_beside_the_executable() {
        assert_eq!(
            backup_path(Path::new("/opt/mara/Mara3.exe")),
            PathBuf::from("/opt/mara/Mara3.exe.old")
        );
        // Nothing to substitute (the Linux binary has no extension) — the suffix is appended,
        // so a backup can never collide with the binary it backs up.
        assert_eq!(
            backup_path(Path::new("/opt/mara/Mara3")),
            PathBuf::from("/opt/mara/Mara3.old")
        );
    }

    /// The whole job on a fake install: the new build lands, the old one steps aside, and
    /// the files that belong to the user are still theirs.
    #[test]
    fn install_replaces_the_executable_and_keeps_user_files() {
        let install = scratch("install");
        fs::create_dir_all(install.join(PRESERVED_DIR)).unwrap();
        let exe = install.join("Mara3.exe");
        fs::write(&exe, b"old build").unwrap();
        fs::write(install.join("settings.json"), b"{\"serverUrl\":\"keep me\"}").unwrap();
        fs::write(install.join(PRESERVED_DIR).join("runtime.dll"), b"user's").unwrap();

        install_archive(&archive(), &exe).unwrap();

        assert_eq!(fs::read(&exe).unwrap(), b"new build");
        assert_eq!(fs::read(backup_path(&exe)).unwrap(), b"old build");
        assert_eq!(fs::read(install.join("BUILD-INFO.txt")).unwrap(), b"3.0.34");
        // Untouched: the settings beside the exe, and the runtime the user installed.
        assert_eq!(
            fs::read(install.join("settings.json")).unwrap(),
            b"{\"serverUrl\":\"keep me\"}"
        );
        assert_eq!(
            fs::read(install.join(PRESERVED_DIR).join("runtime.dll")).unwrap(),
            b"user's"
        );
        assert!(!install.join(PRESERVED_DIR).join("README.txt").exists());
        // Staging cleans up after itself.
        assert!(!install.join(STAGING_DIR).exists());
        let _ = fs::remove_dir_all(&install);
    }

    /// Same call the command makes, so the test covers unpack + swap together.
    fn install_archive(bytes: &[u8], exe: &Path) -> Result<(), String> {
        install(bytes, false, exe)
    }

    /// An archive built for another platform must be refused *before* anything moves.
    #[test]
    fn a_wrong_platform_archive_leaves_the_install_alone() {
        let install_dir = scratch("wrong");
        let exe = install_dir.join("Mara3.exe");
        fs::write(&exe, b"old build").unwrap();

        let mut bytes = Vec::new();
        let mut w = zip::ZipWriter::new(Cursor::new(&mut bytes));
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        w.start_file("Mara3", opts).unwrap(); // the Linux binary
        std::io::Write::write_all(&mut w, b"linux build").unwrap();
        w.finish().unwrap();

        assert!(install(&bytes, false, &exe).is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"old build");
        assert!(!backup_path(&exe).exists());
        assert!(!install_dir.join(STAGING_DIR).exists());
        let _ = fs::remove_dir_all(&install_dir);
    }

    /// Corrupt bytes must never reach the install directory.
    #[test]
    fn a_corrupt_archive_is_refused() {
        let install_dir = scratch("corrupt");
        let exe = install_dir.join("Mara3.exe");
        fs::write(&exe, b"old build").unwrap();

        assert!(install(b"this is not a zip", false, &exe).is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"old build");
        let _ = fs::remove_dir_all(&install_dir);
    }

    /// The Linux shape, including the executable bit the tarball carries.
    #[test]
    fn targz_archives_install_too() {
        let install_dir = scratch("targz");
        let exe = install_dir.join("Mara3");
        fs::write(&exe, b"old build").unwrap();

        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let body = b"new build";
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, "Mara3", &body[..]).unwrap();
            builder.finish().unwrap();
        }
        let mut gz = Vec::new();
        {
            use std::io::Write;
            let mut enc = flate2::write::GzEncoder::new(&mut gz, flate2::Compression::fast());
            enc.write_all(&tar_bytes).unwrap();
            enc.finish().unwrap();
        }

        install(&gz, true, &exe).unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new build");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&exe).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "the new binary must stay executable");
        }
        let _ = fs::remove_dir_all(&install_dir);
    }
}
