use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::adb::adb_shell;
use super::ApiError;

/// Snapshot server (app_process) — UI tree, actions
const SNAPSHOT_URL: &str = "http://127.0.0.1:9091";

/// ContentProvider authority for device owner app
const KIOSK_AUTHORITY: &str = "com.otacon.kiosk";

const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

pub struct BridgeState {
    client: reqwest::Client,
    /// Device owner app is available (ContentProvider)
    device_owner_available: AtomicBool,
    /// Snapshot server is available (UI tree, actions)
    snapshot_available: AtomicBool,
}

impl BridgeState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            client,
            device_owner_available: AtomicBool::new(false),
            snapshot_available: AtomicBool::new(false),
        }
    }

    /// Is the device owner app available? (ContentProvider)
    pub fn is_device_owner_available(&self) -> bool {
        self.device_owner_available.load(Ordering::Relaxed)
    }

    /// Is the snapshot server available? (UI tree, actions)
    pub fn is_snapshot_available(&self) -> bool {
        self.snapshot_available.load(Ordering::Relaxed)
    }

    /// GET from the snapshot server.
    pub async fn snapshot_get(&self, path: &str) -> Result<String, ApiError> {
        http_get(&self.client, SNAPSHOT_URL, path).await
    }

    /// POST to the snapshot server.
    pub async fn snapshot_post(&self, path: &str, body: &str) -> Result<String, ApiError> {
        http_post(&self.client, SNAPSHOT_URL, path, body).await
    }

    /// Query the device owner ContentProvider via ADB.
    /// Path is relative, e.g. "clipboard" or "sms/send?to=+1234&body=hello"
    pub async fn device_query(&self, path: &str) -> Result<String, ApiError> {
        let uri = format!("content://{KIOSK_AUTHORITY}/{path}");
        let output = adb_shell(&format!("content query --uri '{uri}'")).await?;
        if output.contains("error=") {
            // Extract error message from "Row: 0 error=..."
            let err = output
                .split("error=")
                .nth(1)
                .unwrap_or(&output)
                .trim()
                .to_string();
            return Err(ApiError::Adb(format!("device owner: {err}")));
        }
        Ok(output)
    }
}

async fn http_get(client: &reqwest::Client, base: &str, path: &str) -> Result<String, ApiError> {
    let url = format!("{base}{path}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| ApiError::Adb(format!("bridge GET {path} failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(ApiError::Adb(format!("bridge GET {path} returned {status}: {body}")));
    }
    resp.text().await.map_err(|e| ApiError::Adb(format!("bridge read error: {e}")))
}

async fn http_post(client: &reqwest::Client, base: &str, path: &str, body: &str) -> Result<String, ApiError> {
    let url = format!("{base}{path}");
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json; charset=utf-8")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| ApiError::Adb(format!("bridge POST {path} failed: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| ApiError::Adb(format!("bridge read error: {e}")))?;
    if !status.is_success() {
        return Err(ApiError::Adb(format!("bridge POST {path} returned {status}: {text}")));
    }
    Ok(text)
}

/// Background task that periodically checks if both servers are available.
pub fn spawn_health_checker(bridge: Arc<BridgeState>) {
    tokio::spawn(async move {
        loop {
            // Check device owner app via ContentProvider
            let do_ok = adb_shell("content query --uri 'content://com.otacon.kiosk/health'")
                .await
                .map(|out| out.contains("ok=true"))
                .unwrap_or(false);
            let do_was = bridge.device_owner_available.swap(do_ok, Ordering::Relaxed);
            if do_ok != do_was {
                eprintln!("Bridge: device owner app {}", if do_ok { "connected" } else { "disconnected" });
            }

            // Check snapshot server
            let ss_ok = bridge
                .client
                .get(format!("{SNAPSHOT_URL}/health"))
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            let ss_was = bridge.snapshot_available.swap(ss_ok, Ordering::Relaxed);
            if ss_ok != ss_was {
                eprintln!("Bridge: snapshot server {}", if ss_ok { "connected" } else { "disconnected, falling back to ADB" });
            }

            tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
        }
    });
}
