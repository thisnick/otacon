use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex};

use crate::api;

/// Persisted phone configuration.
/// Fields use serde defaults so partial entries (e.g. written by device-monitor
/// before the Rust server fills in full config) can still be deserialized.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhoneConfig {
    /// URL-safe slug: "phone-a", auto-generated or user-assigned
    #[serde(default)]
    pub id: String,
    /// ADB serial from `adb devices` — stable across reboots
    #[serde(default)]
    pub adb_serial: String,
    /// Bluetooth dongle MAC (permanent, survives hci reorder)
    pub adapter_mac: Option<String>,
    /// Phone's Bluetooth MAC (learned during pairing)
    pub phone_bt_mac: Option<String>,
    /// Xvfb display number (50, 51, 52...)
    #[serde(default = "default_display_num")]
    pub display_num: u16,
    /// VNC port (5900, 5901, 5902...)
    #[serde(default = "default_vnc_port")]
    pub vnc_port: u16,
    /// Snapshot server forward port (9091, 9092...)
    #[serde(default = "default_snapshot_port")]
    pub snapshot_port: u16,
    /// Internal push-event port (8081, 8082...)
    #[serde(default = "default_internal_port")]
    pub internal_port: u16,
    /// Audio backend: "bluetooth" or "alsa"
    #[serde(default = "default_audio_backend")]
    pub audio_backend: String,
}

fn default_display_num() -> u16 { 50 }
fn default_vnc_port() -> u16 { 5900 }
fn default_snapshot_port() -> u16 { 9091 }
fn default_internal_port() -> u16 { 8081 }
fn default_audio_backend() -> String { "alsa".into() }

/// Lazy resource management for a phone's display (Xvnc + scrcpy).
pub struct DisplayResources {
    /// Xvnc process
    pub xvnc: Option<tokio::process::Child>,
    /// scrcpy process
    pub scrcpy: Option<tokio::process::Child>,
    /// Whether display is currently running
    pub running: bool,
}

impl Default for DisplayResources {
    fn default() -> Self {
        Self { xvnc: None, scrcpy: None, running: false }
    }
}

/// Per-phone runtime state (extracted from the former AppState).
pub struct PhoneState {
    pub config: PhoneConfig,
    /// Broadcast channel for captured audio (Pi mic → clients)
    pub capture_tx: broadcast::Sender<Vec<u8>>,
    /// Broadcast channel for A2DP media audio (phone → clients)
    pub a2dp_tx: Option<broadcast::Sender<Vec<u8>>>,
    /// Mutex protecting the single playback sender slot
    pub playback_owner: Mutex<Option<u64>>,
    /// Audio configuration
    pub audio_config: crate::AudioConfig,
    /// Cached accessibility snapshot for ref lookups (ADB fallback)
    pub snapshot_cache: Mutex<Option<api::snapshot::SnapshotCache>>,
    /// Bridge to device owner app's HTTP server
    pub bridge: Arc<api::bridge::BridgeState>,
    /// Broadcast channel for JSON event messages (sink state, etc.)
    pub events_tx: broadcast::Sender<String>,
    /// Currently active audio sinks (D-Bus path → event data)
    pub active_sinks: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    /// Screen recording state
    pub recording: api::record::RecordingState,
    /// Simulated call state for testing without hardware
    pub sim_call: Mutex<api::test_sim::SimCallState>,
    /// Whether /ws/audio/call has an active client (single-consumer enforcement)
    pub call_audio_occupied: AtomicBool,
    /// Display resources (Xvnc + scrcpy) — lazy lifecycle
    pub display: Mutex<DisplayResources>,
    /// Number of active VNC clients connected to the proxy
    pub vnc_clients: AtomicU32,
    /// Number of active audio capture subscribers (HFP call audio)
    pub capture_clients: AtomicU32,
    /// Number of active A2DP media audio subscribers
    pub media_clients: AtomicU32,
    /// Whether audio capture task is running
    pub capture_running: AtomicBool,
    /// Whether A2DP capture task is running
    pub a2dp_capture_running: AtomicBool,
}

