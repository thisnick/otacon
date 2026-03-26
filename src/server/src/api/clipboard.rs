use axum::extract::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

use super::{ApiError, OkResponse};
use crate::AppState;

#[derive(Deserialize, Serialize, ToSchema)]
#[schema(description = "Clipboard text content")]
pub struct ClipboardContent {
    /// Current clipboard text (null if empty)
    pub text: Option<String>,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct SetClipboardBody {
    text: String,
}

#[utoipa::path(
    get,
    path = "/api/clipboard",
    tag = "Clipboard",
    operation_id = "getClipboard",
    responses((status = 200, description = "Current clipboard content", body = ClipboardContent))
)]
pub async fn get_handler(state: Arc<AppState>) -> Result<Json<ClipboardContent>, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "clipboard requires device owner app (not available)".into(),
        ));
    }
    let body = state.bridge.device_get("/clipboard").await?;
    let content: ClipboardContent = serde_json::from_str(&body).unwrap_or(ClipboardContent { text: None });
    Ok(Json(content))
}

#[utoipa::path(
    put,
    path = "/api/clipboard",
    tag = "Clipboard",
    operation_id = "setClipboard",
    request_body = SetClipboardBody,
    responses((status = 200, body = OkResponse))
)]
pub async fn set_handler(
    state: Arc<AppState>,
    Json(body): Json<SetClipboardBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "clipboard requires device owner app (not available)".into(),
        ));
    }
    let payload = serde_json::json!({"text": body.text}).to_string();
    state.bridge.device_post("/clipboard", &payload).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}
