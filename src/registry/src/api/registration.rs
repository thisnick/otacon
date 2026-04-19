use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use super::AppState;

#[derive(Deserialize)]
pub struct RegisterBody {
    pub host_id: String,
    pub hostname: Option<String>,
    pub tailnet_node_id: Option<String>,
}

/// POST /api/v1/auth/register — node requests registration (public, no auth)
pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterBody>,
) -> Json<serde_json::Value> {
    let pending_id = state
        .registration_store
        .register(body.host_id, body.hostname, body.tailnet_node_id)
        .await;

    Json(serde_json::json!({
        "pending_id": pending_id,
        "poll_url": format!("/api/v1/auth/poll/{pending_id}"),
    }))
}

/// POST /api/v1/auth/poll/{pending_id} — node long-polls for approval (public)
pub async fn poll(
    State(state): State<AppState>,
    Path(pending_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let timeout = std::time::Duration::from_secs(300); // 5 minutes

    match state.registration_store.poll(&pending_id, timeout).await {
        Some(result) => {
            match result.status {
                crate::auth::registration::RegistrationStatus::Approved => {
                    Ok(Json(serde_json::json!({
                        "status": "approved",
                        "token": result.token,
                    })))
                }
                crate::auth::registration::RegistrationStatus::Rejected => {
                    Err(StatusCode::FORBIDDEN)
                }
                _ => Err(StatusCode::INTERNAL_SERVER_ERROR),
            }
        }
        None => {
            // Timeout — return 408 so node retries
            Err(StatusCode::REQUEST_TIMEOUT)
        }
    }
}

/// GET /api/v1/auth/registrations/pending — admin lists pending registrations
pub async fn list_pending(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let pending = state.registration_store.list_pending().await;
    Json(serde_json::json!(pending))
}

/// POST /api/v1/auth/registrations/{id}/approve — admin approves a registration
pub async fn approve(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.registration_store.approve(&id).await {
        Ok(raw_token) => Ok(Json(serde_json::json!({
            "ok": true,
            "token": raw_token,
        }))),
        Err(msg) => {
            eprintln!("[auth] Approve failed: {msg}");
            Err(StatusCode::BAD_REQUEST)
        }
    }
}

/// POST /api/v1/auth/registrations/{id}/reject — admin rejects a registration
pub async fn reject(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.registration_store.reject(&id).await {
        Ok(()) => Ok(Json(serde_json::json!({"ok": true}))),
        Err(msg) => {
            eprintln!("[auth] Reject failed: {msg}");
            Err(StatusCode::BAD_REQUEST)
        }
    }
}
