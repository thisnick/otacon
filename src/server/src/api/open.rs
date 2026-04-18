use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::adb::adb_shell;
use super::{ApiError, OkResponse};

#[derive(Deserialize, Serialize, ToSchema)]
pub struct OpenBody {
    pub uri: String,
}

#[utoipa::path(
    post,
    path = "/api/open",
    tag = "Apps",
    operation_id = "openUri",
    request_body = OpenBody,
    responses((status = 200, body = OkResponse))
)]
pub async fn handler(serial: &str, Json(body): Json<OpenBody>) -> Result<Json<serde_json::Value>, ApiError> {
    // Shell-escape the URI (single quotes, escape any embedded single quotes)
    let escaped = body.uri.replace('\'', "'\\''");
    adb_shell(serial, &format!("am start -a android.intent.action.VIEW -d '{escaped}'")).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}
