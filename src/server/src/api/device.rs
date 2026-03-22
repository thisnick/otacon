use axum::Json;
use serde::Serialize;

use super::adb::adb_shell;
use super::ApiError;

#[derive(Serialize)]
pub struct DeviceInfo {
    activity: Option<String>,
    window: Option<String>,
    model: Option<String>,
    resolution: Option<String>,
}

pub async fn info_handler() -> Result<Json<DeviceInfo>, ApiError> {
    let (activity, window, model, resolution) = tokio::join!(
        get_current_activity(),
        get_focused_window(),
        adb_shell("getprop ro.product.model"),
        adb_shell("wm size"),
    );

    Ok(Json(DeviceInfo {
        activity: activity.ok(),
        window: window.ok(),
        model: model.ok(),
        resolution: resolution
            .ok()
            .and_then(|s| s.split(':').last().map(|s| s.trim().to_string())),
    }))
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

pub async fn notifications_handler() -> Result<Json<Vec<Notification>>, ApiError> {
    let out = adb_shell("dumpsys notification --noredact").await?;
    let notifications = parse_notifications(&out);
    Ok(Json(notifications))
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
