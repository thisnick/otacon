use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use utoipa::ToSchema;

use super::{ApiError, OkResponse};
use crate::AppState;

#[derive(Deserialize, Serialize, ToSchema)]
pub struct DialBody {
    pub number: String,
}

#[derive(Serialize, ToSchema)]
pub struct CallStatus {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
}

#[utoipa::path(
    post,
    path = "/api/calls/dial",
    tag = "Calls",
    operation_id = "dialCall",
    request_body = DialBody,
    responses((status = 200, body = OkResponse))
)]
pub async fn dial_handler(state: Arc<AppState>, Json(body): Json<DialBody>) -> Result<Json<serde_json::Value>, ApiError> {
    let payload = serde_json::json!({ "number": body.number });
    let result = state.bridge.device_post("/call/dial", &payload.to_string()).await?;
    let parsed: serde_json::Value = serde_json::from_str(&result)
        .map_err(|e| ApiError::Adb(format!("Invalid response: {e}")))?;

    // Emit call event on WebSocket
    let event = serde_json::json!({
        "event": "call.dialing",
        "data": { "number": body.number }
    });
    let _ = state.events_tx.send(event.to_string());

    Ok(Json(parsed))
}

#[utoipa::path(
    post,
    path = "/api/calls/answer",
    tag = "Calls",
    operation_id = "answerCall",
    responses((status = 200, body = OkResponse))
)]
pub async fn answer_handler(state: Arc<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let result = state.bridge.device_post("/call/answer", "{}").await?;
    let parsed: serde_json::Value = serde_json::from_str(&result)
        .map_err(|e| ApiError::Adb(format!("Invalid response: {e}")))?;
    Ok(Json(parsed))
}

#[utoipa::path(
    post,
    path = "/api/calls/hangup",
    tag = "Calls",
    operation_id = "hangupCall",
    responses((status = 200, body = OkResponse))
)]
pub async fn hangup_handler(state: Arc<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let result = state.bridge.device_post("/call/hangup", "{}").await?;
    let parsed: serde_json::Value = serde_json::from_str(&result)
        .map_err(|e| ApiError::Adb(format!("Invalid response: {e}")))?;
    Ok(Json(parsed))
}

#[utoipa::path(
    get,
    path = "/api/calls/status",
    tag = "Calls",
    operation_id = "getCallStatus",
    responses((status = 200, body = CallStatus))
)]
pub async fn status_handler(state: Arc<AppState>) -> Result<Json<CallStatus>, ApiError> {
    // Try device owner bridge first; fall back to sim state
    if let Ok(result) = state.bridge.device_get("/call/status").await {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&result) {
            return Ok(Json(CallStatus {
                state: parsed["state"].as_str().unwrap_or("idle").to_string(),
                number: parsed["number"].as_str().map(String::from),
                duration: parsed["duration"].as_u64(),
            }));
        }
    }

    // Fall back to simulated call state
    let sim = state.sim_call.lock().await;
    let duration = sim.connected_at.map(|t| t.elapsed().as_secs());
    Ok(Json(CallStatus {
        state: if sim.state.is_empty() { "idle".to_string() } else { sim.state.clone() },
        number: sim.number.clone(),
        duration,
    }))
}

/// Background task that polls the device owner app's call status
/// and emits call.incoming / call.connected / call.ended events on /ws/events.
pub fn spawn_call_state_monitor(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut last_state = "idle".to_string();
        let mut last_number: Option<String> = None;

        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            if !state.bridge.is_device_owner_available() {
                continue;
            }

            let body = match state.bridge.device_get("/call/status").await {
                Ok(b) => b,
                Err(_) => continue,
            };
            let parsed: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let new_state = parsed["state"].as_str().unwrap_or("idle");
            let new_number = parsed["number"].as_str().map(String::from);

            if new_state != last_state {
                let event = match new_state {
                    "ringing" => Some(serde_json::json!({
                        "event": "call.incoming",
                        "data": { "number": &new_number }
                    })),
                    "active" => Some(serde_json::json!({
                        "event": "call.connected",
                        "data": { "number": new_number.as_deref().or(last_number.as_deref()) }
                    })),
                    "idle" if last_state != "idle" => {
                        let reason = if last_state == "ringing" { "rejected" } else { "hangup" };
                        Some(serde_json::json!({
                            "event": "call.ended",
                            "data": { "reason": reason }
                        }))
                    }
                    _ => None,
                };

                if let Some(event) = event {
                    let _ = state.events_tx.send(event.to_string());
                    eprintln!("[calls] {} -> {}", last_state, new_state);
                }

                last_state = new_state.to_string();
                last_number = new_number;
            }
        }
    });
}
