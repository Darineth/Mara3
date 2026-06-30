fn main() {
    // lib.rs bakes this in via option_env! at compile time; tell Cargo to rebuild when
    // it changes so packaging with a different update URL doesn't reuse a stale value.
    println!("cargo:rerun-if-env-changed=MARA_UPDATE_URL");

    // Declare our app commands so Tauri autogenerates `allow-<command>` permissions for
    // them. Without this, app commands have no permission identifier and so can't be
    // granted to the loaded server's (remote) origin — the remote page hits
    // "Command <x> not allowed by ACL". With it, the runtime capability in lib.rs
    // (grant_remote_ipc) can allow `allow-mara-log`/`allow-switch-server` for that origin.
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "mara_log",
            "get_settings",
            "set_server_url",
            "set_auto_connect",
            "open_app",
            "switch_server",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
