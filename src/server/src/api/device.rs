use axum::extract::Path;
use axum::Json;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

use super::adb::adb_shell;
use super::{ApiError, OkResponse};
use crate::phone::PhoneState;

#[derive(Serialize, ToSchema)]
#[schema(description = "Device metadata and connection status")]
pub struct DeviceInfo {
    /// Current foreground activity
    activity: Option<String>,
    window: Option<String>,
    model: Option<String>,
    /// e.g. "1080x2316"
    resolution: Option<String>,
    /// SIM phone number (e.g. "+15551234567")
    phone_number: Option<String>,
    /// Device owner app connected
    bridge: bool,
    /// Snapshot server (app_process) connected
    snapshot_server: bool,
    /// ADB serial of this phone
    adb_serial: String,
    /// Phone's BT MAC (if known from pairing)
    phone_bt_mac: Option<String>,
    /// Assigned BT dongle MAC on the host
    adapter_mac: Option<String>,
    /// Whether the phone is currently BT-connected to its assigned dongle
    bt_connected: bool,
    /// WiFi connection state
    wifi: WifiStatus,
    /// Lightweight system stats (CPU/mem/battery/temp)
    stats: PhoneStats,
}

#[derive(Serialize, ToSchema, Default)]
pub struct WifiStatus {
    enabled: bool,
    connected: bool,
    ssid: Option<String>,
    rssi: Option<i32>,
}

#[derive(Serialize, ToSchema, Default)]
pub struct PhoneStats {
    /// Approximate CPU usage percent across all cores (0-100, normalized)
    cpu_pct: Option<f32>,
    mem_used_mb: Option<u32>,
    mem_total_mb: Option<u32>,
    battery_pct: Option<u8>,
    /// CPU temp in Celsius (if readable)
    temp_c: Option<f32>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[schema(description = "Phone notification")]
pub struct Notification {
    /// Unique notification key (use for dismiss/action)
    key: String,
    package: String,
    title: Option<String>,
    text: Option<String>,
    /// Post time in milliseconds
    time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actions: Option<Vec<NotificationAction>>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct NotificationAction {
    /// Action index (use for triggering)
    index: u32,
    title: String,
}

#[utoipa::path(
    get,
    path = "/api/info",
    tag = "Screen",
    operation_id = "getDeviceInfo",
    responses((status = 200, body = DeviceInfo))
)]
pub async fn info_handler(state: Arc<PhoneState>) -> Result<Json<DeviceInfo>, ApiError> {
    let serial = &state.config.adb_serial;
    let phone_bt_mac = state.config.phone_bt_mac.clone();
    let adapter_mac = state.config.adapter_mac.clone();

    let (activity, window, model, resolution, phone_number, wifi, bt_connected, stats) = tokio::join!(
        get_current_activity(serial),
        get_focused_window(serial),
        adb_shell(serial, "getprop ro.product.model"),
        adb_shell(serial, "wm size"),
        get_phone_number(serial),
        get_wifi_status(serial),
        get_bt_connected(adapter_mac.as_deref(), phone_bt_mac.as_deref()),
        get_phone_stats(serial),
    );

    Ok(Json(DeviceInfo {
        activity: activity.ok(),
        window: window.ok(),
        model: model.ok(),
        resolution: resolution
            .ok()
            .and_then(|s| s.split(':').last().map(|s| s.trim().to_string())),
        phone_number: phone_number.ok(),
        bridge: state.bridge.is_device_owner_available(),
        snapshot_server: state.bridge.is_snapshot_available(),
        adb_serial: serial.clone(),
        phone_bt_mac,
        adapter_mac,
        bt_connected,
        wifi,
        stats,
    }))
}

