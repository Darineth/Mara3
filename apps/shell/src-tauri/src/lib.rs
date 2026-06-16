// Shared entry point for desktop and mobile. Tauri 2 mobile invokes `run()`
// through the generated `mobile_entry_point`, while desktop calls it from main.rs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Mara 3");
}