impl PhoneState {
    /// Start the display (Xvnc + scrcpy) if not already running.
    pub async fn ensure_display(&self) -> Result<(), String> {
        let mut display = self.display.lock().await;
        if display.running {
            return Ok(());
        }

        let config = &self.config;
        let display_str = format!(":{}", config.display_num);

        // Detect phone resolution for scrcpy
        let (display_w, display_h) = detect_resolution(&config.adb_serial).await;
        let resolution = format!("{display_w}x{display_h}");

        let vnc_auth = std::env::var("VNC_AUTH_ARGS")
            .unwrap_or_else(|_| "-SecurityTypes None".into());

        // Clean up stale X lock files
        let lock_file = format!("/tmp/.X{}-lock", config.display_num);
        let socket_file = format!("/tmp/.X11-unix/X{}", config.display_num);
        for f in [&lock_file, &socket_file] {
            let _ = tokio::fs::remove_file(f).await;
        }

        // Start Xvnc
        // Internal VNC port (proxy binds the public port)
        let internal_vnc_port = config.vnc_port + 1000;
        let mut xvnc_args = vec![
            display_str.clone(),
            "-geometry".into(), resolution,
            "-depth".into(), "24".into(),
            "-rfbport".into(), internal_vnc_port.to_string(),
        ];
        for arg in vnc_auth.split_whitespace() {
            xvnc_args.push(arg.into());
        }
        xvnc_args.extend_from_slice(&[
            "-localhost".into(), "no".into(), "-AlwaysShared".into(),
        ]);

        eprintln!("[{}] Starting Xvnc on display {} port {}", config.id, display_str, config.vnc_port);
        let xvnc = tokio::process::Command::new("Xvnc")
            .args(&xvnc_args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Xvnc: {e}"))?;

        // Wait for VNC port (internal)
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if tokio::net::TcpStream::connect(("127.0.0.1", internal_vnc_port)).await.is_ok() {
                break;
            }
        }

        // Set cursor
        let _ = tokio::process::Command::new("xsetroot")
            .args(["-cursor_name", "left_ptr"])
            .env("DISPLAY", &display_str)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        // Start scrcpy
        let max_fps = std::env::var("SCRCPY_MAX_FPS").unwrap_or_else(|_| "15".into());
        let bitrate = std::env::var("SCRCPY_BITRATE").unwrap_or_else(|_| "2M".into());

        eprintln!("[{}] Starting scrcpy on {} ({}x{})", config.id, display_str, display_w, display_h);
        let scrcpy = tokio::process::Command::new("scrcpy")
            .args([
                "--serial", &config.adb_serial,
                "--no-audio",
                "--max-fps", &max_fps,
                "-b", &bitrate,
                "--render-driver=opengl",
                "--window-width", &display_w.to_string(),
                "--window-height", &display_h.to_string(),
                "--window-borderless",
                "--window-x", "0", "--window-y", "0",
            ])
            .env("DISPLAY", &display_str)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("scrcpy: {e}"))?;

        display.xvnc = Some(xvnc);
        display.scrcpy = Some(scrcpy);
        display.running = true;

        Ok(())
    }

    /// Stop the display (Xvnc + scrcpy).
    pub async fn stop_display(&self) {
        let mut display = self.display.lock().await;
        if !display.running {
            return;
        }
        eprintln!("[{}] Stopping display", self.config.id);
        if let Some(ref mut proc) = display.xvnc {
            let _ = proc.kill().await;
        }
        if let Some(ref mut proc) = display.scrcpy {
            let _ = proc.kill().await;
        }
        display.xvnc = None;
        display.scrcpy = None;
        display.running = false;
    }
}

/// Detect phone resolution, scaling down for scrcpy display.
async fn detect_resolution(serial: &str) -> (u32, u32) {
    let output = tokio::process::Command::new("adb")
        .args(["-s", serial, "shell", "wm", "size"])
        .output()
        .await;

    let (phone_w, phone_h) = match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let re = regex::Regex::new(r"(\d+)x(\d+)").unwrap();
            if let Some(caps) = re.captures(&stdout) {
                (caps[1].parse::<u32>().unwrap_or(1080),
                 caps[2].parse::<u32>().unwrap_or(2400))
            } else {
                (1080, 2400)
            }
        }
        Err(_) => (1080, 2400),
    };

    let max_size: u32 = std::env::var("SCRCPY_MAX_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(800);
    let scale = max_size as f64 / phone_w.max(phone_h) as f64;
    let w = ((phone_w as f64 * scale) as u32) / 2 * 2; // make even
    let h = ((phone_h as f64 * scale) as u32) / 2 * 2;
    (w.max(2), h.max(2))
}

/// Load phone configs from a JSON file. Returns empty vec if file doesn't exist.
pub async fn load_phones(path: &std::path::Path) -> Vec<PhoneConfig> {
    match tokio::fs::read_to_string(path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Save phone configs to a JSON file.
pub async fn save_phones(path: &std::path::Path, phones: &[PhoneConfig]) -> std::io::Result<()> {
    let data = serde_json::to_string_pretty(phones)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    tokio::fs::write(path, data).await
}
