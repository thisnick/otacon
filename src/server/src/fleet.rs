//! Fleet client — connects to the central registry for host/phone tracking.
//!
//! If `REGISTRY_URL` is not set, fleet features are disabled (standalone mode).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::AppState;

/// Path to the auth token file (shared with fleet-agent Python process).
const AUTH_FILE: &str = "/etc/otacon/auth.json";

pub struct FleetClient {
    registry_url: String,
    host_id: String,
    client: reqwest::Client,
    /// Maps local phone ID → registry phone ID (they may differ)
    registry_ids: Mutex<HashMap<String, String>>,
    /// Dongle IDs reported to the registry (for heartbeat)
    dongle_ids: Mutex<Vec<String>>,
}

/// Load the bearer token from the auth file on disk.
/// Returns None if the file doesn't exist or can't be parsed.
fn load_auth_token() -> Option<String> {
    let data = std::fs::read_to_string(AUTH_FILE).ok()?;
    let json: serde_json::Value = serde_json::from_str(&data).ok()?;
    json.get("token")?.as_str().map(|s| s.to_string())
}

impl FleetClient {
    pub fn from_env() -> Option<Self> {
        let registry_url = std::env::var("REGISTRY_URL").ok()?;
        let host_id = std::env::var("HOST_ID").unwrap_or_else(|_| {
            gethostname().unwrap_or_else(|| "unknown".into())
        });

        Some(Self {
            registry_url: registry_url.trim_end_matches('/').to_string(),
            host_id,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            registry_ids: Mutex::new(HashMap::new()),
            dongle_ids: Mutex::new(Vec::new()),
        })
    }

