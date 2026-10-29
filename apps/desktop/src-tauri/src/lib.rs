use std::sync::{Arc, Mutex, OnceLock};

use keyring::Entry;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::TlsConnector;
use url::Url;

fn install_crypto() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn decode_base64url(input: &str) -> Result<Vec<u8>, String> {
    fn value(byte: u8) -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'-' => Ok(62),
            b'_' => Ok(63),
            _ => Err("That invite is incomplete. Ask for a new one.".into()),
        }
    }
    let bytes = input.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 == 1 {
        return Err("That invite is incomplete. Ask for a new one.".into());
    }
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let first = value(bytes[index])?;
        let second = if index + 1 < bytes.len() {
            value(bytes[index + 1])?
        } else {
            0
        };
        let third = if index + 2 < bytes.len() {
            value(bytes[index + 2])?
        } else {
            0
        };
        let fourth = if index + 3 < bytes.len() {
            value(bytes[index + 3])?
        } else {
            0
        };
        out.push((first << 2) | (second >> 4));
        if index + 2 < bytes.len() {
            out.push((second << 4) | (third >> 2));
        }
        if index + 3 < bytes.len() {
            out.push((third << 6) | fourth);
        }
        index += 4;
    }
    Ok(out)
}

#[derive(Debug)]
struct PinVerifier {
    pin: [u8; 32],
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let digest = Sha256::digest(end_entity.as_ref());
        if digest.as_slice() == self.pin.as_slice() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "Huddle server key does not match the invite".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

static STOP: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

fn replace_stop(next: oneshot::Sender<()>) {
    let mut guard = STOP.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(previous) = guard.replace(next) {
        let _ = previous.send(());
    }
}

async fn bridge(
    mut inbound: TcpStream,
    host: String,
    port: u16,
    connector: TlsConnector,
) -> Result<(), String> {
    let _ = inbound.set_nodelay(true);
    let outbound = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = outbound.set_nodelay(true);
    let name = ServerName::try_from(host).map_err(|error| error.to_string())?;
    let mut tls = connector
        .connect(name, outbound)
        .await
        .map_err(|error| error.to_string())?;
    copy_bidirectional(&mut inbound, &mut tls)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_invite(host: String, port: u16, pin: String) -> Result<String, String> {
    install_crypto();
    let decoded = decode_base64url(&pin)?;
    let pin: [u8; 32] = decoded
        .try_into()
        .map_err(|_| "That invite is incomplete. Ask for a new one.".to_string())?;
    if host.is_empty() || host.len() > 253 || host.contains(['/', ' ', '@']) {
        return Err("That invite is incomplete. Ask for a new one.".into());
    }
    ServerName::try_from(host.as_str()).map_err(|error| error.to_string())?;
    let verifier = Arc::new(PinVerifier { pin });
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let local = listener.local_addr().map_err(|error| error.to_string())?;
    let (stop, mut stopped) = oneshot::channel();
    replace_stop(stop);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((inbound, _)) => {
                            let host = host.clone();
                            let connector = connector.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) = bridge(inbound, host, port, connector).await {
                                    eprintln!("huddle invite: {error}");
                                }
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });
    Ok(format!("http://127.0.0.1:{}", local.port()))
}

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
            clear_token,
            open_invite
        ])
        .run(tauri::generate_context!())
        .expect("Huddle could not start");
}
