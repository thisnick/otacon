use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use super::ApiError;
use crate::phone::PhoneState;

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

/// POST /api/test/call/incoming — simulate an incoming call, as if the
/// kiosk's call watcher reported it
pub async fn sim_incoming(
    state: Arc<PhoneState>,
    Json(body): Json<SimIncomingBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.voice.kiosk_event("call.incoming", &serde_json::json!({"number": body.number}));
    eprintln!("[test_sim] call.incoming from {}", body.number);
    Ok(Json(serde_json::json!({"ok": true})))
}

/// POST /api/test/call/connect — simulate the call going off-hook
pub async fn sim_connect(
    state: Arc<PhoneState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.voice.kiosk_event("call.connected", &serde_json::json!({}));
    eprintln!("[test_sim] call.connected");
    Ok(Json(serde_json::json!({"ok": true})))
}

/// POST /api/test/call/end — simulate the call ending
pub async fn sim_end(
    state: Arc<PhoneState>,
    Json(body): Json<SimEndBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.voice.kiosk_event("call.ended", &serde_json::json!({"reason": body.reason}));
    eprintln!("[test_sim] call.ended reason={}", body.reason);
    Ok(Json(serde_json::json!({"ok": true})))
}

/// POST /api/test/sms/receive — simulate receiving an SMS
pub async fn sim_sms_receive(
    state: Arc<PhoneState>,
    Json(body): Json<SimSmsBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.emit_event("sms.received", serde_json::json!({"from": body.from, "body": body.body}));
    eprintln!("[test_sim] sms.received from {}", body.from);
    Ok(Json(serde_json::json!({"ok": true})))
}
