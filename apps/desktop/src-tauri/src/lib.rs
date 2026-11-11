use tauri::webview::{PermissionKind, PermissionResponse, WebviewWindowBuilder};

fn microphone_allowed(
    kind: PermissionKind,
    url: &tauri::Url,
    dev_url: Option<&tauri::Url>,
) -> bool {
    kind == PermissionKind::Microphone
        && ((url.port().is_none()
            && matches!(
                (url.scheme(), url.host_str()),
                ("tauri", Some("localhost")) | ("https", Some("tauri.localhost"))
            ))
            || dev_url.is_some_and(|dev| url.origin() == dev.origin()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dev_url = if cfg!(debug_assertions) {
                app.config().build.dev_url.clone()
            } else {
                None
            };
            let _window = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_permission_request(move |webview, kind| {
                    if kind != PermissionKind::Microphone {
                        return PermissionResponse::Default;
                    }
                    if webview
                        .url()
                        .is_ok_and(|url| microphone_allowed(kind, &url, dev_url.as_ref()))
                    {
                        PermissionResponse::Allow
                    } else {
                        PermissionResponse::Deny
                    }
                })
                .build()?;
            #[cfg(not(target_os = "macos"))]
            _window.set_decorations(false)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Huddle could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_local_frontend_can_capture_audio() {
        for address in ["tauri://localhost/", "https://tauri.localhost/"] {
            let url = tauri::Url::parse(address).unwrap();
            assert!(microphone_allowed(PermissionKind::Microphone, &url, None));
            for kind in [
                PermissionKind::Camera,
                PermissionKind::DisplayCapture,
                PermissionKind::Geolocation,
            ] {
                assert!(!microphone_allowed(kind, &url, None));
            }
        }
        for address in [
            "https://example.com/",
            "http://localhost:1420/",
            "https://tauri.localhost.evil.test/",
            "tauri://other/",
            "https://tauri.localhost:4433/",
        ] {
            let url = tauri::Url::parse(address).unwrap();
            assert!(!microphone_allowed(PermissionKind::Microphone, &url, None));
        }
        let dev = tauri::Url::parse("http://127.0.0.1:1420/").unwrap();
        assert!(microphone_allowed(
            PermissionKind::Microphone,
            &dev,
            Some(&dev)
        ));
        assert!(!microphone_allowed(
            PermissionKind::Camera,
            &dev,
            Some(&dev)
        ));
        let other_port = tauri::Url::parse("http://127.0.0.1:1421/").unwrap();
        assert!(!microphone_allowed(
            PermissionKind::Microphone,
            &other_port,
            Some(&dev)
        ));
    }
}