    /// Build a POST request with auth header (if token is available).
    fn authed_post(&self, url: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.post(url);
        if let Some(token) = load_auth_token() {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        req
    }

    /// Register this host with the registry.
    pub async fn register_host(&self) {
        let tailscale_ip = get_tailscale_ip().await;
        let fqdn = get_tailscale_fqdn().await;
        let api_port: u16 = std::env::var("AUDIO_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8080);

        let body = serde_json::json!({
            "id": self.host_id,
            "tailscale_ip": tailscale_ip,
            "fqdn": fqdn,
            "api_port": api_port,
        });

        match self.authed_post(&format!("{}/api/v1/hosts/register", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                eprintln!("[fleet] Registered host '{}' with registry", self.host_id);
            }
            Ok(resp) => {
                eprintln!("[fleet] Host registration failed: {}", resp.status());
            }
            Err(e) => {
                eprintln!("[fleet] Host registration error: {e}");
            }
        }
    }

    /// Enumerate BT adapters via bluetoothctl and report them to the registry.
    pub async fn report_dongles(&self, state: &AppState) {
        let adapters = enumerate_bt_adapters().await;
        if adapters.is_empty() {
            eprintln!("[fleet] No BT adapters found to report");
            return;
        }

        // Try to match adapters to phones by adapter_mac
        let phones = state.phones.read().await;
        let dongles: Vec<serde_json::Value> = adapters.iter().map(|(mac, hci)| {
            let phone_id = phones.values()
                .find(|ps| ps.config.adapter_mac.as_deref()
                    .map(|m| m.eq_ignore_ascii_case(mac))
                    .unwrap_or(false))
                .map(|ps| ps.config.id.clone());
            serde_json::json!({
                "bt_mac": mac,
                "hci_device": hci,
                "phone_id": phone_id,
            })
        }).collect();
        drop(phones);

        let body = serde_json::json!({
            "host_id": self.host_id,
            "dongles": dongles,
        });

        match self.authed_post(&format!("{}/api/v1/dongles/register", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                // Store dongle IDs for heartbeat (format: dongle-<last6hex>)
                let ids: Vec<String> = adapters.iter().map(|(mac, _)| {
                    let slug = mac.replace(':', "").to_lowercase();
                    format!("dongle-{}", &slug[slug.len().saturating_sub(6)..])
                }).collect();
                eprintln!("[fleet] Reported {} dongles: {:?}", ids.len(), ids);
                *self.dongle_ids.lock().await = ids;
            }
            Ok(resp) => {
                eprintln!("[fleet] Dongle registration failed: {}", resp.status());
            }
            Err(e) => {
                eprintln!("[fleet] Dongle registration error: {e}");
            }
        }
    }

    /// Send a heartbeat with the list of connected phones and dongles.
    pub async fn heartbeat(&self, state: &AppState) {
        let phones = state.phones.read().await;
        let local_ids: Vec<String> = phones.keys().cloned().collect();
        drop(phones);

        // Map local IDs to registry IDs for the heartbeat
        let reg_ids = self.registry_ids.lock().await;
        let phone_ids: Vec<String> = local_ids.iter()
            .filter_map(|local| reg_ids.get(local).cloned())
            .collect();
        drop(reg_ids);

        // Build dongle IDs from last-known adapters
        let dongle_ids = self.dongle_ids.lock().await.clone();

        let body = serde_json::json!({
            "host_id": self.host_id,
            "phones": phone_ids,
            "dongles": dongle_ids,
        });

        match self.authed_post(&format!("{}/api/v1/hosts/heartbeat", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if !resp.status().is_success() => {
                eprintln!("[fleet] Heartbeat failed: {}", resp.status());
            }
            Err(e) => {
                eprintln!("[fleet] Heartbeat error: {e}");
            }
            _ => {}
        }
    }

    /// Register a phone with the registry. Stores the registry-assigned phone_id.
    pub async fn register_phone(&self, local_id: &str, config: &crate::phone::PhoneConfig) {
        let body = serde_json::json!({
            "host_id": self.host_id,
            "adb_serial": config.adb_serial,
            "adapter_mac": config.adapter_mac,
        });

        match self.authed_post(&format!("{}/api/v1/phones/register", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(reg_id) = data.get("phone_id").and_then(|v| v.as_str()) {
                        self.registry_ids.lock().await
                            .insert(local_id.to_string(), reg_id.to_string());
                        eprintln!("[fleet] Registered phone '{local_id}' as '{reg_id}' in registry");
                    }
                } else {
                    eprintln!("[fleet] Registered phone '{local_id}' (no phone_id in response)");
                }
            }
            Ok(resp) => {
                eprintln!("[fleet] Phone registration failed for '{local_id}': {}", resp.status());
            }
            Err(e) => {
                eprintln!("[fleet] Phone registration error for '{local_id}': {e}");
            }
        }
    }

    /// Report an error/event to the registry (fire and forget).
    pub async fn report_error(
        &self,
        phone_id: Option<&str>,
        category: &str,
        message: &str,
    ) {
        let body = serde_json::json!({
            "host_id": self.host_id,
            "phone_id": phone_id,
            "severity": "error",
            "category": category,
            "message": message,
        });

        if let Err(e) = self.authed_post(&format!("{}/api/v1/events", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            eprintln!("[fleet] Error report failed: {e}");
        }
    }

    /// Deregister a phone from the registry.
    pub async fn deregister_phone(&self, local_id: &str) {
        let reg_id = self.registry_ids.lock().await
            .remove(local_id)
            .unwrap_or_else(|| local_id.to_string());

        let body = serde_json::json!({
            "host_id": self.host_id,
            "phone_id": reg_id,
        });

        if let Err(e) = self.authed_post(&format!("{}/api/v1/phones/deregister", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            eprintln!("[fleet] Phone deregistration error for '{local_id}': {e}");
        }
    }

    /// Build the WebSocket URL for the host config channel.
    pub fn config_ws_url(&self) -> String {
        let base = self.registry_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        format!("{base}/ws/host/config?host_id={}", self.host_id)
    }
}

/// Spawn the fleet heartbeat loop as a background task.
pub fn spawn_heartbeat(fleet: Arc<FleetClient>, state: Arc<AppState>) {
    let fleet_dongle = fleet.clone();
    let state_dongle = state.clone();

    tokio::spawn(async move {
        fleet.register_host().await;

        // Register all initially connected phones
        {
            let phones = state.phones.read().await;
            for (id, ps) in phones.iter() {
                fleet.register_phone(id, &ps.config).await;
            }
        }

        // Heartbeat every 30 seconds
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            fleet.heartbeat(&state).await;
        }
    });

    // Report dongles in a separate task so it can't block phone registration
    // or heartbeats (bluetoothctl can hang if bluetoothd isn't ready yet).
    tokio::spawn(async move {
        // Give bluetoothd a moment to start
        tokio::time::sleep(Duration::from_secs(5)).await;
        fleet_dongle.report_dongles(&state_dongle).await;
    });
}

/// Config push message from the registry (matches registry's ConfigPush).
#[derive(serde::Deserialize, Debug)]
struct ConfigPush {
    #[serde(rename = "type")]
    msg_type: String,
    phone_id: String,
    config: RegistryPhoneConfig,
}

/// Phone config fields pushed from the registry.
#[derive(serde::Deserialize, Debug)]
struct RegistryPhoneConfig {
    wifi_enabled: bool,
    bluetooth_enabled: bool,
}

/// Spawn the config WebSocket consumer with reconnect-on-failure.
pub fn spawn_config_ws(fleet: Arc<FleetClient>, state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        let max_backoff = Duration::from_secs(60);

        loop {
            let url = fleet.config_ws_url();
            eprintln!("[fleet] Connecting to config WS: {url}");

            // Build a WS request with auth header so the upgrade passes
            // the registry's node_auth middleware.  Only set Authorization;
            // let tungstenite handle all WS handshake headers (Connection,
            // Upgrade, Sec-WebSocket-*).
            let connect_result = {
                let mut builder = axum::http::Request::builder().uri(&url);
                if let Some(token) = load_auth_token() {
                    builder = builder.header("Authorization", format!("Bearer {token}"));
                }
                match builder.body(()) {
                    Ok(req) => tokio_tungstenite::connect_async(req).await,
                    Err(_) => tokio_tungstenite::connect_async(&url).await,
                }
            };
            match connect_result {
                Ok((ws_stream, _)) => {
                    eprintln!("[fleet] Config WS connected");
                    backoff = Duration::from_secs(1); // reset on success

                    if let Err(e) = handle_config_ws(ws_stream, &fleet, &state).await {
                        eprintln!("[fleet] Config WS error: {e}");
                    }

                    eprintln!("[fleet] Config WS disconnected, reconnecting in {backoff:?}");
                }
                Err(e) => {
                    eprintln!("[fleet] Config WS connect failed: {e}, retrying in {backoff:?}");
                }
            }

            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(max_backoff);
        }
    });
}

async fn handle_config_ws(
    ws_stream: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    fleet: &FleetClient,
    state: &AppState,
) -> Result<(), String> {
    use futures::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let (_tx, mut rx) = ws_stream.split();

    while let Some(msg) = rx.next().await {
        let msg = msg.map_err(|e| format!("ws recv: {e}"))?;

        match msg {
            Message::Text(text) => {
                match serde_json::from_str::<ConfigPush>(&text) {
                    Ok(push) if push.msg_type == "config_update" => {
                        eprintln!("[fleet] Config push for phone '{}': wifi={}, bt={}",
                            push.phone_id, push.config.wifi_enabled, push.config.bluetooth_enabled);

                        // Find the ADB serial for this phone
                        let serial = find_serial_for_phone(fleet, state, &push.phone_id).await;
                        if let Some(serial) = serial {
                            apply_config(&serial, &push.config).await;
                        } else {
                            eprintln!("[fleet] Phone '{}' not found on this host, ignoring config push", push.phone_id);
                        }
                    }
                    Ok(push) => {
                        eprintln!("[fleet] Unknown config WS message type: {}", push.msg_type);
                    }
                    Err(e) => {
                        eprintln!("[fleet] Failed to parse config push: {e} (raw: {text})");
                    }
                }
            }
            Message::Close(_) => {
                return Ok(());
            }
            _ => {} // ping/pong handled by tungstenite
        }
    }

    Ok(())
}

/// Find the ADB serial for a registry phone_id on this host.
async fn find_serial_for_phone(fleet: &FleetClient, state: &AppState, registry_phone_id: &str) -> Option<String> {
    // Look up local phone ID from registry ID mapping
    let reg_ids = fleet.registry_ids.lock().await;
    let local_id = reg_ids.iter()
        .find(|(_, reg_id)| reg_id.as_str() == registry_phone_id)
        .map(|(local, _)| local.clone());
    drop(reg_ids);

    let phones = state.phones.read().await;
    if let Some(local_id) = local_id {
        phones.get(&local_id).map(|ps| ps.config.adb_serial.clone())
    } else {
        // Try direct match (local_id == registry_id)
        phones.get(registry_phone_id).map(|ps| ps.config.adb_serial.clone())
    }
}

/// Apply WiFi and Bluetooth config to a phone via ADB.
async fn apply_config(serial: &str, config: &RegistryPhoneConfig) {
    let wifi_arg = if config.wifi_enabled { "enable" } else { "disable" };
    let bt_arg = if config.bluetooth_enabled { "enable" } else { "disable" };

    eprintln!("[fleet] Applying config to {serial}: wifi {wifi_arg}, bluetooth {bt_arg}");

    let wifi_result = tokio::process::Command::new("adb")
        .args(["-s", serial, "shell", "svc", "wifi", wifi_arg])
        .output()
        .await;
    if let Err(e) = wifi_result {
        eprintln!("[fleet] Failed to set wifi on {serial}: {e}");
    }

    let bt_result = tokio::process::Command::new("adb")
        .args(["-s", serial, "shell", "svc", "bluetooth", bt_arg])
        .output()
        .await;
    if let Err(e) = bt_result {
        eprintln!("[fleet] Failed to set bluetooth on {serial}: {e}");
    }
}

/// Enumerate Bluetooth adapters via `bluetoothctl list`.
/// Returns a list of (MAC address, hci device name) pairs.
async fn enumerate_bt_adapters() -> Vec<(String, String)> {
    eprintln!("[fleet] Enumerating BT adapters via bluetoothctl...");

    let output = match tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new("bluetoothctl")
            .args(["list"])
            .output(),
    ).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            eprintln!("[fleet] Failed to run bluetoothctl list: {e}");
            return Vec::new();
        }
        Err(_) => {
            eprintln!("[fleet] bluetoothctl list timed out after 10s");
            return Vec::new();
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[fleet] bluetoothctl list failed ({}): {}", output.status, stderr.trim());
        return Vec::new();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    eprintln!("[fleet] bluetoothctl list output: {}", stdout.trim());

    // Each line looks like: "Controller F4:4E:FC:59:A6:09 otacon-pi [default]"
    let mut adapters = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[0] == "Controller" {
            let mac = parts[1].to_string();
            // Try to get the hci device name by matching the MAC via hciconfig
            let hci = get_hci_for_mac(&mac).await
                .unwrap_or_else(|| parts[2].to_string());
            adapters.push((mac, hci));
        }
    }

    eprintln!("[fleet] Found {} BT adapters", adapters.len());
    adapters
}

