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

const FRAME_SIZE: usize = 4096; // bytes per PCM frame sent over WebSocket

#[derive(Clone, Debug)]
enum AudioBackend { Alsa, Bluetooth }

impl std::fmt::Display for AudioBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { AudioBackend::Alsa => write!(f, "alsa"), AudioBackend::Bluetooth => write!(f, "bluetooth") }
    }
}

#[derive(Clone)]
struct AudioConfig {
    backend: AudioBackend,
    sample_rate: u32,
    channels: u16,
    a2dp_sample_rate: u32,
    a2dp_channels: u16,
    capture_cmd: Vec<String>,
    a2dp_capture_cmd: Option<Vec<String>>,
    playback_cmd: Vec<String>,
    mp3_cmd: String,
}

fn alsa_cmd(tool: &str, device: &str, rate: u32, channels: u16) -> Vec<String> {
    vec![
        tool.into(),
        "-D".into(), device.into(),
        "-f".into(), "S16_LE".into(),
        "-r".into(), rate.to_string(),
        "-c".into(), channels.to_string(),
        "-t".into(), "raw".into(),
    ]
}

impl AudioConfig {
    fn from_env() -> Self {
        let backend = env::var("AUDIO_BACKEND").unwrap_or_else(|_| "alsa".into());

        match backend.as_str() {
            "bluetooth" => {
                // HFP via BlueALSA. mSBC codec runs at 16kHz (wideband).
                // BlueALSA exposes a standard ALSA device named "bluealsa".
                let sample_rate = 16000u32;
                let channels = 1u16;
                // Device format: "bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=sco"
                // Default uses first connected device; override with BLUEALSA_DEVICE.
                let device = env::var("BLUEALSA_DEVICE")
                    .unwrap_or_else(|_| "bluealsa:DEV=00:00:00:00:00:00,PROFILE=sco".into());
                let a2dp_device = device.replace("PROFILE=sco", "PROFILE=a2dp");
                let a2dp_sample_rate = 44100u32;
                let a2dp_channels = 2u16;
                AudioConfig {
                    backend: AudioBackend::Bluetooth,
                    sample_rate,
                    channels,
                    a2dp_sample_rate,
                    a2dp_channels,
                    capture_cmd: alsa_cmd("arecord", &device, sample_rate, channels),
                    a2dp_capture_cmd: Some(alsa_cmd("arecord", &a2dp_device, a2dp_sample_rate, a2dp_channels)),
                    playback_cmd: alsa_cmd("aplay", &device, sample_rate, channels),
                    mp3_cmd: format!(
                        "arecord -D {device} -f S16_LE -r {sample_rate} -c {channels} -t raw | lame -r -s 16 -m m --bitrate 32 - -"
                    ),
                }
            }
            _ => {
                let sample_rate = 44100u32;
                let channels = 1u16;
                let capture_device = env::var("ALSA_CAPTURE_DEVICE")
                    .unwrap_or_else(|_| "plughw:Device,0".into());
                let playback_device = env::var("ALSA_PLAYBACK_DEVICE")
                    .unwrap_or_else(|_| "plughw:Device,0".into());
                AudioConfig {
                    backend: AudioBackend::Alsa,
                    sample_rate,
                    channels,
                    a2dp_sample_rate: 0,
                    a2dp_channels: 0,
                    capture_cmd: alsa_cmd("arecord", &capture_device, sample_rate, channels),
                    a2dp_capture_cmd: None,
                    playback_cmd: alsa_cmd("aplay", &playback_device, sample_rate, channels),
                    mp3_cmd: format!(
                        "arecord -D {capture_device} -f S16_LE -r {sample_rate} -c {channels} -t raw | lame -r -s 44.1 -m m --bitrate 128 - -"
                    ),
                }
            }
        }
    }
}

