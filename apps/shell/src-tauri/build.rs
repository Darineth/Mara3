fn main() {
    // lib.rs bakes this in via option_env! at compile time; tell Cargo to rebuild when
    // it changes so packaging with a different update URL doesn't reuse a stale value.
    println!("cargo:rerun-if-env-changed=MARA_UPDATE_URL");

    // Android 15+ requires native libs aligned to 16 KB pages. rustc invokes the NDK
    // linker directly and doesn't inherit its default page size, so the cdylib ships
    // with 4 KB-aligned LOAD segments and fails the 16 KB compatibility check. Pass
    // max-page-size explicitly for Android targets (all ABIs); desktop is unaffected.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }

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
            "open_external",
            "request_attention",
            "open_popout",
            "close_self",
            "focus_self",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
