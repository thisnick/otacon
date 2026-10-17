mod api;
mod dbus_monitor;
pub mod fleet;
pub mod local_config;
pub mod outbox;
pub mod phone;
pub mod reconciler;
pub mod voice;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::Response,
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
    io::AsyncReadExt,
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

/// Call audio moves in 20 ms frames. Without explicit timing, arecord and
/// aplay pick 125 ms periods in a 500 ms buffer: captured audio arrives in
/// 125 ms bursts, and audio we play waits half a second in aplay, so marks
/// fire early and cleared audio keeps playing.
fn voice_cmd(tool: &str, device: &str, rate: u32, channels: u16, buffer_ms: u32) -> Vec<String> {
    let mut cmd = alsa_cmd(tool, device, rate, channels);
    cmd.push(format!("--period-time={}", voice::FRAME_MS * 1000));
    cmd.push(format!("--buffer-time={}", buffer_ms * 1000));
    cmd
}

/// Longest the reader may fall behind before capture overruns.
const VOICE_CAPTURE_BUFFER_MS: u32 = 200;
/// Played audio queued in aplay: room for a late pacer tick, little delay.
const VOICE_PLAYBACK_BUFFER_MS: u32 = 120;

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
                    capture_cmd: voice_cmd("arecord", &device, sample_rate, channels, VOICE_CAPTURE_BUFFER_MS),
                    a2dp_capture_cmd: Some(alsa_cmd("arecord", &a2dp_device, a2dp_sample_rate, a2dp_channels)),
                    playback_cmd: voice_cmd("aplay", &device, sample_rate, channels, VOICE_PLAYBACK_BUFFER_MS),
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
                    capture_cmd: voice_cmd("arecord", &capture_device, sample_rate, channels, VOICE_CAPTURE_BUFFER_MS),
                    a2dp_capture_cmd: None,
                    playback_cmd: voice_cmd("aplay", &playback_device, sample_rate, channels, VOICE_PLAYBACK_BUFFER_MS),
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
    /// Path to host-local per-phone config file keyed by ADB serial
    pub local_config_path: std::path::PathBuf,
    /// Host-local per-phone config. Used for immediate controls such as Wi-Fi.
    pub local_config: tokio::sync::RwLock<HashMap<String, local_config::LocalPhoneConfig>>,
    /// Fleet client for registry communication (None in standalone mode)
    pub fleet_client: Option<Arc<fleet::FleetClient>>,
    /// Outbox for reliable event delivery to registry (None in standalone mode)
    pub outbox: Option<Arc<outbox::Outbox>>,
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
    let bluetooth = matches!(audio_config.backend, AudioBackend::Bluetooth);
    let voice = voice::for_phone(
        &config.id,
        &config.adb_serial,
        config.phone_bt_mac.as_deref(),
        voice::AudioParams {
            sample_rate: audio_config.sample_rate,
            capture_cmd: audio_config.capture_cmd.clone(),
            playback_cmd: audio_config.playback_cmd.clone(),
        },
        bluetooth,
    );
    let events_tx = voice.events_tx.clone();
    let active_sinks = voice.active_sinks.clone();

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

    Arc::new(phone::PhoneState {
        config,
        a2dp_tx,
        voice,
        audio_config: audio_config.clone(),
        snapshot_cache: Mutex::new(Some(api::snapshot::SnapshotCache::default())),
        bridge,
        events_tx,
        active_sinks,
        recording: Arc::new(Mutex::new(None)),
        display: Mutex::new(phone::DisplayResources::default()),
        vnc_clients: std::sync::atomic::AtomicU32::new(0),
        media_clients: std::sync::atomic::AtomicU32::new(0),
        a2dp_capture_running: std::sync::atomic::AtomicBool::new(false),
        monitor_status: Mutex::new(None),
        phone_number_cache: Mutex::new(None),
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
    let local_config_path = std::path::PathBuf::from(
        env::var("LOCAL_PHONE_CONFIG").unwrap_or_else(|_| "/data/otacon/local_config.json".into())
    );
    let local_configs = local_config::load(&local_config_path).await;

    if phone_configs.is_empty() {
        eprintln!("No phones in {config_path:?} — waiting for device-monitor to register via POST /phones");
    }

    // Build phone state map
    let mut phones = HashMap::new();
    for config in &phone_configs {
        let phone_state = create_phone_state(config.clone(), &audio_config);
        eprintln!("Loaded phone '{}' (serial: {})", config.id, config.adb_serial);
        // Kick off phone_number cache population once. ADB shellout, but
        // off the main path — reconciler never re-fires this per tick.
        let ps = phone_state.clone();
        tokio::spawn(async move { ps.refresh_phone_number_cache().await; });
        phones.insert(config.id.clone(), phone_state);
    }

    let (system_events_tx, _) = broadcast::channel::<String>(64);

    let fleet_client = fleet::FleetClient::from_env().map(Arc::new);

    // Initialize outbox if fleet client is configured
    let outbox = if let Some(ref fc) = fleet_client {
        let db_path = std::path::PathBuf::from("/data/otacon/outbox/events.db");
        match outbox::Outbox::init(
            &db_path,
            fc.registry_url().to_string(),
            fc.host_id().to_string(),
        ) {
            Ok(ob) => {
                eprintln!("[outbox] Initialized at {db_path:?}");
                Some(Arc::new(ob))
            }
            Err(e) => {
                eprintln!("[outbox] Failed to initialize: {e} — events will not be persisted");
                None
            }
        }
    } else {
        None
    };

    let state = Arc::new(AppState {
        phones: tokio::sync::RwLock::new(phones),
        system_events_tx,
        config_path,
        local_config_path,
        local_config: tokio::sync::RwLock::new(local_configs),
        fleet_client: fleet_client.clone(),
        outbox,
    });

    // Start lazy VNC proxy listeners for each phone
    for (_id, phone_state) in state.phones.read().await.iter() {
        spawn_vnc_proxy(phone_state.clone());
    }

    // Start fleet client and reconciler if REGISTRY_URL is set
    if let Some(ref fleet_client) = fleet_client {
        fleet::spawn_heartbeat(fleet_client.clone(), state.clone());
        fleet::spawn_config_ws(fleet_client.clone(), state.clone());
        eprintln!("Fleet client enabled");

        // Start reconciler if outbox is available
        if let Some(ref outbox) = state.outbox {
            let reconciler_notify = reconciler::trigger();
            reconciler::spawn(state.clone(), outbox.clone(), reconciler_notify);
            eprintln!("Reconciler enabled");
        }
    } else {
        eprintln!("Fleet client disabled (no REGISTRY_URL)");
    }

    // Periodically reload phones.json to pick up new phones added by fleet-agent.
    // Only adds phones that have never been seen (by serial) during this process
    // lifetime, so disconnected-then-deregistered phones don't get re-added with
    // duplicate VNC port binds.
    {
        let reload_state = state.clone();
        let audio_config_reload = audio_config.clone();
        tokio::spawn(async move {
            let mut known_serials: std::collections::HashSet<String> = {
                let phones = reload_state.phones.read().await;
                phones.values().map(|ps| ps.config.adb_serial.clone()).collect()
            };
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                let configs = phone::load_phones(&reload_state.config_path).await;
                let mut phones = reload_state.phones.write().await;
                for config in configs {
                    if !config.adb_serial.is_empty() && !known_serials.contains(&config.adb_serial) {
                        eprintln!("[reload] New phone detected: '{}' (serial: {})", config.id, config.adb_serial);
                        let phone_state = create_phone_state(config.clone(), &audio_config_reload);
                        spawn_vnc_proxy(phone_state.clone());
                        let ps = phone_state.clone();
                        tokio::spawn(async move { ps.refresh_phone_number_cache().await; });
                        phones.insert(config.id.clone(), phone_state);
                        known_serials.insert(config.adb_serial.clone());
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
            let mut msg = serde_json::json!({
                "type": "audio.sink.active",
                "ts": chrono::Utc::now().timestamp_millis(),
            });
            if let (Some(o), Some(d)) = (msg.as_object_mut(), event_data.as_object()) {
                o.extend(d.clone());
            }
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
