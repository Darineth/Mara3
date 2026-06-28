fn main() {
    // lib.rs bakes this in via option_env! at compile time; tell Cargo to rebuild when
    // it changes so packaging with a different update URL doesn't reuse a stale value.
    println!("cargo:rerun-if-env-changed=MARA_UPDATE_URL");
    tauri_build::build()
}
