use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use super::AppState;

/// List all tokens.
#[utoipa::path(
    get,
    path = "/api/v1/admin/tokens",
    responses(
        (status = 200, description = "All tokens", body = Vec<crate::auth::store::Token>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Tokens"
)]
pub async fn list(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let tokens = state.auth_store.list_tokens().await;
    Json(serde_json::json!(tokens))
}

/// Revoke a token.
#[utoipa::path(
    post,
    path = "/api/v1/admin/tokens/{id}/revoke",
    params(("id" = String, Path, description = "Token ID")),
    responses(
        (status = 200, description = "Token revoked", body = serde_json::Value),
        (status = 404, description = "Token not found"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Tokens"
)]
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
