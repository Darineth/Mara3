// Shared entry point for desktop and mobile. Tauri 2 mobile invokes `run()`
// through the generated `mobile_entry_point`, while desktop calls it from main.rs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // Signed auto-update is desktop-only; mobile updates ship through app stores.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Mara 3");
}
