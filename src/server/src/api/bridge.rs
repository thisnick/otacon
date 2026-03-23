use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::ApiError;

const BRIDGE_URL: &str = "http://127.0.0.1:9090";
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

pub struct BridgeState {
    client: reqwest::Client,
    available: AtomicBool,
}

impl BridgeState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            client,
            available: AtomicBool::new(false),
        }
    }

    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    /// GET request to the device owner app's HTTP server.
    pub async fn get(&self, path: &str) -> Result<String, ApiError> {
        let url = format!("{BRIDGE_URL}{path}");
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| ApiError::Adb(format!("bridge GET {path} failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Adb(format!(
                "bridge GET {path} returned {status}: {body}"
            )));
        }

        resp.text()
            .await
            .map_err(|e| ApiError::Adb(format!("bridge read error: {e}")))
    }

    /// GET request returning raw bytes (for binary responses).
    pub async fn get_bytes(&self, path: &str) -> Result<Vec<u8>, ApiError> {
        let url = format!("{BRIDGE_URL}{path}");
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| ApiError::Adb(format!("bridge GET {path} failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Adb(format!(
                "bridge GET {path} returned {status}: {body}"
            )));
        }

        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| ApiError::Adb(format!("bridge read error: {e}")))
    }

    /// POST JSON to the device owner app's HTTP server.
    pub async fn post(&self, path: &str, body: &str) -> Result<String, ApiError> {
        let url = format!("{BRIDGE_URL}{path}");
        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| ApiError::Adb(format!("bridge POST {path} failed: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::Adb(format!("bridge read error: {e}")))?;

        if !status.is_success() {
            return Err(ApiError::Adb(format!(
                "bridge POST {path} returned {status}: {text}"
            )));
        }

        Ok(text)
    }

    /// DELETE request to the device owner app.
    pub async fn delete(&self, path: &str) -> Result<String, ApiError> {
        let url = format!("{BRIDGE_URL}{path}");
        let resp = self
            .client
            .delete(&url)
            .send()
            .await
            .map_err(|e| ApiError::Adb(format!("bridge DELETE {path} failed: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::Adb(format!("bridge read error: {e}")))?;

        if !status.is_success() {
            return Err(ApiError::Adb(format!(
                "bridge DELETE {path} returned {status}: {text}"
            )));
        }

        Ok(text)
    }
}

/// Background task that periodically checks if the bridge is available.
pub fn spawn_health_checker(bridge: Arc<BridgeState>) {
    tokio::spawn(async move {
        loop {
            let ok = bridge
                .client
                .get(format!("{BRIDGE_URL}/health"))
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);

            let was = bridge.available.swap(ok, Ordering::Relaxed);
            if ok != was {
                if ok {
                    eprintln!("Bridge: device owner app connected");
                } else {
                    eprintln!("Bridge: device owner app disconnected, falling back to ADB");
                }
            }

            tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
        }
    });
}
