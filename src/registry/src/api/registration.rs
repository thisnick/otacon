use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use crate::auth::registration::RegistrationKind;

#[derive(Deserialize, ToSchema)]
pub struct RegisterHostBody {
    pub host_id: String,
    pub hostname: Option<String>,
    pub tailnet_node_id: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct RegisterClientBody {
    pub client_id: String,
    pub hostname: Option<String>,
}

/// Host requests registration (public, no auth).
#[utoipa::path(
    post,
    path = "/api/v1/hosts/register",
    request_body = RegisterHostBody,
    responses(
        (status = 200, description = "Registration pending", body = serde_json::Value),
    ),
    tag = "Public"
)]
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

/// Client requests registration (public, no auth).
#[utoipa::path(
    post,
    path = "/api/v1/clients/register",
    request_body = RegisterClientBody,
    responses(
        (status = 200, description = "Registration pending", body = serde_json::Value),
    ),
    tag = "Public"
)]
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

/// Long-poll for registration approval (public).
#[utoipa::path(
    post,
    path = "/api/v1/hosts/poll/{pending_id}",
    params(("pending_id" = String, Path, description = "Pending registration ID")),
    responses(
        (status = 200, description = "Approved — token returned", body = serde_json::Value),
        (status = 403, description = "Registration rejected"),
        (status = 408, description = "Poll timeout — retry"),
    ),
    tag = "Public"
)]
pub async fn poll(
    State(state): State<AppState>,
    Path(pending_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let timeout = std::time::Duration::from_secs(300);

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
        None => Err(StatusCode::REQUEST_TIMEOUT),
    }
}

/// List pending host registrations.
#[utoipa::path(
    get,
    path = "/api/v1/admin/hosts/pending",
    responses(
        (status = 200, description = "Pending host registrations", body = Vec<crate::auth::registration::PendingRegistration>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Registration"
)]
pub async fn list_pending_hosts(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let pending = state.registration_store.list_pending_by_kind(RegistrationKind::Host).await;
    Json(serde_json::json!(pending))
}

/// List pending client registrations.
#[utoipa::path(
    get,
    path = "/api/v1/admin/clients/pending",
    responses(
        (status = 200, description = "Pending client registrations", body = Vec<crate::auth::registration::PendingRegistration>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Registration"
)]
pub async fn list_pending_clients(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let pending = state.registration_store.list_pending_by_kind(RegistrationKind::Client).await;
    Json(serde_json::json!(pending))
}

/// Approve a pending registration.
#[utoipa::path(
    post,
    path = "/api/v1/admin/hosts/{id}/approve",
    params(("id" = String, Path, description = "Registration ID")),
    responses(
        (status = 200, description = "Approved", body = serde_json::Value),
        (status = 400, description = "Registration not found or already resolved"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Registration"
)]
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

/// Reject a pending registration.
#[utoipa::path(
    post,
    path = "/api/v1/admin/hosts/{id}/reject",
    params(("id" = String, Path, description = "Registration ID")),
    responses(
        (status = 200, description = "Rejected", body = serde_json::Value),
        (status = 400, description = "Registration not found or already resolved"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Registration"
)]
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
