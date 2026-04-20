use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use super::AppState;
use crate::auth::registration::RegistrationKind;

#[derive(Deserialize)]
pub struct RegisterHostBody {
    pub host_id: String,
    pub hostname: Option<String>,
    pub tailnet_node_id: Option<String>,
}

#[derive(Deserialize)]
pub struct RegisterClientBody {
    pub client_id: String,
    pub hostname: Option<String>,
}

/// POST /api/v1/hosts/register — host requests registration (public, no auth)
pub async fn register_host(
    State(state): State<AppState>,
    Json(body): Json<RegisterHostBody>,
) -> Json<serde_json::Value> {
    let pending_id = state
        .registration_store
        .register(body.host_id, body.hostname, body.tailnet_node_id, RegistrationKind::Host)
        .await;

    Json(serde_json::json!({
        "pending_id": pending_id,
        "poll_url": format!("/api/v1/hosts/poll/{pending_id}"),
    }))
}

/// POST /api/v1/clients/register — client requests registration (public, no auth)
pub async fn register_client(
    State(state): State<AppState>,
    Json(body): Json<RegisterClientBody>,
) -> Json<serde_json::Value> {
    let pending_id = state
        .registration_store
        .register(body.client_id, body.hostname, None, RegistrationKind::Client)
        .await;

    Json(serde_json::json!({
        "pending_id": pending_id,
        "poll_url": format!("/api/v1/clients/poll/{pending_id}"),
    }))
}

/// POST /api/v1/hosts/poll/{pending_id} or /api/v1/clients/poll/{pending_id}
/// — long-polls for approval (public)
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
            // Timeout — return 408 so caller retries
            Err(StatusCode::REQUEST_TIMEOUT)
        }
    }
}

/// GET /api/v1/admin/hosts/pending — admin lists pending host registrations
pub async fn list_pending_hosts(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let pending = state.registration_store.list_pending_by_kind(RegistrationKind::Host).await;
    Json(serde_json::json!(pending))
}

/// GET /api/v1/admin/clients/pending — admin lists pending client registrations
pub async fn list_pending_clients(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let pending = state.registration_store.list_pending_by_kind(RegistrationKind::Client).await;
    Json(serde_json::json!(pending))
}

/// POST /api/v1/admin/hosts/{id}/approve or /api/v1/admin/clients/{id}/approve
/// — admin approves a registration
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

/// POST /api/v1/admin/hosts/{id}/reject or /api/v1/admin/clients/{id}/reject
/// — admin rejects a registration
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
