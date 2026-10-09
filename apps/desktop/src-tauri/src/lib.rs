use keyring::Entry;
use url::Url;

fn credential(origin: &str) -> Result<Entry, String> {
    let url = Url::parse(origin).map_err(|error| error.to_string())?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTPS server origin, or HTTP on localhost.".into());
    }
    Entry::new("com.huddle.desktop", &url.origin().ascii_serialization())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_token(origin: String) -> Result<Option<String>, String> {
    match credential(&origin)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_token(origin: String, token: String) -> Result<(), String> {
    credential(&origin)?
        .set_password(&token)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_token(origin: String) -> Result<(), String> {
    match credential(&origin)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_token,
            save_token,
            clear_token
        ])
        .run(tauri::generate_context!())
        .expect("Huddle could not start");
}