async fn get_phone_stats(serial: &str) -> PhoneStats {
    let mut s = PhoneStats::default();
    // Battery — single file read, very fast
    if let Ok(text) = adb_shell(serial, "cat /sys/class/power_supply/battery/capacity").await {
        s.battery_pct = text.trim().parse().ok();
    }
    // CPU temp — reads thermal_zone0; some phones have different zones
    if let Ok(text) = adb_shell(serial, "cat /sys/class/thermal/thermal_zone0/temp").await {
        if let Ok(milli) = text.trim().parse::<i32>() {
            s.temp_c = Some(milli as f32 / 1000.0);
        }
    }
    // Memory — `cat /proc/meminfo` first 3 lines: MemTotal, MemFree, MemAvailable (kB)
    if let Ok(text) = adb_shell(serial, "head -3 /proc/meminfo").await {
        let mut total_kb: Option<u64> = None;
        let mut available_kb: Option<u64> = None;
        for line in text.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let key = parts[0].trim_end_matches(':');
                let val: Option<u64> = parts[1].parse().ok();
                if key == "MemTotal" { total_kb = val; }
                else if key == "MemAvailable" { available_kb = val; }
            }
        }
        if let (Some(t), Some(a)) = (total_kb, available_kb) {
            s.mem_total_mb = Some((t / 1024) as u32);
            s.mem_used_mb = Some(((t.saturating_sub(a)) / 1024) as u32);
        }
    }
    // CPU — parse top -bn1 header: "800%cpu  10%user  3%nice  31%sys 755%idle ..."
    // (loadavg over-counts on Android because many processes sit in D state).
    if let Ok(text) = adb_shell(serial, "top -bn1 -m 1 | head -4").await {
        for line in text.lines() {
            // Look for line containing "%cpu" with idle component
            if line.contains("%cpu") && line.contains("%idle") {
                // Extract the total %cpu and %idle
                let total: Option<f32> = line.split_whitespace()
                    .find(|w| w.ends_with("%cpu"))
                    .and_then(|w| w.trim_end_matches("%cpu").parse().ok());
                let idle: Option<f32> = line.split_whitespace()
                    .find(|w| w.ends_with("%idle"))
                    .and_then(|w| w.trim_end_matches("%idle").parse().ok());
                if let (Some(t), Some(i)) = (total, idle) {
                    if t > 0.0 {
                        s.cpu_pct = Some(((t - i) / t * 100.0).clamp(0.0, 100.0));
                    }
                }
                break;
            }
        }
    }
    s
}

async fn get_wifi_status(serial: &str) -> WifiStatus {
    // Use shell `cmd wifi status` — it runs as system shell, sees real
    // SSID/RSSI/networkId without needing ACCESS_FINE_LOCATION (which the
    // kiosk app's WifiManager.getConnectionInfo() can't access on Android 10+).
    let out = adb_shell(serial, "cmd wifi status").await;
    let mut s = WifiStatus::default();
    let Ok(text) = out else { return s };
    s.enabled = text.contains("Wifi is enabled");
    if !s.enabled {
        return s;
    }
    s.connected = text.contains("Wifi is connected to");
    if !s.connected {
        return s;
    }
    // Extract SSID — appears as `SSID: "name",` in the WifiInfo line
    if let Some(start) = text.find("SSID: \"") {
        let rest = &text[start + 7..];
        if let Some(end) = rest.find('"') {
            s.ssid = Some(rest[..end].to_string());
        }
    }
    // Extract RSSI — appears as `RSSI: -22,`
    if let Some(start) = text.find("RSSI: ") {
        let rest = &text[start + 6..];
        let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
        s.rssi = num.parse().ok();
    }
    s
}

async fn get_bt_connected(adapter_mac: Option<&str>, phone_bt_mac: Option<&str>) -> bool {
    let (Some(adapter), Some(phone)) = (adapter_mac, phone_bt_mac) else {
        return false;
    };
    let cmd = format!("printf 'select {adapter}\\ninfo {phone}\\n' | bluetoothctl 2>/dev/null");
    let Ok(out) = tokio::process::Command::new("sh")
        .args(["-c", &cmd])
        .output()
        .await
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    text.contains("Connected: yes")
}

async fn get_phone_number(serial: &str) -> Result<String, ApiError> {
    let out = adb_shell(serial, "service call iphonesubinfo 16 s16 com.android.shell").await?;
    // Parcel output has quoted sections like '1.5.1.0.2.9.0.1.1.7.8...'
    // Extract digits only from text between single quotes
    let number: String = out
        .split('\'')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1) // odd indices are inside quotes
        .flat_map(|(_, s)| s.chars())
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();
    if number.is_empty() {
        return Err(ApiError::Adb("no phone number found".into()));
    }
    Ok(format!("+{}", number.trim_start_matches('+')))
}

async fn get_current_activity(serial: &str) -> Result<String, ApiError> {
    let out =
        adb_shell(serial, "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'")
            .await?;
    // Extract the component name from the dumpsys output
    // Format: "mResumedActivity: ActivityRecord{... com.package/.Activity ...}"
    Ok(out
        .lines()
        .next()
        .and_then(|line| {
            line.split_whitespace()
                .find(|w| w.contains('/'))
                .map(|s| s.trim_end_matches('}').to_string())
        })
        .unwrap_or_else(|| out.to_string()))
}

