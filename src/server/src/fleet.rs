//! Fleet client — connects to the central registry for host/phone tracking.
//!
//! If `REGISTRY_URL` is not set, fleet features are disabled (standalone mode).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::AppState;

pub struct FleetClient {
    registry_url: String,
    host_id: String,
    client: reqwest::Client,
    /// Maps local phone ID → registry phone ID (they may differ)
    registry_ids: Mutex<HashMap<String, String>>,
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
        })
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

        match self.client
            .post(format!("{}/api/v1/hosts/register", self.registry_url))
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

        let body = serde_json::json!({
            "host_id": self.host_id,
            "phones": phone_ids,
            "dongles": [],
        });

        if let Err(e) = self.client
            .post(format!("{}/api/v1/hosts/heartbeat", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            eprintln!("[fleet] Heartbeat error: {e}");
        }
    }

    /// Register a phone with the registry. Stores the registry-assigned phone_id.
    pub async fn register_phone(&self, local_id: &str, serial: &str) {
        let body = serde_json::json!({
            "host_id": self.host_id,
            "adb_serial": serial,
        });

        match self.client
            .post(format!("{}/api/v1/phones/register", self.registry_url))
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

        if let Err(e) = self.client
            .post(format!("{}/api/v1/events", self.registry_url))
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

        if let Err(e) = self.client
            .post(format!("{}/api/v1/phones/deregister", self.registry_url))
            .json(&body)
            .send()
            .await
        {
            eprintln!("[fleet] Phone deregistration error for '{local_id}': {e}");
        }
    }
}

/// Spawn the fleet heartbeat loop as a background task.
pub fn spawn_heartbeat(fleet: Arc<FleetClient>, state: Arc<AppState>) {
    tokio::spawn(async move {
        fleet.register_host().await;

        // Register all initially connected phones
        {
            let phones = state.phones.read().await;
            for (id, ps) in phones.iter() {
                fleet.register_phone(id, &ps.config.adb_serial).await;
            }
        }

        // Heartbeat every 30 seconds
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            fleet.heartbeat(&state).await;
        }
    });
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
