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
    /// Monotonic Android versionCode (e.g. 9270000)
    #[serde(skip_serializing_if = "Option::is_none")]
    version_code: Option<u64>,
    /// Human versionName (e.g. "9.27.0"). Only populated when explicitly requested
    /// (uses `dumpsys package <pkg>` per-app, which is slow).
    #[serde(skip_serializing_if = "Option::is_none")]
    version_name: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/apps",
    tag = "Apps",
    operation_id = "listApps",
    responses((status = 200, body = Vec<App>))
)]
pub async fn list_handler(serial: &str) -> Result<Json<Vec<App>>, ApiError> {
    // --show-versioncode appends "versionCode:N" to each package line in one call.
    let out = adb_shell(serial, "pm list packages -3 --show-versioncode").await?;
    let apps: Vec<App> = out
        .lines()
        .filter_map(|line| {
            // Lines look like: "package:com.example.foo versionCode:42"
            let rest = line.strip_prefix("package:")?;
            let mut parts = rest.split_whitespace();
            let pkg = parts.next()?.to_string();
            let version_code = parts
                .find_map(|w| w.strip_prefix("versionCode:")?.parse::<u64>().ok());
            Some(App {
                package: pkg,
                label: None,
                version_code,
                version_name: None,
            })
        })
        .collect();
    Ok(Json(apps))
}

#[derive(Serialize, ToSchema)]
pub struct RunningApps {
    /// List of running/foreground apps (empty when phone is asleep)
    apps: Vec<App>,
    /// Current screen state — explains an empty `apps` list
    /// (asleep/dozing/dreaming → can't enumerate; unlocked → genuinely no apps)
    /// See /api/info screen_state docs for the full enum.
    screen_state: String,
}

#[utoipa::path(
    get,
    path = "/api/apps/running",
    tag = "Apps",
    operation_id = "listRunningApps",
    responses((status = 200, body = RunningApps))
)]
pub async fn running_handler(serial: &str) -> Result<Json<RunningApps>, ApiError> {
    // Get recently used / running apps. When the phone is asleep dumpsys
    // sometimes fails or returns nothing — treat that as "no running apps"
    // rather than a 502, since asking for the running list on a sleeping
    // phone is a reasonable observation. The screen_state field tells the
    // caller why the list is empty.
    let (out, screen_state) = tokio::join!(
        adb_shell(serial,
            "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity|realActivity'"
        ),
        super::device::get_screen_state(serial),
    );
    let out = out.unwrap_or_default();

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
                    version_code: None,
                    version_name: None,
                });
            }
        }
    }
    Ok(Json(RunningApps { apps: packages, screen_state }))
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
pub async fn launch_handler(serial: &str, Json(body): Json<LaunchBody>) -> Result<Json<serde_json::Value>, ApiError> {
    // Use monkey to launch the main activity of the package
    adb_shell(serial, &format!(
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
pub async fn stop_handler(serial: &str, Path(package): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    adb_shell(serial, &format!("am force-stop {package}")).await?;
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
pub async fn install_handler(serial: &str, body: axum::body::Bytes) -> Result<Json<serde_json::Value>, ApiError> {
    if body.is_empty() {
        return Err(ApiError::BadRequest("empty APK body".into()));
    }

    // Detect format by magic bytes:
    //   PK\x03\x04 = ZIP (likely .apkm bundle from APKMirror, an AAB-derived
    //                     archive with base.apk + split_*.apk inside)
    //   any other  = single .apk (which is also technically a zip, but if it
    //                              has classes.dex or AndroidManifest.xml as
    //                              top-level entries it's an APK)
    let is_zip = body.starts_with(b"PK\x03\x04");
    let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos()).unwrap_or(0);

    if is_zip && looks_like_apk_bundle(&body) {
        install_bundle(serial, &body, unique).await
    } else {
        install_single(serial, &body, unique).await
    }
}

/// Quick heuristic: is this zip an APK bundle (.apkm with split_*.apk inside)
/// rather than a single .apk file? Look for a "split_config." entry name.
fn looks_like_apk_bundle(body: &axum::body::Bytes) -> bool {
    let cursor = std::io::Cursor::new(body.as_ref());
    let mut archive = match zip::ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(_) => return false,
    };
    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index(i) {
            if file.name().starts_with("split_config.") || file.name() == "base.apk" {
                return true;
            }
        }
    }
    false
}

async fn install_single(serial: &str, body: &axum::body::Bytes, unique: u128) -> Result<Json<serde_json::Value>, ApiError> {
    let tmp_path = format!("/tmp/otacon_install_{unique}.apk");
    tokio::fs::write(&tmp_path, body).await
        .map_err(|e| ApiError::Adb(format!("failed to write APK: {e}")))?;

    let output = adb(serial, &["install", "-r", &tmp_path]).await?;
    let result = String::from_utf8_lossy(&output);
    let _ = tokio::fs::remove_file(&tmp_path).await;

    if result.contains("Success") {
        Ok(Json(serde_json::json!({"ok": true, "format": "apk"})))
    } else {
        Err(ApiError::Adb(format!("install failed: {}", result.trim())))
    }
}

async fn install_bundle(serial: &str, body: &axum::body::Bytes, unique: u128) -> Result<Json<serde_json::Value>, ApiError> {
    let tmp_dir = format!("/tmp/otacon_apkm_{unique}");
    tokio::fs::create_dir_all(&tmp_dir).await
        .map_err(|e| ApiError::Adb(format!("failed to create tmp dir: {e}")))?;

    // Extract base.apk + split_*.apk entries from the zip
    let cursor = std::io::Cursor::new(body.as_ref());
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| ApiError::BadRequest(format!("invalid bundle zip: {e}")))?;

    let mut apk_paths: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| ApiError::Adb(format!("zip read error: {e}")))?;
        let name = file.name().to_string();
        if !name.ends_with(".apk") {
            continue;
        }
        let out_path = format!("{tmp_dir}/{name}");
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| ApiError::Adb(format!("failed to create {out_path}: {e}")))?;
        std::io::copy(&mut file, &mut out)
            .map_err(|e| ApiError::Adb(format!("failed to extract {name}: {e}")))?;
        apk_paths.push(out_path);
    }

    if apk_paths.is_empty() {
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        return Err(ApiError::BadRequest("bundle has no .apk entries".into()));
    }

    // adb install-multiple installs all splits as one package; Android
    // Package Manager picks the right arch + DPI splits at install time.
    let mut args: Vec<&str> = vec!["install-multiple", "-r"];
    for p in &apk_paths {
        args.push(p);
    }
    let output = adb(serial, &args).await?;
    let result = String::from_utf8_lossy(&output);

    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    if result.contains("Success") {
        Ok(Json(serde_json::json!({
            "ok": true,
            "format": "apkm",
            "splits_installed": apk_paths.len()
        })))
    } else {
        Err(ApiError::Adb(format!("install-multiple failed: {}", result.trim())))
    }
}