async fn get_focused_window(serial: &str) -> Result<String, ApiError> {
    let out = adb_shell(serial, "dumpsys window | grep mCurrentFocus").await?;
    Ok(out
        .lines()
        .next()
        .and_then(|line| {
            line.split_whitespace()
                .last()
                .map(|s| s.trim_end_matches('}').to_string())
        })
        .unwrap_or_else(|| out.to_string()))
}

#[utoipa::path(
    get,
    path = "/api/notifications",
    tag = "Notifications",
    operation_id = "listNotifications",
    responses((status = 200, description = "Array of active notifications", body = Vec<Notification>))
)]
pub async fn notifications_handler(
    state: Arc<PhoneState>,
) -> Result<Json<Vec<Notification>>, ApiError> {
    let serial = &state.config.adb_serial;
    // Fast path: device owner ContentProvider (returns JSON blob)
    if state.bridge.is_device_owner_available() {
        let output = state.bridge.device_query(serial, "notifications").await?;
        // ContentProvider returns "Row: 0 json=[...]"
        let json_str = output
            .split("json=")
            .nth(1)
            .unwrap_or("[]")
            .trim();
        let notifications: Vec<Notification> = serde_json::from_str(json_str)
            .unwrap_or_default();
        return Ok(Json(notifications));
    }

    // Slow path: parse dumpsys
    let out = adb_shell(serial, "dumpsys notification --noredact").await?;
    let notifications = parse_notifications(&out);
    Ok(Json(notifications))
}

#[utoipa::path(
    delete,
    path = "/api/notifications/{key}",
    tag = "Notifications",
    operation_id = "dismissNotification",
    params(("key" = String, Path, description = "Notification key")),
    responses((status = 200, body = OkResponse))
)]
pub async fn dismiss_notification_handler(
    state: Arc<PhoneState>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let serial = &state.config.adb_serial;
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "notification dismiss requires device owner app (not available)".into(),
        ));
    }
    let key_encoded = urlencoding::encode(&key);
    state.bridge.device_query(serial, &format!("notifications/dismiss?key={key_encoded}")).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

#[utoipa::path(
    post,
    path = "/api/notifications/{key}/action/{index}",
    tag = "Notifications",
    operation_id = "triggerNotificationAction",
    params(
        ("key" = String, Path, description = "Notification key"),
        ("index" = u32, Path, description = "Action index"),
    ),
    responses((status = 200, body = OkResponse))
)]
pub async fn notification_action_handler(
    state: Arc<PhoneState>,
    Path((key, index)): Path<(String, u32)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let serial = &state.config.adb_serial;
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "notification actions require device owner app (not available)".into(),
        ));
    }
    let key_encoded = urlencoding::encode(&key);
    state.bridge.device_query(serial,
        &format!("notifications/action?key={key_encoded}&index={index}")
    ).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

fn parse_notifications(dump: &str) -> Vec<Notification> {
    let mut notifications = Vec::new();
    let mut current_key = String::new();
    let mut current_pkg = String::new();
    let mut current_title: Option<String> = None;
    let mut current_text: Option<String> = None;
    let mut current_time: Option<i64> = None;
    let mut in_notification = false;

    for line in dump.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("NotificationRecord") {
            // Save previous notification if we had one
            if in_notification && !current_key.is_empty() {
                notifications.push(Notification {
                    key: current_key.clone(),
                    package: current_pkg.clone(),
                    title: current_title.take(),
                    text: current_text.take(),
                    time: current_time.take(),
                    actions: None,
                });
            }
            in_notification = true;
            current_key.clear();
            current_pkg.clear();

            // Extract key from "NotificationRecord{hash 0x... key}"
            if let Some(start) = trimmed.rfind(' ') {
                current_key = trimmed[start + 1..].trim_end_matches('}').to_string();
                // Package is typically the first part of the key before "|"
                if current_key.contains('|') {
                    // key format: "0|com.package|id|tag|uid"
                    let parts: Vec<&str> = current_key.split('|').collect();
                    if parts.len() > 1 {
                        current_pkg = parts[1].to_string();
                    }
                }
            }
        } else if in_notification {
            if let Some(rest) = trimmed.strip_prefix("android.title=") {
                current_title = Some(rest.to_string());
            } else if let Some(rest) = trimmed.strip_prefix("android.text=") {
                current_text = Some(rest.to_string());
            } else if let Some(rest) = trimmed.strip_prefix("postTime=") {
                current_time = rest.parse().ok();
            }
        }
    }

    // Don't forget the last one
    if in_notification && !current_key.is_empty() {
        notifications.push(Notification {
            key: current_key,
            package: current_pkg,
            title: current_title,
            text: current_text,
            time: current_time,
            actions: None,
        });
    }

    notifications
}
