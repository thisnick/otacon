use axum::extract::Path;
use axum::Json;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use std::sync::Arc;
use utoipa::ToSchema;

use super::adb::adb_shell;
use super::{ApiError, OkResponse};
use crate::AppState;

#[derive(Serialize, ToSchema)]
pub struct DeviceInfo {
    activity: Option<String>,
    window: Option<String>,
    model: Option<String>,
    resolution: Option<String>,
    phone_number: Option<String>,
    bridge: bool,
    snapshot_server: bool,
}

#[utoipa::path(
    get,
    path = "/api/info",
    tag = "Screen",
    operation_id = "getDeviceInfo",
    responses((status = 200, body = DeviceInfo))
)]
pub async fn info_handler(state: Arc<AppState>) -> Result<Json<DeviceInfo>, ApiError> {
    let (activity, window, model, resolution, phone_number) = tokio::join!(
        get_current_activity(),
        get_focused_window(),
        adb_shell("getprop ro.product.model"),
        adb_shell("wm size"),
        get_phone_number(),
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
    }))
}

async fn get_phone_number() -> Result<String, ApiError> {
    let out = adb_shell("service call iphonesubinfo 16 s16 com.android.shell").await?;
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

async fn get_current_activity() -> Result<String, ApiError> {
    let out =
        adb_shell("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'")
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

async fn get_focused_window() -> Result<String, ApiError> {
    let out = adb_shell("dumpsys window | grep mCurrentFocus").await?;
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

#[derive(Serialize)]
pub struct Notification {
    key: String,
    package: String,
    title: Option<String>,
    text: Option<String>,
    time: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/notifications",
    tag = "Notifications",
    operation_id = "listNotifications",
    responses((status = 200, description = "Array of notifications", body = Vec<serde_json::Value>))
)]
pub async fn notifications_handler(
    state: Arc<AppState>,
) -> Result<Response, ApiError> {
    // Fast path: device owner app
    if state.bridge.is_device_owner_available() {
        let body = state.bridge.device_get("/notifications").await?;
        return Ok(([("content-type", "application/json")], body).into_response());
    }

    // Slow path: parse dumpsys
    let out = adb_shell("dumpsys notification --noredact").await?;
    let notifications = parse_notifications(&out);
    Ok(Json(notifications).into_response())
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
    state: Arc<AppState>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "notification dismiss requires device owner app (not available)".into(),
        ));
    }
    state
        .bridge
        .device_delete(&format!("/notifications/{key}"))
        .await?;
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
    state: Arc<AppState>,
    Path((key, index)): Path<(String, u32)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "notification actions require device owner app (not available)".into(),
        ));
    }
    state
        .bridge
        .device_post(
            &format!("/notifications/{}/action/{}", key, index),
            "",
        )
        .await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

fn parse_notifications(dump: &str) -> Vec<Notification> {
    let mut notifications = Vec::new();
    let mut current_key = String::new();
    let mut current_pkg = String::new();
    let mut current_title: Option<String> = None;
    let mut current_text: Option<String> = None;
    let mut current_time: Option<String> = None;
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
                current_time = Some(rest.to_string());
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
        });
    }

    notifications
}
