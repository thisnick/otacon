use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use crate::store::SimCard;

#[derive(Deserialize, IntoParams)]
pub struct SimQuery {
    pub phone_number: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct ReportSimsBody {
    pub sims: Vec<SimEntry>,
}

#[derive(Deserialize, ToSchema)]
pub struct SimEntry {
    pub iccid: String,
    pub phone_number: Option<String>,
    pub carrier: Option<String>,
    pub slot: u8,
    pub is_esim: bool,
    pub is_active: bool,
    pub profile_name: Option<String>,
}

/// List all SIMs, optionally filtered by phone_number.
#[utoipa::path(
    get,
    path = "/api/v1/admin/sims",
    params(SimQuery),
    responses(
        (status = 200, description = "All SIMs", body = Vec<SimCard>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<SimQuery>,
) -> Json<Vec<SimCard>> {
    let sims = state.store.sims.read().await;
    let mut result: Vec<SimCard> = if let Some(ref number) = query.phone_number {
        sims.values()
            .filter(|s| s.phone_number.as_deref() == Some(number))
            .cloned()
            .collect()
    } else {
        sims.values().cloned().collect()
    };
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

/// Report SIM inventory for a phone (node-scope).
#[utoipa::path(
    post,
    path = "/api/v1/hosts/phones/{phone_id}/sims",
    params(("phone_id" = String, Path, description = "Phone ID")),
    request_body = ReportSimsBody,
    responses(
        (status = 200, description = "SIMs updated", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn report(
    State(state): State<AppState>,
    Path(phone_id): Path<String>,
    Json(body): Json<ReportSimsBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let now = Utc::now();
    let mut sims = store.sims.write().await;

    sims.retain(|_, s| s.phone_id != phone_id);

    for entry in body.sims {
        let sim_id = format!("sim-{}", &entry.iccid[entry.iccid.len().saturating_sub(6)..]);
        sims.insert(sim_id.clone(), SimCard {
            id: sim_id,
            iccid: entry.iccid,
            phone_number: entry.phone_number,
            carrier: entry.carrier,
            phone_id: phone_id.clone(),
            slot: entry.slot,
            is_esim: entry.is_esim,
            is_active: entry.is_active,
            profile_name: entry.profile_name,
            created_at: now,
            updated_at: now,
        });
    }

    drop(sims);
    store.save_sims().await;
    store.add_event("sim.updated", Some(phone_id), None).await;

    Json(serde_json::json!({"ok": true}))
}
