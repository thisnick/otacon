use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::{Html, Response},
    routing::get,
};
use futures::{SinkExt, StreamExt};
use std::{
    env,
    net::SocketAddr,
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{broadcast, Mutex},
};

const SAMPLE_RATE: u32 = 44100;
const CHANNELS: u16 = 1;
const FRAME_SIZE: usize = 4096; // bytes per PCM frame sent over WebSocket

struct AppState {
    /// Broadcast channel for captured audio (Pi mic → clients)
    capture_tx: broadcast::Sender<Vec<u8>>,
    /// Mutex protecting the single playback sender slot
    playback_owner: Mutex<Option<u64>>,
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("AUDIO_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);

    let (capture_tx, _) = broadcast::channel::<Vec<u8>>(64);

    let state = Arc::new(AppState {
        capture_tx: capture_tx.clone(),
        playback_owner: Mutex::new(None),
    });

    // Spawn the capture task (arecord → broadcast)
    let capture_device = env::var("ALSA_CAPTURE_DEVICE").unwrap_or_else(|_| "plughw:Device,0".into());
    tokio::spawn(capture_audio(capture_device, capture_tx));

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/ws", get({
            let state = state.clone();
            move |ws| ws_handler(ws, state)
        }))
        .route("/audio", get({
            let capture_device = env::var("ALSA_CAPTURE_DEVICE").unwrap_or_else(|_| "plughw:Device,0".into());
            move || mp3_stream_handler(capture_device)
        }));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    // Try TLS with Tailscale certs, fall back to plain HTTP
    let cert_dir = env::var("TLS_CERT_DIR").unwrap_or_else(|_| "/certs".into());
    let cert_path = format!("{cert_dir}/otacon-pi.crt");
    let key_path = format!("{cert_dir}/otacon-pi.key");

    if std::path::Path::new(&cert_path).exists() && std::path::Path::new(&key_path).exists() {
        eprintln!("Audio server listening on https://{addr} (TLS)");
        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert_path, &key_path)
            .await
            .expect("Failed to load TLS certs");
        axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service())
            .await
            .unwrap();
    } else {
        eprintln!("No TLS certs found at {cert_dir}, listening on http://{addr}");
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    }
}

/// Continuously capture from ALSA and broadcast PCM to all subscribers
async fn capture_audio(device: String, tx: broadcast::Sender<Vec<u8>>) {
    loop {
        eprintln!("Starting arecord on {device}");
        let mut child = match Command::new("arecord")
            .args([
                "-D", &device,
                "-f", "S16_LE",
                "-r", &SAMPLE_RATE.to_string(),
                "-c", &CHANNELS.to_string(),
                "-t", "raw",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Failed to start arecord: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };

        let mut stdout = child.stdout.take().unwrap();
        let mut buf = vec![0u8; FRAME_SIZE];

        loop {
            match stdout.read_exact(&mut buf).await {
                Ok(_) => {
                    // Ignore send errors (no receivers)
                    let _ = tx.send(buf.clone());
                }
                Err(_) => break,
            }
        }

        let _ = child.kill().await;
        eprintln!("arecord exited, restarting in 2s");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Serve the monitoring UI
async fn index_handler() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

/// WebSocket handler: bidirectional PCM audio
async fn ws_handler(ws: WebSocketUpgrade, state: Arc<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>) {
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let client_id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    eprintln!("WebSocket client {client_id} connected");

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut capture_rx = state.capture_tx.subscribe();

    // Task: send captured audio to this client
    let send_task = tokio::spawn(async move {
        while let Ok(data) = capture_rx.recv().await {
            if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: receive mic audio from this client → aplay
    let playback_device = env::var("ALSA_PLAYBACK_DEVICE").unwrap_or_else(|_| "plughw:Device,0".into());
    let state_clone = state.clone();
    let recv_task = tokio::spawn(async move {
        let mut aplay: Option<tokio::process::Child> = None;
        let mut is_owner = false;

        while let Some(Ok(msg)) = ws_rx.next().await {
            if let Message::Binary(data) = msg {
                // Try to claim playback ownership
                if !is_owner {
                    let mut owner = state_clone.playback_owner.lock().await;
                    if owner.is_none() {
                        *owner = Some(client_id);
                        is_owner = true;
                        eprintln!("Client {client_id} claimed playback");
                    } else {
                        // Someone else owns playback, ignore
                        continue;
                    }
                }

                // Start aplay if not running
                if aplay.is_none() {
                    match Command::new("aplay")
                        .args([
                            "-D", &playback_device,
                            "-f", "S16_LE",
                            "-r", &SAMPLE_RATE.to_string(),
                            "-c", &CHANNELS.to_string(),
                            "-t", "raw",
                        ])
                        .stdin(Stdio::piped())
                        .stderr(Stdio::null())
                        .spawn()
                    {
                        Ok(child) => aplay = Some(child),
                        Err(e) => {
                            eprintln!("Failed to start aplay: {e}");
                            continue;
                        }
                    }
                }

                if let Some(ref mut child) = aplay {
                    if let Some(ref mut stdin) = child.stdin {
                        if stdin.write_all(&data).await.is_err() {
                            // aplay died, will restart on next frame
                            let _ = child.kill().await;
                            aplay = None;
                        }
                    }
                }
            }
        }

        // Cleanup: release playback ownership
        if is_owner {
            let mut owner = state_clone.playback_owner.lock().await;
            if *owner == Some(client_id) {
                *owner = None;
                eprintln!("Client {client_id} released playback");
            }
        }

        if let Some(mut child) = aplay {
            let _ = child.kill().await;
        }
    });

    // Wait for either task to finish (client disconnect)
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    eprintln!("WebSocket client {client_id} disconnected");
}

/// Stream MP3 audio via HTTP (for VLC/ffplay)
async fn mp3_stream_handler(capture_device: String) -> Response {
    let stream = async_stream::stream! {
        let mut child = match Command::new("bash")
            .args([
                "-c",
                &format!(
                    "arecord -D {} -f S16_LE -r {} -c {} -t raw | lame -r -s 44.1 -m m --bitrate 128 - -",
                    capture_device, SAMPLE_RATE, CHANNELS
                ),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                yield Err(std::io::Error::new(std::io::ErrorKind::Other, e));
                return;
            }
        };

        let mut stdout = child.stdout.take().unwrap();
        let mut buf = vec![0u8; 4096];

        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => yield Ok(buf[..n].to_vec()),
                Err(e) => {
                    yield Err(e);
                    break;
                }
            }
        }

        let _ = child.kill().await;
    };

    let body = axum::body::Body::from_stream(stream);
    Response::builder()
        .header("Content-Type", "audio/mpeg")
        .header("Cache-Control", "no-cache")
        .header("Transfer-Encoding", "chunked")
        .body(body)
        .unwrap()
}
