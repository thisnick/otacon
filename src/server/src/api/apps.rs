use axum::extract::Path;
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::adb::{adb, adb_shell};
use super::{ApiError, OkResponse};

#[derive(Serialize, ToSchema)]
pub struct App {
    package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/apps",
    tag = "Apps",
    operation_id = "listApps",
    responses((status = 200, body = Vec<App>))
)]
pub async fn list_handler() -> Result<Json<Vec<App>>, ApiError> {
    let out = adb_shell("pm list packages -3").await?;
    let apps: Vec<App> = out
        .lines()
        .filter_map(|line| {
            line.strip_prefix("package:").map(|pkg| App {
                package: pkg.trim().to_string(),
                label: None,
            })
        })
        .collect();
    Ok(Json(apps))
}

#[utoipa::path(
    get,
    path = "/api/apps/running",
    tag = "Apps",
    operation_id = "listRunningApps",
    responses((status = 200, body = Vec<App>))
)]
pub async fn running_handler() -> Result<Json<Vec<App>>, ApiError> {
    // Get recently used / running apps
    let out = adb_shell(
        "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity|realActivity'"
    ).await?;

    let mut packages = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in out.lines() {
        // Extract package from "com.package/.Activity" or "com.package/com.package.Activity"
        if let Some(component) = line.split_whitespace().find(|w| w.contains('/')) {
            let pkg = component
                .split('/')
                .next()
                .unwrap_or("")
                .trim_start_matches('{')
                .to_string();
            if !pkg.is_empty() && seen.insert(pkg.clone()) {
                packages.push(App {
                    package: pkg,
                    label: None,
                });
            }
        }
    }
    Ok(Json(packages))
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct LaunchBody {
    pub package: String,
}

#[utoipa::path(
    post,
    path = "/api/apps/running",
    tag = "Apps",
    operation_id = "launchApp",
    request_body = LaunchBody,
    responses((status = 200, body = OkResponse))
)]
pub async fn launch_handler(Json(body): Json<LaunchBody>) -> Result<Json<serde_json::Value>, ApiError> {
    // Use monkey to launch the main activity of the package
    adb_shell(&format!(
        "monkey -p {} -c android.intent.category.LAUNCHER 1",
        body.package
    ))
    .await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

#[utoipa::path(
    delete,
    path = "/api/apps/running/{package}",
    tag = "Apps",
    operation_id = "stopApp",
    params(("package" = String, Path)),
    responses((status = 200, body = OkResponse))
)]
pub async fn stop_handler(Path(package): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    adb_shell(&format!("am force-stop {package}")).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

#[utoipa::path(
    post,
    path = "/api/apps/install",
    tag = "Apps",
    operation_id = "installApp",
    request_body(content = Vec<u8>, content_type = "application/octet-stream", description = "APK binary"),
    responses(
        (status = 200, body = OkResponse),
        (status = 400, body = super::ErrorResponse),
    )
)]
pub async fn install_handler(body: axum::body::Bytes) -> Result<Json<serde_json::Value>, ApiError> {
    if body.is_empty() {
        return Err(ApiError::BadRequest("empty APK body".into()));
    }

    // Write APK to temp file
    let tmp_path = "/tmp/otacon_install.apk";
    tokio::fs::write(tmp_path, &body).await
        .map_err(|e| ApiError::Adb(format!("failed to write APK: {e}")))?;

    // Install via ADB
    let output = adb(&["install", "-r", tmp_path]).await?;
    let result = String::from_utf8_lossy(&output);

    // Clean up
    let _ = tokio::fs::remove_file(tmp_path).await;

    if result.contains("Success") {
        Ok(Json(serde_json::json!({"ok": true})))
    } else {
        Err(ApiError::Adb(format!("install failed: {}", result.trim())))
    }
}
