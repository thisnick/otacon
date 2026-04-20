use axum::extract::State;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use crate::store::Dongle;

#[derive(Deserialize, ToSchema)]
pub struct RegisterDonglesBody {
    pub host_id: String,
    pub dongles: Vec<DongleEntry>,
}

#[derive(Deserialize, ToSchema)]
pub struct DongleEntry {
    pub bt_mac: String,
    pub hci_device: Option<String>,
    pub phone_id: Option<String>,
}

/// List all dongles.
#[utoipa::path(
    get,
    path = "/api/v1/admin/dongles",
    responses(
        (status = 200, description = "All dongles", body = Vec<Dongle>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn list(
    State(state): State<AppState>,
) -> Json<Vec<Dongle>> {
    let dongles = state.store.dongles.read().await;
    let mut result: Vec<Dongle> = dongles.values().cloned().collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

/// Report dongles from a host (node-scope).
#[utoipa::path(
    post,
    path = "/api/v1/hosts/dongles/register",
    request_body = RegisterDonglesBody,
    responses(
        (status = 200, description = "Dongles registered", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterDonglesBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let now = Utc::now();
    let mut dongles = store.dongles.write().await;

    for entry in body.dongles {
        let mac_slug = entry.bt_mac.replace(':', "").to_lowercase();
        let dongle_id = format!("dongle-{}", &mac_slug[mac_slug.len().saturating_sub(6)..]);

        let dongle = dongles.entry(dongle_id.clone()).or_insert_with(|| Dongle {
            id: dongle_id,
            bt_mac: entry.bt_mac.clone(),
            host_id: None,
            phone_id: None,
            hci_device: None,
            status: "available".into(),
            created_at: now,
        });

        dongle.host_id = Some(body.host_id.clone());
        dongle.hci_device = entry.hci_device;
        dongle.phone_id = entry.phone_id;
        dongle.status = "online".into();
    }

    drop(dongles);
    store.save_dongles().await;
    store.add_event("dongle.registered", None,
        Some(serde_json::json!({"host_id": body.host_id}))).await;

    Json(serde_json::json!({"ok": true}))
}
