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
    /// Registry-assigned ID (metadata only — not the AppState key)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_id: Option<String>,
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
    /// Fleet-agent monitor status (pushed via internal event channel)
    pub monitor_status: Mutex<Option<serde_json::Value>>,
    /// Cached phone_number (E.164). Populated lazily from ADB once after the
    /// phone is connected; refreshed only on phone-add/reconnect lifecycle —
    /// reconciler reads this without shelling out to ADB per heartbeat tick.
    pub phone_number_cache: Mutex<Option<String>>,
}

/// Backoff schedule for the phone_number populator. Exposed so tests can
/// reuse the schedule shape without sleeping. Values cap at ~2.5 minutes —
/// long enough to outlast container-startup ADB races + snapshot bridge
/// boot, short enough that a phone genuinely missing a number is reported
/// as None within bounded time.
pub const PHONE_NUMBER_BACKOFF_SECS: &[u64] = &[5, 10, 20, 40, 80];

/// Pure retry loop. Calls `attempt` up to `delays.len() + 1` times: first
/// immediately, then once after each delay until one returns Some. No-op if
/// `already_have` is true. Returns the populated value (or None if every
/// attempt failed). Generic over the sleeper so tests don't real-sleep.
pub async fn populate_with_retry<F, Fut, S, SF>(
    already_have: bool,
    delays: &[u64],
    mut attempt: F,
    mut sleeper: S,
) -> Option<String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
    S: FnMut(u64) -> SF,
    SF: std::future::Future<Output = ()>,
{
    if already_have {
        return None;
    }
    if let Some(v) = attempt().await {
        return Some(v);
    }
    for &secs in delays {
        sleeper(secs).await;
        if let Some(v) = attempt().await {
            return Some(v);
        }
    }
    None
}

