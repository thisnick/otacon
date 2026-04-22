use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use crate::store::Host;

/// Grace period before marking a phone unreachable: 2 missed heartbeats (60s).
const HEARTBEAT_GRACE_SECS: i64 = 60;

#[derive(Deserialize, ToSchema)]
pub struct HostIdentityBody {
    pub host_id: String,
    /// Network address (FQDN or IP) where the CLI can reach this host.
    pub address: Option<String>,
    #[serde(default = "default_port")]
    pub api_port: u16,
}

#[derive(Deserialize, ToSchema)]
pub struct HeartbeatBody {
    pub host_id: String,
    pub address: Option<String>,
    #[serde(default = "default_port")]
    pub api_port: u16,
    #[serde(default)]
    pub phones: Vec<String>,
    #[serde(default)]
    pub dongles: Vec<String>,
}

fn default_port() -> u16 { 8080 }

/// Upsert host metadata (identity only, no phone/dongle status side-effects).
/// Only overwrites address if caller provides Some (prevents heartbeat from
/// clobbering identity values reported earlier).
fn upsert_host(hosts: &mut std::collections::HashMap<String, Host>, host_id: &str, body_address: Option<String>, body_port: u16) -> bool {
    let now = Utc::now();
    let is_new = !hosts.contains_key(host_id);
    let host = hosts.entry(host_id.to_string()).or_insert_with(|| Host {
        id: host_id.to_string(),
        address: None,
        api_port: 8080,
        status: "online".into(),
        last_heartbeat: None,
        created_at: now,
    });
    if let Some(addr) = body_address {
        host.address = Some(addr);
    }
    host.api_port = body_port;
    host.status = "online".into();
    host.last_heartbeat = Some(now);
    is_new
}

/// Register/update host identity without affecting phone/dongle status.
/// Use this on startup; use heartbeat for periodic state sync.
#[utoipa::path(
    post,
    path = "/api/v1/hosts/identity",
    request_body = HostIdentityBody,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn identity(
    State(state): State<AppState>,
    Json(body): Json<HostIdentityBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;

    let mut hosts = store.hosts.write().await;
    let is_new = upsert_host(&mut hosts, &body.host_id, body.address, body.api_port);
    drop(hosts);
    store.save_hosts().await;

    if is_new {
        store.add_event("host.online", Some(body.host_id.clone()), None).await;
    }

    Json(serde_json::json!({"ok": true}))
}

/// Heartbeat with host metadata and connected phones/dongles.
#[utoipa::path(
    post,
    path = "/api/v1/hosts/heartbeat",
    request_body = HeartbeatBody,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn heartbeat(
    State(state): State<AppState>,
    Json(body): Json<HeartbeatBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let now = Utc::now();

    let mut hosts = store.hosts.write().await;
    let is_new = upsert_host(&mut hosts, &body.host_id, body.address, body.api_port);
    drop(hosts);
    store.save_hosts().await;

    if is_new {
        store.add_event("host.online", Some(body.host_id.clone()), None).await;
    }

    let mut phones = store.phones.write().await;
    for phone in phones.values_mut() {
        if phone.host_id.as_deref() == Some(&body.host_id) {
            if body.phones.contains(&phone.id) {
                phone.status = "connected".into();
                phone.last_seen_in_heartbeat = Some(now);
            } else {
                // Grace period: only mark unreachable if phone has been missing
                // for longer than HEARTBEAT_GRACE_SECS since last seen.
                let grace_expired = phone.last_seen_in_heartbeat
                    .map(|last| (now - last).num_seconds() >= HEARTBEAT_GRACE_SECS)
                    .unwrap_or(false); // never seen → don't mark unreachable (newly registered)
                if grace_expired {
                    phone.status = "unreachable".into();
                }
            }
        }
    }
    drop(phones);

    let mut dongles = store.dongles.write().await;
    for dongle in dongles.values_mut() {
        if dongle.host_id.as_deref() == Some(&body.host_id) {
            if body.dongles.contains(&dongle.id) {
                dongle.status = "online".into();
            } else {
                dongle.status = "offline".into();
            }
        }
    }
    drop(dongles);

    store.save_phones().await;
    store.save_dongles().await;

    Json(serde_json::json!({"ok": true}))
}

/// List all hosts.
#[utoipa::path(
    get,
    path = "/api/v1/admin/hosts",
    responses(
        (status = 200, description = "All hosts", body = Vec<Host>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn list(
    State(state): State<AppState>,
) -> Json<Vec<Host>> {
    let hosts = state.store.hosts.read().await;
    let mut result: Vec<Host> = hosts.values().cloned().collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

/// Admin DELETE: forget a host from the registry.
/// "Forget" semantics — if the host is still alive, the next heartbeat re-registers it.
#[utoipa::path(
    delete,
    path = "/api/v1/admin/hosts/{id}",
    params(("id" = String, Path, description = "Host ID")),
    responses(
        (status = 200, description = "Host forgotten", body = serde_json::Value),
        (status = 404, description = "Host not found"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn admin_delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let store = &state.store;

    let mut hosts = store.hosts.write().await;
    hosts.remove(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
    drop(hosts);
    store.save_hosts().await;

    store.add_event("host.admin_deleted", Some(id.clone()), None).await;

    Ok(Json(serde_json::json!({"ok": true})))
}

/// Get a single host by ID.
#[utoipa::path(
    get,
    path = "/api/v1/admin/hosts/{id}",
    params(("id" = String, Path, description = "Host ID")),
    responses(
        (status = 200, description = "Host details", body = Host),
        (status = 404, description = "Host not found"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Host>, axum::http::StatusCode> {
    let hosts = state.store.hosts.read().await;
    hosts.get(&id)
        .cloned()
        .map(Json)
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}
