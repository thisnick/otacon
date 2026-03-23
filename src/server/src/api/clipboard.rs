use axum::extract::Json;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::sync::Arc;

use super::ApiError;
use crate::AppState;

#[derive(Deserialize)]
pub struct SetClipboardBody {
    text: String,
}

pub async fn get_handler(state: Arc<AppState>) -> Result<Response, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "clipboard requires device owner app (not available)".into(),
        ));
    }
    let body = state.bridge.device_get("/clipboard").await?;
    Ok(([("content-type", "application/json")], body).into_response())
}

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
