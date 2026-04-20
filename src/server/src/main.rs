mod api;
mod dbus_monitor;
pub mod fleet;
pub mod phone;

use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use std::{
    collections::HashMap,
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
pub struct AudioConfig {
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
        Self::build(&backend, None)
    }

    /// Build an AudioConfig for a specific phone's BT MAC.
    /// If phone_bt_mac is Some, uses that device specifically; otherwise uses wildcard.
    fn for_phone(phone_bt_mac: Option<&str>) -> Self {
        let backend = env::var("AUDIO_BACKEND").unwrap_or_else(|_| "alsa".into());
        Self::build(&backend, phone_bt_mac)
    }

    fn build(backend: &str, phone_bt_mac: Option<&str>) -> Self {
        match backend {
            "bluetooth" => {
                let sample_rate = 16000u32;
                let channels = 1u16;
                // Per-phone: use specific device MAC if known, else wildcard
                let device = if let Some(mac) = phone_bt_mac {
                    format!("bluealsa:DEV={mac},PROFILE=sco")
                } else {
                    env::var("BLUEALSA_DEVICE")
                        .unwrap_or_else(|_| "bluealsa:DEV=00:00:00:00:00:00,PROFILE=sco".into())
                };
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

pub struct AppState {
    /// Map from phone ID to per-phone state
    pub phones: tokio::sync::RwLock<HashMap<String, Arc<phone::PhoneState>>>,
    /// Broadcast channel for system-level events (phone added/removed)
    pub system_events_tx: broadcast::Sender<String>,
    /// Path to phones.json config file
    pub config_path: std::path::PathBuf,
}

/// Create a PhoneState from a PhoneConfig.
/// Uses per-phone BlueALSA device if the phone has a BT MAC assigned.
fn create_phone_state(config: phone::PhoneConfig, audio_config: &AudioConfig) -> Arc<phone::PhoneState> {
    // Build per-phone audio config if phone has a BT MAC
    let per_phone_audio;
    let audio_config = if config.phone_bt_mac.is_some() {
        per_phone_audio = AudioConfig::for_phone(config.phone_bt_mac.as_deref());
        &per_phone_audio
    } else {
        audio_config
    };
    let (capture_tx, _) = broadcast::channel::<Vec<u8>>(64);
    let (events_tx, _) = broadcast::channel::<String>(256);
    let active_sinks = Arc::new(Mutex::new(HashMap::new()));

    let a2dp_tx = if audio_config.a2dp_capture_cmd.is_some() {
        let (tx, _) = broadcast::channel::<Vec<u8>>(64);
        Some(tx)
    } else {
        None
    };

    let bridge = Arc::new(api::bridge::BridgeState::new(
        config.snapshot_port,
        config.adb_serial.clone(),
    ));
    api::bridge::spawn_health_checker(bridge.clone());

    // Audio capture is now lazy — started when first WebSocket client connects
    // D-Bus monitor for BlueALSA sink state is still always-on (lightweight)
    if matches!(audio_config.backend, AudioBackend::Bluetooth) {
        dbus_monitor::spawn_monitor(events_tx.clone(), active_sinks.clone());
    }

    Arc::new(phone::PhoneState {
        config,
        capture_tx,
        a2dp_tx,
        playback_owner: Mutex::new(None),
        audio_config: audio_config.clone(),
        snapshot_cache: Mutex::new(Some(api::snapshot::SnapshotCache::default())),
        bridge,
        events_tx,
        active_sinks,
        recording: Arc::new(Mutex::new(None)),
        sim_call: Mutex::new(api::test_sim::SimCallState::default()),
        call_audio_occupied: std::sync::atomic::AtomicBool::new(false),
        display: Mutex::new(phone::DisplayResources::default()),
        vnc_clients: std::sync::atomic::AtomicU32::new(0),
        capture_clients: std::sync::atomic::AtomicU32::new(0),
        media_clients: std::sync::atomic::AtomicU32::new(0),
        capture_running: std::sync::atomic::AtomicBool::new(false),
        a2dp_capture_running: std::sync::atomic::AtomicBool::new(false),
        monitor_status: Mutex::new(None),
    })
}

#[tokio::main]
async fn main() {
    // Export OpenAPI spec and exit (for CLI type generation)
    if env::args().any(|a| a == "--export-openapi") {
        use utoipa::OpenApi;
        let spec = api::ApiDoc::openapi().to_json().unwrap();
        println!("{spec}");
        return;
    }

    let port: u16 = env::var("AUDIO_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);

    let audio_config = AudioConfig::from_env();
    eprintln!("Audio backend: {} ({}Hz, {}ch)", audio_config.backend, audio_config.sample_rate, audio_config.channels);

    // Load phone configs from disk (or create default single-phone config)
    let config_path = std::path::PathBuf::from(
        env::var("PHONES_CONFIG").unwrap_or_else(|_| "/data/otacon/phones.json".into())
    );
    let phone_configs = phone::load_phones(&config_path).await;

    if phone_configs.is_empty() {
        eprintln!("No phones in {config_path:?} — waiting for device-monitor to register via POST /phones");
    }

    // Build phone state map
    let mut phones = HashMap::new();
    for config in &phone_configs {
        let phone_state = create_phone_state(config.clone(), &audio_config);
        eprintln!("Loaded phone '{}' (serial: {})", config.id, config.adb_serial);
        phones.insert(config.id.clone(), phone_state);
    }

    let (system_events_tx, _) = broadcast::channel::<String>(64);

    let state = Arc::new(AppState {
        phones: tokio::sync::RwLock::new(phones),
        system_events_tx,
        config_path,
    });

    // Start lazy VNC proxy listeners for each phone
    for (_id, phone_state) in state.phones.read().await.iter() {
        spawn_vnc_proxy(phone_state.clone());
    }

    // Start fleet client if REGISTRY_URL is set
    if let Some(fleet_client) = fleet::FleetClient::from_env() {
        let fleet_client = Arc::new(fleet_client);
        fleet::spawn_heartbeat(fleet_client.clone(), state.clone());
        fleet::spawn_config_ws(fleet_client, state.clone());
        eprintln!("Fleet client enabled");
    } else {
        eprintln!("Fleet client disabled (no REGISTRY_URL)");
    }

    // Periodically reload phones.json to pick up new phones added by fleet-agent
    {
        let reload_state = state.clone();
        let audio_config_reload = audio_config.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                let configs = phone::load_phones(&reload_state.config_path).await;
                let mut phones = reload_state.phones.write().await;
                let existing_serials: std::collections::HashSet<String> = phones.values()
                    .map(|ps| ps.config.adb_serial.clone())
                    .collect();
                for config in configs {
                    if !config.adb_serial.is_empty() && !existing_serials.contains(&config.adb_serial) {
                        eprintln!("[reload] New phone detected: '{}' (serial: {})", config.id, config.adb_serial);
                        let phone_state = create_phone_state(config.clone(), &audio_config_reload);
                        spawn_vnc_proxy(phone_state.clone());
                        phones.insert(config.id.clone(), phone_state);
                    }
                }
            }
        });
    }

    let app = api::router(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    // Internal plain HTTP listener for device-monitor and per-phone push events.
    // Serves the full app on plain HTTP so local callers don't need TLS.
    let internal_port: u16 = env::var("INTERNAL_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8081);
    let internal_addr = SocketAddr::from(([0, 0, 0, 0], internal_port));
    let internal_app = app.clone();
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind(internal_addr).await.unwrap();
        eprintln!("Internal HTTP listener on http://{internal_addr} (plain, for device-monitor)");
        axum::serve(listener, internal_app).await.unwrap();
    });

    // Try TLS with Tailscale certs, fall back to plain HTTP
    let cert_dir = env::var("TLS_CERT_DIR").unwrap_or_else(|_| "/certs".into());
    let cert_path = format!("{cert_dir}/otacon-pi.crt");
    let key_path = format!("{cert_dir}/otacon-pi.key");

    match axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert_path, &key_path).await {
        Ok(tls_config) => {
            eprintln!("Server listening on https://{addr} (TLS)");
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

/// Capture audio while there are active clients. Stops when client count drops to 0.
async fn capture_audio_lazy(
    cmd: Vec<String>,
    tx: broadcast::Sender<Vec<u8>>,
    running: &std::sync::atomic::AtomicBool,
    clients: &std::sync::atomic::AtomicU32,
) {
    loop {
        // Check if there are still clients
        if clients.load(std::sync::atomic::Ordering::Relaxed) == 0 {
            eprintln!("No audio clients, stopping capture");
            break;
        }

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
            // Periodically check if we should stop
            if clients.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                let _ = child.kill().await;
                eprintln!("No audio clients, stopping capture");
                return;
            }
        }

        let _ = child.kill().await;
        if clients.load(std::sync::atomic::Ordering::Relaxed) == 0 {
            eprintln!("No audio clients after capture exit, not restarting");
            break;
        }
        eprintln!("Capture exited, restarting in 2s");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Start audio capture for a phone if not already running.
fn ensure_capture(state: &Arc<phone::PhoneState>) {
    use std::sync::atomic::Ordering;
    if state.capture_running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
        let cmd = state.audio_config.capture_cmd.clone();
        let tx = state.capture_tx.clone();
        let state = state.clone();
        tokio::spawn(async move {
            capture_audio_lazy(cmd, tx, &state.capture_running, &state.capture_clients).await;
            state.capture_running.store(false, Ordering::Release);
        });
    }
}

/// Start A2DP capture for a phone if not already running.
fn ensure_a2dp_capture(state: &Arc<phone::PhoneState>) {
    use std::sync::atomic::Ordering;
    if state.a2dp_capture_running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
        if let Some(ref cmd) = state.audio_config.a2dp_capture_cmd {
            if let Some(ref tx) = state.a2dp_tx {
                let cmd = cmd.clone();
                let tx = tx.clone();
                let state = state.clone();
                tokio::spawn(async move {
                    capture_audio_lazy(cmd, tx, &state.a2dp_capture_running, &state.media_clients).await;
                    state.a2dp_capture_running.store(false, Ordering::Release);
                });
            }
        }
    }
}

/// Spawn a lazy VNC proxy for a phone. Listens on the phone's VNC port,
/// starts Xvnc+scrcpy on first connection, idles after 60s with no clients.
fn spawn_vnc_proxy(state: Arc<phone::PhoneState>) {
    let vnc_port = state.config.vnc_port;
    let phone_id = state.config.id.clone();

    tokio::spawn(async move {
        // Bind to VNC port
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", vnc_port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[{phone_id}] Failed to bind VNC proxy on port {vnc_port}: {e}");
                return;
            }
        };
        eprintln!("[{phone_id}] VNC proxy listening on port {vnc_port}");

        loop {
            let (client_stream, addr) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[{phone_id}] VNC accept error: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            eprintln!("[{phone_id}] VNC client from {addr}");

            // Ensure display is started
            if let Err(e) = state.ensure_display().await {
                eprintln!("[{phone_id}] Failed to start display: {e}");
                drop(client_stream);
                continue;
            }

            // Connect to the actual Xvnc (which is now on an internal port = vnc_port + 1000)
            let internal_vnc_port = vnc_port + 1000;
            let backend = match tokio::net::TcpStream::connect(("127.0.0.1", internal_vnc_port)).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[{phone_id}] Cannot connect to Xvnc on {internal_vnc_port}: {e}");
                    drop(client_stream);
                    continue;
                }
            };

            // Proxy the connection — track active client count so reconnects
            // within the idle grace period don't kill the display.
            state.vnc_clients.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let state_clone = state.clone();
            let phone_id_clone = phone_id.clone();
            tokio::spawn(async move {
                let (mut cr, mut cw) = client_stream.into_split();
                let (mut br, mut bw) = backend.into_split();

                let c2b = tokio::io::copy(&mut cr, &mut bw);
                let b2c = tokio::io::copy(&mut br, &mut cw);

                tokio::select! {
                    _ = c2b => {},
                    _ = b2c => {},
                }

                let remaining = state_clone.vnc_clients.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) - 1;
                eprintln!("[{phone_id_clone}] VNC client disconnected ({remaining} remaining)");

                // Schedule idle display shutdown after 60s — but only if no
                // client reconnected during the grace period.
                let idle_state = state_clone.clone();
                let pid = phone_id_clone.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    if idle_state.vnc_clients.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                        eprintln!("[{pid}] No VNC clients for 60s — stopping display");
                        idle_state.stop_display().await;
                    }
                });
            });
        }
    });
}

