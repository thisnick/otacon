use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use crate::ingestion::apply;
use crate::store::Event;

#[derive(Deserialize, IntoParams)]
pub struct EventQuery {
    pub event_type: Option<String>,
    pub entity_id: Option<String>,
    pub phone_id: Option<String>,
    pub severity: Option<String>,
    pub category: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize { 100 }

/// Query event log.
#[utoipa::path(
    get,
    path = "/api/v1/admin/events",
    params(EventQuery),
    responses(
        (status = 200, description = "Filtered events", body = Vec<Event>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<EventQuery>,
) -> Json<Vec<Event>> {
    let events = state.store.events.read().await;
    let filtered: Vec<Event> = events.iter()
        .rev()
        .filter(|e| {
            if let Some(ref et) = query.event_type {
                if &e.event_type != et { return false; }
            }
            if let Some(ref eid) = query.entity_id {
                if e.entity_id.as_deref() != Some(eid) { return false; }
            }
            if let Some(ref pid) = query.phone_id {
                let matches = e.entity_id.as_deref() == Some(pid)
                    || e.data.as_ref()
                        .and_then(|d| d.get("phone_id"))
                        .and_then(|v| v.as_str())
                        == Some(pid);
                if !matches { return false; }
            }
            if let Some(ref sev) = query.severity {
                let data_sev = e.data.as_ref()
                    .and_then(|d| d.get("severity"))
                    .and_then(|v| v.as_str());
                if data_sev != Some(sev) { return false; }
            }
            if let Some(ref cat) = query.category {
                let data_cat = e.data.as_ref()
                    .and_then(|d| d.get("category"))
                    .and_then(|v| v.as_str());
                if data_cat != Some(cat) { return false; }
            }
            true
        })
        .take(query.limit)
        .cloned()
        .collect();
    Json(filtered)
}

#[derive(Deserialize, ToSchema)]
pub struct ReportEventBody {
    pub host_id: Option<String>,
    pub phone_id: Option<String>,
    pub severity: String,
    pub category: String,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

/// Report an event from a host (node-scope).
#[utoipa::path(
    post,
    path = "/api/v1/hosts/events",
    request_body = ReportEventBody,
    responses(
        (status = 200, description = "Event recorded", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn report(
    State(state): State<AppState>,
    Json(body): Json<ReportEventBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let event_type = format!("{}.{}", body.severity, body.category);

    let mut event_data = serde_json::json!({
        "severity": body.severity,
        "category": body.category,
        "message": body.message,
    });
    if let Some(ref host_id) = body.host_id {
        event_data["host_id"] = serde_json::json!(host_id);
    }
    if let Some(ref phone_id) = body.phone_id {
        event_data["phone_id"] = serde_json::json!(phone_id);
    }
    if let Some(extra) = body.data {
        event_data["extra"] = extra;
    }

    let event = store.add_event(
        &event_type,
        body.phone_id.clone(),
        Some(event_data),
    ).await;

    Json(serde_json::json!({"ok": true, "event_id": event.id}))
}

/// Body for typed fleet events sent by the host outbox flusher.
#[derive(Deserialize, ToSchema)]
pub struct FleetEventBody {
    pub host_id: String,
    pub event_type: String,
    pub entity_id: Option<String>,
    pub data: serde_json::Value,
}

/// Ingest a typed fleet event from a host (node-scope).
/// The data field contains the full FleetEvent (tagged enum).
/// Apply functions are idempotent — no dedup needed.
#[utoipa::path(
    post,
    path = "/api/v1/hosts/events/ingest",
    request_body = FleetEventBody,
    responses(
        (status = 200, description = "Event applied", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn ingest(
    State(state): State<AppState>,
    Json(body): Json<FleetEventBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;

    // Dispatch to apply functions based on event_type
    match body.event_type.as_str() {
        "phone.connected" => {
            if let Some(payload) = body.data.get("payload") {
                let phone_id = payload.get("phone_id").and_then(|v| v.as_str()).unwrap_or("");
                let adb_serial = payload.get("adb_serial").and_then(|v| v.as_str()).unwrap_or("");
                let adapter_mac = payload.get("adapter_mac").and_then(|v| v.as_str());
                let phone_number = payload.get("phone_number").and_then(|v| v.as_str());
                if !phone_id.is_empty() && !adb_serial.is_empty() {
                    apply::phone_connected(store, &body.host_id, phone_id, adb_serial, adapter_mac, phone_number).await;
                }
            }
        }
        "phone.disconnected" => {
            if let Some(payload) = body.data.get("payload") {
                if let Some(phone_id) = payload.get("phone_id").and_then(|v| v.as_str()) {
                    apply::phone_disconnected(store, phone_id).await;
                }
            }
        }
        "phone.removed" => {
            if let Some(payload) = body.data.get("payload") {
                if let Some(phone_id) = payload.get("phone_id").and_then(|v| v.as_str()) {
                    apply::phone_removed(store, phone_id).await;
                }
            }
        }
        "dongle.discovered" => {
            if let Some(payload) = body.data.get("payload") {
                let bt_mac = payload.get("bt_mac").and_then(|v| v.as_str()).unwrap_or("");
                let hci_device = payload.get("hci_device").and_then(|v| v.as_str());
                if !bt_mac.is_empty() {
                    apply::dongle_discovered(store, &body.host_id, bt_mac, hci_device).await;
                }
            }
        }
        "dongle.bound" => {
            if let Some(payload) = body.data.get("payload") {
                let dongle_id = payload.get("dongle_id").and_then(|v| v.as_str()).unwrap_or("");
                let phone_id = payload.get("phone_id").and_then(|v| v.as_str()).unwrap_or("");
                if !dongle_id.is_empty() && !phone_id.is_empty() {
                    apply::dongle_bound(store, dongle_id, phone_id).await;
                }
            }
        }
        "dongle.unbound" => {
            if let Some(payload) = body.data.get("payload") {
                if let Some(dongle_id) = payload.get("dongle_id").and_then(|v| v.as_str()) {
                    apply::dongle_unbound(store, dongle_id).await;
                }
            }
        }
        "dongle.removed" => {
            if let Some(payload) = body.data.get("payload") {
                if let Some(dongle_id) = payload.get("dongle_id").and_then(|v| v.as_str()) {
                    apply::dongle_removed(store, dongle_id).await;
                }
            }
        }
        "host.snapshot" => {
            if let Some(payload) = body.data.get("payload") {
                let phones: Vec<apply::SnapshotPhone> = payload.get("phones")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                let dongles: Vec<apply::SnapshotDongle> = payload.get("dongles")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                apply::host_snapshot(store, &body.host_id, &phones, &dongles).await;
            }
        }
        "host.online" => {
            // Just record the event; host identity is handled by /hosts/identity
        }
        _ => {
            eprintln!("[ingest] Unknown event_type: {}", body.event_type);
        }
    }

    // Always log to audit trail
    let event = store.add_event(
        &body.event_type,
        body.entity_id.clone(),
        Some(serde_json::json!({
            "host_id": body.host_id,
            "data": body.data,
        })),
    ).await;

    Json(serde_json::json!({"ok": true, "event_id": event.id}))
}