struct AppState {
    /// Broadcast channel for captured audio (Pi mic → clients)
    capture_tx: broadcast::Sender<Vec<u8>>,
    /// Broadcast channel for A2DP media audio (phone → clients)
    a2dp_tx: Option<broadcast::Sender<Vec<u8>>>,
    /// Mutex protecting the single playback sender slot
    playback_owner: Mutex<Option<u64>>,
    /// Audio configuration
    audio_config: AudioConfig,
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("AUDIO_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);

    let audio_config = AudioConfig::from_env();
    eprintln!("Audio backend: {} ({}Hz, {}ch)", audio_config.backend, audio_config.sample_rate, audio_config.channels);

    let (capture_tx, _) = broadcast::channel::<Vec<u8>>(64);

    // Extract fields needed by spawned tasks before moving audio_config into state
    let capture_cmd = audio_config.capture_cmd.clone();
    let mp3_cmd = audio_config.mp3_cmd.clone();

    let a2dp_tx = if let Some(cmd) = audio_config.a2dp_capture_cmd.clone() {
        let (tx, _) = broadcast::channel::<Vec<u8>>(64);
        tokio::spawn(capture_audio(cmd, tx.clone()));
        Some(tx)
    } else {
        None
    };

    let state = Arc::new(AppState {
        capture_tx: capture_tx.clone(),
        a2dp_tx,
        playback_owner: Mutex::new(None),
        audio_config,
    });

    tokio::spawn(capture_audio(capture_cmd, capture_tx));

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/ws", get({
            let state = state.clone();
            move |ws| ws_handler(ws, state)
        }))
        .route("/ws/media", get({
            let state = state.clone();
            move |ws| ws_media_handler(ws, state)
        }))
        .route("/audio", get({
            move || mp3_stream_handler(mp3_cmd)
        }));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    // Try TLS with Tailscale certs, fall back to plain HTTP
    let cert_dir = env::var("TLS_CERT_DIR").unwrap_or_else(|_| "/certs".into());
    let cert_path = format!("{cert_dir}/otacon-pi.crt");
    let key_path = format!("{cert_dir}/otacon-pi.key");

    match axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert_path, &key_path).await {
        Ok(tls_config) => {
            eprintln!("Audio server listening on https://{addr} (TLS)");
            axum_server::bind_rustls(addr, tls_config)
                .serve(app.into_make_service())
                .await
                .unwrap();
        }
        Err(_) => {
            eprintln!("No TLS certs found at {cert_dir}, listening on http://{addr}");
            let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
            axum::serve(listener, app).await.unwrap();
        }
    }
}

/// Continuously capture audio and broadcast PCM to all subscribers
async fn capture_audio(cmd: Vec<String>, tx: broadcast::Sender<Vec<u8>>) {
    loop {
        eprintln!("Starting capture: {:?}", cmd);
        let mut child = match Command::new(&cmd[0])
            .args(&cmd[1..])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Failed to start capture: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };

        let mut stdout = child.stdout.take().unwrap();
        let mut buf = vec![0u8; FRAME_SIZE];

        loop {
            match stdout.read_exact(&mut buf).await {
                Ok(_) => {
                    let _ = tx.send(buf.clone());
                }
                Err(_) => break,
            }
        }

        let _ = child.kill().await;
        eprintln!("Capture exited, restarting in 2s");
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

    // Send config message so the client knows the sample rate
    let config_msg = format!(
        r#"{{"type":"config","sampleRate":{},"channels":{}}}"#,
        state.audio_config.sample_rate, state.audio_config.channels
    );
    let _ = ws_tx.send(Message::Text(config_msg.into())).await;

    // Task: send captured audio to this client
    let send_task = tokio::spawn(async move {
        while let Ok(data) = capture_rx.recv().await {
            if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: receive mic audio from this client → playback
    let playback_cmd = state.audio_config.playback_cmd.clone();
    let state_clone = state.clone();
    let recv_task = tokio::spawn(async move {
        let mut player: Option<tokio::process::Child> = None;
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
                        continue;
                    }
                }

                // Start playback if not running
                if player.is_none() {
                    match Command::new(&playback_cmd[0])
                        .args(&playback_cmd[1..])
                        .stdin(Stdio::piped())
                        .stderr(Stdio::null())
                        .spawn()
                    {
                        Ok(child) => player = Some(child),
                        Err(e) => {
                            eprintln!("Failed to start playback: {e}");
                            continue;
                        }
                    }
                }

                if let Some(ref mut child) = player {
                    if let Some(ref mut stdin) = child.stdin {
                        if stdin.write_all(&data).await.is_err() {
                            let _ = child.kill().await;
                            player = None;
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

        if let Some(mut child) = player {
            let _ = child.kill().await;
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    eprintln!("WebSocket client {client_id} disconnected");
}

/// WebSocket handler: A2DP media audio (subscribe-only)
async fn ws_media_handler(ws: WebSocketUpgrade, state: Arc<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws_media(socket, state))
}

async fn handle_ws_media(socket: WebSocket, state: Arc<AppState>) {
    let Some(ref a2dp_tx) = state.a2dp_tx else { return; };
    let (mut ws_tx, _) = socket.split();
    let mut rx = a2dp_tx.subscribe();

    let config_msg = format!(
        r#"{{"type":"config","sampleRate":{},"channels":{}}}"#,
        state.audio_config.a2dp_sample_rate,
        state.audio_config.a2dp_channels
    );
    if ws_tx.send(Message::Text(config_msg.into())).await.is_err() {
        return;
    }

    while let Ok(data) = rx.recv().await {
        if ws_tx.send(Message::Binary(data.into())).await.is_err() {
            break;
        }
    }
}

/// Stream MP3 audio via HTTP (for VLC/ffplay)
async fn mp3_stream_handler(mp3_cmd: String) -> Response {
    let stream = async_stream::stream! {
        let mut child = match Command::new("bash")
            .args(["-c", &mp3_cmd])
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