/// WebSocket handler: bidirectional PCM audio (single-consumer: 409 if occupied)
async fn ws_handler(ws: WebSocketUpgrade, state: Arc<phone::PhoneState>) -> Response {
    use std::sync::atomic::Ordering;
    if state.call_audio_occupied.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return (
            axum::http::StatusCode::CONFLICT,
            axum::Json(serde_json::json!({"error": "call audio WebSocket already in use"})),
        ).into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

/// Guard that decrements capture_clients and clears call_audio_occupied on drop,
/// ensuring cleanup even if the WebSocket handler is cancelled or panics.
struct CaptureClientGuard {
    state: Arc<phone::PhoneState>,
    id: u64,
}

impl Drop for CaptureClientGuard {
    fn drop(&mut self) {
        self.state.capture_clients.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        self.state.call_audio_occupied.store(false, std::sync::atomic::Ordering::Release);
        eprintln!("WebSocket client {} disconnected (guard drop)", self.id);
    }
}

async fn handle_ws(socket: WebSocket, state: Arc<phone::PhoneState>) {
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let client_id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    eprintln!("WebSocket client {client_id} connected");

    // Lazily start audio capture — guard ensures decrement on all exit paths
    state.capture_clients.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let _guard = CaptureClientGuard { state: state.clone(), id: client_id };
    ensure_capture(&state);

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut capture_rx = state.capture_tx.subscribe();

    // Send config message so the client knows the sample rate
    let config_msg = format!(
        r#"{{"type":"config","sampleRate":{},"channels":{}}}"#,
        state.audio_config.sample_rate, state.audio_config.channels
    );
    let _ = ws_tx.send(Message::Text(config_msg.into())).await;

    // Task: send captured audio to this client
    let mut send_task = tokio::spawn(async move {
        while let Ok(data) = capture_rx.recv().await {
            if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: receive audio from WebSocket client → playback via aplay.
    // Uses a mixing loop: a 100ms ticker always writes to aplay (silence or
    // real audio). This prevents BlueALSA/aplay from going idle during gaps,
    // which causes stutter when audio resumes.
    let playback_cmd = state.audio_config.playback_cmd.clone();
    let state_clone = state.clone();
    let mut recv_task = tokio::spawn(async move {
        let mut player: Option<tokio::process::Child> = None;
        let mut is_owner = false;

        // Audio buffer: WebSocket pushes chunks here, ticker drains them
        let audio_buf: Arc<tokio::sync::Mutex<Vec<u8>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let flush_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // 100ms of silence at 16kHz mono S16_LE = 3200 bytes
        let chunk_bytes: usize = 3200;

        // Spawn aplay immediately so it's ready
        fn start_aplay(cmd: &[String]) -> Option<tokio::process::Child> {
            match Command::new(&cmd[0])
                .args(&cmd[1..])
                .stdin(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => Some(child),
                Err(e) => {
                    eprintln!("Failed to start aplay: {e}");
                    None
                }
            }
        }

        // Process WebSocket messages — push audio to buffer, handle flush
        let buf_for_ws = audio_buf.clone();
        let flush_for_ws = flush_flag.clone();

        while let Some(Ok(msg)) = ws_rx.next().await {
            // Text: control commands
            if let Message::Text(text) = &msg {
                if text.contains("flush") {
                    // Clear the buffer — next tick writes silence
                    buf_for_ws.lock().await.clear();
                    flush_for_ws.store(true, std::sync::atomic::Ordering::Relaxed);
                    eprintln!("Client {client_id} flushed audio buffer");
                    continue;
                }
            }

            if let Message::Binary(data) = msg {
                // Claim playback ownership on first audio
                if !is_owner {
                    let mut owner = state_clone.playback_owner.lock().await;
                    if owner.is_none() {
                        *owner = Some(client_id);
                        is_owner = true;
                        eprintln!("Client {client_id} claimed playback");

                        // Spawn aplay and start the mixing ticker
                        player = start_aplay(&playback_cmd);
                        if player.is_some() {
                            eprintln!("Client {client_id} spawned aplay");
                        }

                        // Start the mixing ticker in a separate task
                        let buf_for_tick = audio_buf.clone();
                        let flush_for_tick = flush_flag.clone();
                        let tick_stdin = player.as_mut()
                            .and_then(|c| c.stdin.take());

                        if let Some(mut stdin) = tick_stdin {
                            tokio::spawn(async move {
                                let silence = vec![0u8; chunk_bytes];
                                let mut interval = tokio::time::interval(
                                    std::time::Duration::from_millis(100)
                                );
                                loop {
                                    interval.tick().await;

                                    // Check flush — kill and respawn
                                    if flush_for_tick.swap(false, std::sync::atomic::Ordering::Relaxed) {
                                        // Just clear — silence will play until new audio arrives
                                    }

                                    // Drain up to one chunk from buffer, or write silence
                                    let mut buf = buf_for_tick.lock().await;
                                    if buf.len() >= chunk_bytes {
                                        let chunk: Vec<u8> = buf.drain(..chunk_bytes).collect();
                                        drop(buf);
                                        if stdin.write_all(&chunk).await.is_err() {
                                            break;
                                        }
                                    } else if !buf.is_empty() {
                                        // Partial chunk — pad with silence
                                        let mut chunk: Vec<u8> = buf.drain(..).collect();
                                        chunk.resize(chunk_bytes, 0);
                                        drop(buf);
                                        if stdin.write_all(&chunk).await.is_err() {
                                            break;
                                        }
                                    } else {
                                        drop(buf);
                                        if stdin.write_all(&silence).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                                eprintln!("Mixing ticker stopped");
                            });
                        }
                    } else {
                        continue;
                    }
                }

                // Push audio data to the buffer
                buf_for_ws.lock().await.extend_from_slice(&data);
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
        _ = &mut send_task => {
            recv_task.abort();
        },
        _ = &mut recv_task => {
            send_task.abort();
        },
    }

    // _guard handles capture_clients decrement and call_audio_occupied reset on drop
}

/// WebSocket handler: A2DP media audio (subscribe-only)
async fn ws_media_handler(ws: WebSocketUpgrade, state: Arc<phone::PhoneState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws_media(socket, state))
}

/// Guard that decrements media_clients on drop.
struct MediaClientGuard {
    state: Arc<phone::PhoneState>,
}

impl Drop for MediaClientGuard {
    fn drop(&mut self) {
        self.state.media_clients.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        eprintln!("Media WebSocket client disconnected (guard drop)");
    }
}

async fn handle_ws_media(socket: WebSocket, state: Arc<phone::PhoneState>) {
    let Some(ref a2dp_tx) = state.a2dp_tx else { return; };

    // Lazily start A2DP capture — guard ensures decrement on all exit paths
    state.media_clients.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let _guard = MediaClientGuard { state: state.clone() };
    ensure_a2dp_capture(&state);

    let (mut ws_tx, _) = socket.split();
    let mut rx = a2dp_tx.subscribe();

    let config_msg = format!(
        r#"{{"type":"config","sampleRate":{},"channels":{}}}"#,
        state.audio_config.a2dp_sample_rate,
        state.audio_config.a2dp_channels
    );
    if ws_tx.send(Message::Text(config_msg.into())).await.is_err() {
        return; // _guard handles decrement
    }

    while let Ok(data) = rx.recv().await {
        if ws_tx.send(Message::Binary(data.into())).await.is_err() {
            break;
        }
    }

    // _guard handles decrement on drop
}

/// WebSocket handler: subscribe-only event stream
async fn ws_events_handler(ws: WebSocketUpgrade, state: Arc<phone::PhoneState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws_events(socket, state))
}

async fn handle_ws_events(socket: WebSocket, state: Arc<phone::PhoneState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut rx = state.events_tx.subscribe();

    // Send current state of active sinks so the client doesn't miss prior events
    {
        let sinks = state.active_sinks.lock().await;
        for (_path, event_data) in sinks.iter() {
            let msg = serde_json::json!({
                "event": "audio.sink.active",
                "data": event_data,
            });
            if ws_tx.send(Message::Text(msg.to_string().into())).await.is_err() {
                return;
            }
        }
    }

    let send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event_json) => {
                    if ws_tx.send(Message::Text(event_json.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("Events client lagged, skipped {n} messages");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let drain_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = drain_task => {},
    }
}

/// WebSocket handler: screen recording with live status
async fn handle_ws_record(socket: WebSocket, state: Arc<phone::PhoneState>, max_duration: u32) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Check if already recording
    {
        let guard = state.recording.lock().await;
        if guard.is_some() {
            let _ = ws_tx.send(Message::Text(
                r#"{"error":"recording already in progress"}"#.into()
            )).await;
            return;
        }
    }

    // Start recording
    let start_body = api::record::StartRecordBody { max_duration };
    let start_result = api::record::start_handler(state.clone(), axum::extract::Json(start_body)).await;
    if start_result.is_err() {
        let _ = ws_tx.send(Message::Text(
            r#"{"error":"failed to start recording"}"#.into()
        )).await;
        return;
    }

    let started = std::time::Instant::now();

    // Status update loop + listen for stop command
    let state_clone = state.clone();
    loop {
        tokio::select! {
            // Send status every second
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
                let elapsed = started.elapsed().as_secs() as u32;
                let msg = serde_json::json!({
                    "type": "status",
                    "elapsed": elapsed.min(max_duration),
                    "max_duration": max_duration,
                });
                if ws_tx.send(Message::Text(msg.to_string().into())).await.is_err() {
                    break; // Client disconnected
                }
                // Check if recording auto-stopped
                if elapsed >= max_duration {
                    break;
                }
                // Check if process exited
                let mut guard = state_clone.recording.lock().await;
                if let Some(ref mut info) = *guard {
                    if info.child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                } else {
                    break;
                }
            }
            // Listen for client messages
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if text.contains("stop") {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    // Stop and send the mp4
    let info = {
        let mut g = state.recording.lock().await;
        g.take()
    };

    if let Some(info) = info {
        match api::record::stop_and_retrieve(info).await {
            Ok(response) => {
                // Extract body bytes from the response
                let (_, body) = response.into_parts();
                let bytes = axum::body::to_bytes(body, 100_000_000).await.unwrap_or_default();
                let _ = ws_tx.send(Message::Binary(bytes.to_vec().into())).await;
            }
            Err(_) => {
                let _ = ws_tx.send(Message::Text(
                    r#"{"error":"failed to retrieve recording"}"#.into()
                )).await;
            }
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
