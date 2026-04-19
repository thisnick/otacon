use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use super::AppState;

/// GET /api/v1/auth/tokens — list all tokens (admin)
pub async fn list(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let tokens = state.auth_store.list_tokens().await;
    Json(serde_json::json!(tokens))
}

/// POST /api/v1/auth/tokens/{id}/revoke — revoke a token (admin)
pub async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if state.auth_store.revoke(&id).await {
        Ok(Json(serde_json::json!({"ok": true})))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
