use axum::extract::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

use super::adb::parse_content_row;
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
    let output = state.bridge.device_query("clipboard").await?;
    let text = parse_content_row(&output)
        .and_then(|row| row.get("text").cloned())
        .filter(|t| t != "NULL");
    Ok(Json(ClipboardContent { text }))
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
    let encoded = urlencoding::encode(&body.text);
    state.bridge.device_query(&format!("clipboard/set?text={encoded}")).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}
