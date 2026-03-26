use axum::extract::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tokio::process::Command;
use tokio::sync::Mutex;
use utoipa::ToSchema;

use super::adb::adb;
use crate::AppState;

const PHONE_PATH: &str = "/sdcard/otacon_rec.mp4";
const MAX_DURATION_LIMIT: u32 = 180;
const DEFAULT_MAX_DURATION: u32 = 30;

pub struct RecordingInfo {
    pub child: tokio::process::Child,
    pub started_at: Instant,
    pub max_duration: u32,
}

pub type RecordingState = Arc<Mutex<Option<RecordingInfo>>>;

#[derive(Deserialize, Serialize, ToSchema)]
pub struct StartRecordBody {
    /// Max recording duration in seconds (default 30, max 180)
    #[serde(default = "default_max_duration")]
    pub max_duration: u32,
}

fn default_max_duration() -> u32 {
    DEFAULT_MAX_DURATION
}

#[derive(Serialize, ToSchema)]
pub struct RecordStatus {
    pub recording: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_duration: Option<u32>,
}

#[utoipa::path(
    post,
    path = "/api/record/start",
    tag = "Recording",
    operation_id = "startRecording",
    request_body = StartRecordBody,
    responses(
        (status = 200, description = "Recording started", body = super::OkResponse),
        (status = 409, description = "Recording already in progress", body = super::ErrorResponse),
    )
)]
pub async fn start_handler(
    state: Arc<AppState>,
    Json(body): Json<StartRecordBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let max_duration = body.max_duration.min(MAX_DURATION_LIMIT);

    let mut guard = state.recording.lock().await;
    if let Some(ref mut info) = *guard {
        // Check if previous recording's process has exited (auto-stopped)
        if info.child.try_wait().ok().flatten().is_some() {
            // Process exited — recording auto-stopped, file is on phone
            // Allow new recording (old file will be overwritten)
            *guard = None;
        } else {
            return Err((
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": "recording already in progress"})),
            ).into_response());
        }
    }

    // Clean up any leftover file
    let _ = adb(&["shell", "rm", "-f", PHONE_PATH]).await;

    let child = Command::new("adb")
        .args(["shell", "screenrecord", "--time-limit", &max_duration.to_string(), PHONE_PATH])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR,
             Json(serde_json::json!({"error": format!("failed to start screenrecord: {e}")}))).into_response()
        })?;

    *guard = Some(RecordingInfo {
        child,
        started_at: Instant::now(),
        max_duration,
    });

    Ok(Json(serde_json::json!({"ok": true})))
}

#[utoipa::path(
    post,
    path = "/api/record/stop",
    tag = "Recording",
    operation_id = "stopRecording",
    responses(
        (status = 200, description = "MP4 video", content_type = "video/mp4"),
        (status = 404, description = "No active recording", body = super::ErrorResponse),
    )
)]
pub async fn stop_handler(state: Arc<AppState>) -> Result<Response, Response> {
    let mut guard = state.recording.lock().await;
    let info = guard.take().ok_or_else(|| {
        (StatusCode::NOT_FOUND,
         Json(serde_json::json!({"error": "no active recording"}))).into_response()
    })?;
    drop(guard);

    stop_and_retrieve(info).await
}

#[utoipa::path(
    get,
    path = "/api/record/status",
    tag = "Recording",
    operation_id = "getRecordingStatus",
    responses((status = 200, body = RecordStatus))
)]
pub async fn status_handler(state: Arc<AppState>) -> Json<RecordStatus> {
    let mut guard = state.recording.lock().await;
    match guard.as_mut() {
        Some(info) => {
            let exited = info.child.try_wait().ok().flatten().is_some();
            let elapsed = info.started_at.elapsed().as_secs() as u32;
            Json(RecordStatus {
                recording: !exited,
                elapsed: Some(elapsed.min(info.max_duration)),
                max_duration: Some(info.max_duration),
            })
        }
        None => Json(RecordStatus {
            recording: false,
            elapsed: None,
            max_duration: None,
        }),
    }
}

/// Stop the screenrecord process, pull the mp4, clean up, return bytes.
pub async fn stop_and_retrieve(mut info: RecordingInfo) -> Result<Response, Response> {
    // Send SIGINT to screenrecord to finalize the mp4
    let _ = info.child.kill().await;
    let _ = info.child.wait().await;

    // Give screenrecord a moment to flush
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Pull the file
    let mp4_data = adb(&["exec-out", "cat", PHONE_PATH]).await.map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR,
         Json(serde_json::json!({"error": "failed to pull recording"}))).into_response()
    })?;

    // Clean up
    let _ = adb(&["shell", "rm", "-f", PHONE_PATH]).await;

    if mp4_data.is_empty() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "recording file is empty"})),
        ).into_response());
    }

    Ok((
        [
            ("content-type", "video/mp4"),
            ("cache-control", "no-cache"),
        ],
        mp4_data,
    ).into_response())
}
