use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use std::sync::Arc;

use crate::store::{Host, RegistryStore};

#[derive(Deserialize)]
pub struct RegisterHostBody {
    pub id: String,
    pub tailscale_ip: Option<String>,
    pub fqdn: Option<String>,
    #[serde(default = "default_port")]
    pub api_port: u16,
}

fn default_port() -> u16 { 8080 }

#[derive(Deserialize)]
pub struct HeartbeatBody {
    pub host_id: String,
    pub phones: Vec<String>,
    pub dongles: Vec<String>,
}

pub async fn register(
    State(store): State<Arc<RegistryStore>>,
    Json(body): Json<RegisterHostBody>,
) -> Json<serde_json::Value> {
    let now = Utc::now();
    let mut hosts = store.hosts.write().await;
    let host = hosts.entry(body.id.clone()).or_insert_with(|| Host {
        id: body.id.clone(),
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
    let host_clone = host.clone();
    drop(hosts);

    store.save_hosts().await;
    store.add_event("host.online", Some(body.id), None).await;

    Json(serde_json::json!({"ok": true, "host": host_clone}))
}

pub async fn heartbeat(
    State(store): State<Arc<RegistryStore>>,
    Json(body): Json<HeartbeatBody>,
) -> Json<serde_json::Value> {
    let mut hosts = store.hosts.write().await;
    if let Some(host) = hosts.get_mut(&body.host_id) {
        host.last_heartbeat = Some(Utc::now());
        host.status = "online".into();
    }
    drop(hosts);
    store.save_hosts().await;

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

    Json(serde_json::json!({"ok": true}))
}

pub async fn list(
    State(store): State<Arc<RegistryStore>>,
) -> Json<Vec<Host>> {
    let hosts = store.hosts.read().await;
    let mut result: Vec<Host> = hosts.values().cloned().collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

pub async fn get(
    State(store): State<Arc<RegistryStore>>,
    Path(id): Path<String>,
) -> Result<Json<Host>, axum::http::StatusCode> {
    let hosts = store.hosts.read().await;
    hosts.get(&id)
        .cloned()
        .map(Json)
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}
