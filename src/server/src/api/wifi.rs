use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

use super::adb::adb_shell;
use super::ApiError;
use crate::phone::PhoneState;

#[derive(Debug, Default, Serialize, ToSchema)]
pub struct WifiStatus {
    pub enabled: bool,
    pub connected: bool,
    pub ssid: Option<String>,
    pub rssi: Option<i32>,
    /// Persisted host-local desired state for this phone.
    pub desired_enabled: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetWifiEnabledBody {
    pub enabled: bool,
}

#[utoipa::path(
    get,
    path = "/api/wifi",
    tag = "WiFi",
    operation_id = "getWifiStatus",
    responses((status = 200, body = WifiStatus))
)]
pub async fn status_handler(
    serial: &str,
    desired_enabled: bool,
) -> Result<Json<WifiStatus>, ApiError> {
    Ok(Json(read_wifi_status(serial, desired_enabled).await?))
}

#[utoipa::path(
    put,
    path = "/api/wifi",
    tag = "WiFi",
    operation_id = "setWifiEnabled",
    request_body = SetWifiEnabledBody,
    responses((status = 200, body = WifiStatus))
)]
pub async fn set_enabled_handler(
    state: Arc<PhoneState>,
    enabled: bool,
) -> Result<Json<WifiStatus>, ApiError> {
    let serial = &state.config.adb_serial;

    let mut applied = false;
    if state.bridge.is_device_owner_available() {
        let path = format!("wifi/enabled?enabled={enabled}");
        match state.bridge.device_query(serial, &path).await {
            Ok(_) => applied = true,
            Err(err) => {
                eprintln!("[{serial}] device-owner wifi/enabled failed, falling back to svc wifi: {err:?}");
            }
        }
    }

    if !applied {
        adb_shell(serial, &format!("svc wifi {}", if enabled { "enable" } else { "disable" }))
            .await?;
    }

    Ok(Json(read_wifi_status(serial, enabled).await?))
}

async fn read_wifi_status(serial: &str, desired_enabled: bool) -> Result<WifiStatus, ApiError> {
    // `cmd wifi status` runs as shell and exposes reliable SSID/RSSI without
    // Android app location permission restrictions.
    let text = adb_shell(serial, "cmd wifi status").await?;
    let mut status = WifiStatus {
        desired_enabled,
        ..WifiStatus::default()
    };
    status.enabled = text.contains("Wifi is enabled");
    if !status.enabled {
        return Ok(status);
    }
    status.connected = text.contains("Wifi is connected to");
    if !status.connected {
        return Ok(status);
    }

    if let Some(idx) = text.find("SSID: \"") {
        let rest = &text[idx + "SSID: \"".len()..];
        if let Some(end) = rest.find('"') {
            status.ssid = Some(rest[..end].to_string());
        }
    }

    if let Some(idx) = text.find("RSSI: ") {
        let rest = &text[idx + "RSSI: ".len()..];
        let num: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        status.rssi = num.parse().ok();
    }

    Ok(status)
}
