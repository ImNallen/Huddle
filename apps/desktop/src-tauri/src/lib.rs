#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    window.set_decorations(false)?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Huddle could not start");
}
