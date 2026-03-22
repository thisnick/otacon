use axum::extract::Path;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::adb::adb_shell;
use super::ApiError;

#[derive(Serialize)]
pub struct App {
    package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

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

#[derive(Deserialize)]
pub struct LaunchBody {
    pub package: String,
}

pub async fn launch_handler(Json(body): Json<LaunchBody>) -> Result<Json<serde_json::Value>, ApiError> {
    // Use monkey to launch the main activity of the package
    adb_shell(&format!(
        "monkey -p {} -c android.intent.category.LAUNCHER 1",
        body.package
    ))
    .await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

pub async fn stop_handler(Path(package): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    adb_shell(&format!("am force-stop {package}")).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}
