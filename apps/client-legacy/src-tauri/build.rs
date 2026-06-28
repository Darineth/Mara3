use std::path::PathBuf;

// The `windows 0.39` import-lib crate (`windows_x86_64_msvc`, pulled in via tao/wry)
// only emits its `windows.lib` link-search path for the `x86_64-pc-windows-msvc` /
// `-uwp-` triples — on the tier-3 `x86_64-win7-windows-msvc` triple its build script
// returns early, so the final link fails with `LNK1181: cannot open input file
// 'windows.lib'`. The import library is architecturally identical, so locate it in
// the cargo registry and add its directory to the link search path ourselves.
fn fix_win7_windows_lib() {
    if std::env::var("TARGET").unwrap_or_default() != "x86_64-win7-windows-msvc" {
        return;
    }
    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .unwrap_or_default();
            PathBuf::from(home).join(".cargo")
        });
    let registry_src = cargo_home.join("registry").join("src");
    if let Ok(indexes) = std::fs::read_dir(&registry_src) {
        for index in indexes.flatten() {
            let lib = index.path().join("windows_x86_64_msvc-0.39.0").join("lib");
            if lib.join("windows.lib").exists() {
                println!("cargo:rustc-link-search=native={}", lib.display());
                return;
            }
        }
    }
    println!(
        "cargo:warning=client-legacy: could not find windows_x86_64_msvc-0.39.0/lib for the \
         win7 target; the link will fail with LNK1181 (windows.lib)"
    );
}

fn main() {
    // main.rs bakes this in via option_env! at compile time; tell Cargo to rebuild
    // when it changes so packaging with a different update URL doesn't reuse a stale
    // value.
    println!("cargo:rerun-if-env-changed=MARA_UPDATE_URL");
    fix_win7_windows_lib();
    tauri_build::build()
}
