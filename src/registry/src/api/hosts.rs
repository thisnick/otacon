use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;

use super::AppState;
use crate::store::Host;

#[derive(Deserialize)]
pub struct HeartbeatBody {
    pub host_id: String,
    pub tailscale_ip: Option<String>,
    pub fqdn: Option<String>,
    #[serde(default = "default_port")]
    pub api_port: u16,
    #[serde(default)]
    pub phones: Vec<String>,
    #[serde(default)]
    pub dongles: Vec<String>,
}

fn default_port() -> u16 { 8080 }

/// POST /api/v1/hosts/heartbeat — heartbeat with host metadata + connected phones/dongles
pub async fn heartbeat(
    State(state): State<AppState>,
    Json(body): Json<HeartbeatBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let now = Utc::now();

    // Upsert host metadata (folded from old register endpoint)
    let mut hosts = store.hosts.write().await;
    let is_new = !hosts.contains_key(&body.host_id);
    let host = hosts.entry(body.host_id.clone()).or_insert_with(|| Host {
        id: body.host_id.clone(),
        tailscale_ip: None,
        fqdn: None,
        api_port: 8080,
        status: "online".into(),
        last_heartbeat: None,
        created_at: now,
    });

    host.tailscale_ip = body.tailscale_ip;
    host.fqdn = body.fqdn;
    host.api_port = body.api_port;
    host.status = "online".into();
    host.last_heartbeat = Some(now);
    drop(hosts);
    store.save_hosts().await;

    if is_new {
        store.add_event("host.online", Some(body.host_id.clone()), None).await;
    }

    // Update phone statuses based on what the host reports as connected
    let mut phones = store.phones.write().await;
    for phone in phones.values_mut() {
        if phone.host_id.as_deref() == Some(&body.host_id) {
            if !body.phones.contains(&phone.id) {
                phone.status = "unreachable".into();
            } else {
                phone.status = "connected".into();
            }
        }
    }
    drop(phones);

    // Update dongle statuses
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

/// GET /api/v1/admin/hosts — list all hosts
pub async fn list(
    State(state): State<AppState>,
) -> Json<Vec<Host>> {
    let hosts = state.store.hosts.read().await;
    let mut result: Vec<Host> = hosts.values().cloned().collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

/// GET /api/v1/admin/hosts/{id} — get a single host
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
