use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Instant;

use super::ApiError;
use crate::phone::PhoneState;

/// Server-side simulated call state for testing without hardware.
#[derive(Default)]
pub struct SimCallState {
    pub state: String,
    pub number: Option<String>,
    pub connected_at: Option<Instant>,
}

impl SimCallState {
    pub fn is_active(&self) -> bool {
        !self.state.is_empty() && self.state != "idle"
    }
}

#[derive(Deserialize)]
pub struct SimIncomingBody {
    pub number: String,
}

#[derive(Deserialize)]
pub struct SimEndBody {
    #[serde(default = "default_reason")]
    pub reason: String,
}

fn default_reason() -> String {
    "hangup".to_string()
}

#[derive(Deserialize)]
pub struct SimSmsBody {
    pub from: String,
    pub body: String,
}

/// POST /api/test/call/incoming — simulate an incoming call
pub async fn sim_incoming(
    state: Arc<PhoneState>,
    Json(body): Json<SimIncomingBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut sim = state.sim_call.lock().await;
    if sim.is_active() {
        return Err(ApiError::BadRequest(format!(
            "call already in progress (state: {})",
            sim.state
        )));
    }
    sim.state = "ringing".to_string();
    sim.number = Some(body.number.clone());
    sim.connected_at = None;
    drop(sim);

    let event = serde_json::json!({
        "event": "call.incoming",
        "data": { "number": body.number }
    });
    let _ = state.events_tx.send(event.to_string());
    eprintln!("[test_sim] call.incoming from {}", body.number);

    Ok(Json(serde_json::json!({"ok": true})))
}

/// POST /api/test/call/connect — simulate call answered/connected
pub async fn sim_connect(
    state: Arc<PhoneState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut sim = state.sim_call.lock().await;
    if sim.state != "ringing" {
        return Err(ApiError::BadRequest(format!(
            "cannot connect: call state is '{}', expected 'ringing'",
            sim.state
        )));
    }
    let number = sim.number.clone();
    sim.state = "active".to_string();
    sim.connected_at = Some(Instant::now());
    drop(sim);

    let event = serde_json::json!({
        "event": "call.connected",
        "data": { "number": number }
    });
    let _ = state.events_tx.send(event.to_string());
    eprintln!("[test_sim] call.connected");

    Ok(Json(serde_json::json!({"ok": true})))
}

/// POST /api/test/call/end — simulate call ending
pub async fn sim_end(
    state: Arc<PhoneState>,
    Json(body): Json<SimEndBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut sim = state.sim_call.lock().await;
    if !sim.is_active() {
        return Ok(Json(serde_json::json!({"ok": true, "status": "already_idle"})));
    }
    sim.state = "idle".to_string();
    sim.number = None;
    sim.connected_at = None;
    drop(sim);

    let event = serde_json::json!({
        "event": "call.ended",
        "data": { "reason": body.reason }
    });
    let _ = state.events_tx.send(event.to_string());
    eprintln!("[test_sim] call.ended reason={}", body.reason);

    Ok(Json(serde_json::json!({"ok": true})))
}

/// POST /api/test/sms/receive — simulate receiving an SMS
pub async fn sim_sms_receive(
    state: Arc<PhoneState>,
    Json(body): Json<SimSmsBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let event = serde_json::json!({
        "event": "sms.received",
        "data": { "from": body.from, "body": body.body }
    });
    let _ = state.events_tx.send(event.to_string());
    eprintln!("[test_sim] sms.received from {}", body.from);

    Ok(Json(serde_json::json!({"ok": true})))
}
