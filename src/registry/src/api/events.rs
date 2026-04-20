use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use super::AppState;
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