/// Map a BT adapter MAC to its hciN device name via `hciconfig`.
async fn get_hci_for_mac(mac: &str) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("hciconfig").output(),
    ).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_hci: Option<String> = None;
    let mac_upper = mac.to_uppercase();

    for line in stdout.lines() {
        let trimmed = line.trim();
        // Lines like "hci0:   Type: Primary  Bus: USB"
        if !trimmed.is_empty() && !line.starts_with('\t') && !line.starts_with(' ') {
            current_hci = trimmed.split(':').next().map(|s| s.to_string());
        }
        // Lines like "        BD Address: F4:4E:FC:59:A6:09  ACL MTU: ..."
        if trimmed.contains("BD Address:") && trimmed.contains(&mac_upper) {
            return current_hci;
        }
    }

    None
}

fn gethostname() -> Option<String> {
    let mut buf = [0u8; 256];
    let ret = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut _, buf.len()) };
    if ret == 0 {
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        Some(String::from_utf8_lossy(&buf[..end]).to_string())
    } else {
        None
    }
}

async fn get_tailscale_ip() -> Option<String> {
    let output = tokio::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

async fn get_tailscale_fqdn() -> Option<String> {
    let output = tokio::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
        json.get("Self")?.get("DNSName")?.as_str()
            .map(|s| s.trim_end_matches('.').to_string())
    } else {
        None
    }
}
