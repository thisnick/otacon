use axum::Json;
use serde::Deserialize;

use super::adb::adb_shell;
use super::ApiError;

#[derive(Deserialize)]
pub struct OpenBody {
    pub uri: String,
}

pub async fn handler(Json(body): Json<OpenBody>) -> Result<Json<serde_json::Value>, ApiError> {
    // Shell-escape the URI (single quotes, escape any embedded single quotes)
    let escaped = body.uri.replace('\'', "'\\''");
    adb_shell(&format!("am start -a android.intent.action.VIEW -d '{escaped}'")).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}