impl PhoneState {
    /// Refresh the cached phone_number by querying ADB. Retries with
    /// exponential backoff to ride out container-startup ADB races and the
    /// snapshot bridge coming online late. Once populated stays populated
    /// for the process lifetime — caller (phone-add lifecycle) is the only
    /// way to refresh, which matches reconciler-doesn't-shellout invariant.
    pub async fn refresh_phone_number_cache(&self) {
        let already_have = self.phone_number_cache.lock().await.is_some();
        let phone_id = self.config.id.clone();
        let result = populate_with_retry(
            already_have,
            PHONE_NUMBER_BACKOFF_SECS,
            || async {
                match crate::api::device::get_phone_number(self).await {
                    Ok(num) => Some(num),
                    Err(e) => {
                        eprintln!("[{}] phone_number lookup failed (will retry): {:?}", phone_id, e);
                        None
                    }
                }
            },
            |secs| async move {
                tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
            },
        ).await;

        if let Some(num) = result {
            eprintln!("[{}] phone_number cache populated: {}", phone_id, num);
            *self.phone_number_cache.lock().await = Some(num);
        } else if !already_have {
            eprintln!(
                "[{}] phone_number retry budget exhausted; cache stays None (phone may have no SIM)",
                phone_id,
            );
        }
    }

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
                "--capture-orientation=@0",
                "--max-fps", &max_fps,
                "-b", &bitrate,
                // 1s keyframe interval — recovers from frame drops in <1s
                // instead of scrcpy default ~10s, which leaves persistent
                // decoder smear on flaky links / phones under memory pressure.
                "--video-codec-options=i-frame-interval=1",
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
///
/// On load, drops duplicate entries whose `id` matches the registry-assigned
/// format (`phone-\d+`) when another entry with the same `adb_serial` exists
/// under a local-format ID. This cleans up stale duplicates from the bug where
/// registry IDs were inserted as separate phone entries.
pub async fn load_phones(path: &std::path::Path) -> Vec<PhoneConfig> {
    let mut phones: Vec<PhoneConfig> = match tokio::fs::read_to_string(path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => return Vec::new(),
    };

    // Collect serials that have a local-format ID (not matching phone-\d+)
    let registry_id_re = regex::Regex::new(r"^phone-\d+$").unwrap();
    let local_serials: std::collections::HashSet<String> = phones.iter()
        .filter(|p| !p.adb_serial.is_empty() && !registry_id_re.is_match(&p.id))
        .map(|p| p.adb_serial.clone())
        .collect();

    let before = phones.len();
    phones.retain(|p| {
        // Keep if not a registry-format ID
        if !registry_id_re.is_match(&p.id) {
            return true;
        }
        // Drop if a local-format entry exists for the same serial
        if local_serials.contains(&p.adb_serial) {
            eprintln!("Dropping duplicate registry-ID entry '{}' (serial {} has local entry)", p.id, p.adb_serial);
            return false;
        }
        true
    });

    if phones.len() < before {
        eprintln!("Cleaned up {} duplicate phone entries from {}", before - phones.len(), path.display());
        // Persist the cleaned-up list
        save_phones(path, &phones).await.ok();
    }

    phones
}

/// Save phone configs to a JSON file.
///
/// Merges with on-disk content to avoid truncating entries added by other
/// processes (e.g. fleet-agent Python). Entries are matched by adb_serial;
/// in-memory values take precedence for known serials, but disk-only entries
/// are preserved. Writes atomically via tmp+rename.
pub async fn save_phones(path: &std::path::Path, phones: &[PhoneConfig]) -> std::io::Result<()> {
    use std::collections::HashSet;
    use tokio::io::AsyncWriteExt;

    // Read existing on-disk entries
    let on_disk: Vec<PhoneConfig> = match tokio::fs::read_to_string(path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    // Build set of serials we're writing
    let known_serials: HashSet<&str> = phones.iter()
        .map(|p| p.adb_serial.as_str())
        .collect();

    // Start with our in-memory phones, then append disk-only entries
    let mut merged: Vec<PhoneConfig> = phones.to_vec();
    for disk_phone in on_disk {
        if !disk_phone.adb_serial.is_empty() && !known_serials.contains(disk_phone.adb_serial.as_str()) {
            merged.push(disk_phone);
        }
    }

    let data = serde_json::to_string_pretty(&merged)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    // Ensure parent directory exists
    let dir = path.parent().unwrap_or(std::path::Path::new("."));
    tokio::fs::create_dir_all(dir).await.ok();

    // Atomic write: tmp file + fsync + rename
    let tmp_path = dir.join(format!(".phones_tmp_{}", std::process::id()));
    let mut f = tokio::fs::File::create(&tmp_path).await?;
    f.write_all(data.as_bytes()).await?;
    f.sync_all().await?;
    tokio::fs::rename(&tmp_path, path).await?;
    Ok(())
}

#[cfg(test)]
mod populate_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, AtomicU64, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn returns_some_on_first_try_no_retries() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let slept = Arc::new(AtomicU64::new(0));
        let a = attempts.clone();
        let s = slept.clone();
        let got = populate_with_retry(
            false,
            &[1, 2, 3],
            move || {
                let a = a.clone();
                async move {
                    a.fetch_add(1, Ordering::SeqCst);
                    Some("+15551234567".to_string())
                }
            },
            move |secs| {
                let s = s.clone();
                async move { s.fetch_add(secs, Ordering::SeqCst); }
            },
        ).await;
        assert_eq!(got.as_deref(), Some("+15551234567"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(slept.load(Ordering::SeqCst), 0, "should not sleep on first-try success");
    }

    #[tokio::test]
    async fn returns_some_on_second_try_one_retry() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let slept = Arc::new(AtomicU64::new(0));
        let a = attempts.clone();
        let s = slept.clone();
        let got = populate_with_retry(
            false,
            &[5, 10, 20],
            move || {
                let a = a.clone();
                async move {
                    let n = a.fetch_add(1, Ordering::SeqCst) + 1;
                    if n == 1 { None } else { Some("+15559999999".to_string()) }
                }
            },
            move |secs| {
                let s = s.clone();
                async move { s.fetch_add(secs, Ordering::SeqCst); }
            },
        ).await;
        assert_eq!(got.as_deref(), Some("+15559999999"));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(slept.load(Ordering::SeqCst), 5, "exactly one backoff slot consumed");
    }

    #[tokio::test]
    async fn returns_none_when_all_attempts_fail() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let slept = Arc::new(AtomicU64::new(0));
        let a = attempts.clone();
        let s = slept.clone();
        let got = populate_with_retry(
            false,
            &[1, 2, 3, 4, 5],
            move || {
                let a = a.clone();
                async move {
                    a.fetch_add(1, Ordering::SeqCst);
                    None
                }
            },
            move |secs| {
                let s = s.clone();
                async move { s.fetch_add(secs, Ordering::SeqCst); }
            },
        ).await;
        assert!(got.is_none());
        // delays.len() + 1 = 6 attempts total
        assert_eq!(attempts.load(Ordering::SeqCst), 6);
        assert_eq!(slept.load(Ordering::SeqCst), 1 + 2 + 3 + 4 + 5);
    }

    #[tokio::test]
    async fn already_have_short_circuits() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let slept = Arc::new(AtomicU64::new(0));
        let a = attempts.clone();
        let s = slept.clone();
        let got = populate_with_retry(
            true,
            &[5, 10, 20],
            move || {
                let a = a.clone();
                async move {
                    a.fetch_add(1, Ordering::SeqCst);
                    Some("+15551111111".to_string())
                }
            },
            move |secs| {
                let s = s.clone();
                async move { s.fetch_add(secs, Ordering::SeqCst); }
            },
        ).await;
        assert!(got.is_none(), "should not produce a fresh value when cache is already populated");
        assert_eq!(attempts.load(Ordering::SeqCst), 0, "should not call the fetcher at all");
        assert_eq!(slept.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn backoff_schedule_caps_around_two_and_a_half_minutes() {
        // The schedule the populator actually uses must be bounded —
        // a phone genuinely without a SIM should be reported None within a
        // sensible window so the registry doesn't show stale "still trying".
        let total: u64 = PHONE_NUMBER_BACKOFF_SECS.iter().sum();
        assert!(total >= 60, "schedule too short to outlast startup: {total}s");
        assert!(total <= 300, "schedule too long, callers will appear stuck: {total}s");
    }
}
