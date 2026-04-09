use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use utoipa::ToSchema;

use super::adb::adb_shell;
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
    adb_shell(&format!(
        "am start -a android.intent.action.CALL -d tel:{}",
        body.number.replace(' ', "")
    )).await?;

    let event = serde_json::json!({
        "event": "call.dialing",
        "data": { "number": body.number }
    });
    let _ = state.events_tx.send(event.to_string());

    Ok(Json(serde_json::json!({ "ok": true, "number": body.number })))
}

#[utoipa::path(
    post,
    path = "/api/calls/answer",
    tag = "Calls",
    operation_id = "answerCall",
    responses((status = 200, body = OkResponse))
)]
pub async fn answer_handler(_state: Arc<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    adb_shell("input keyevent KEYCODE_CALL").await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[utoipa::path(
    post,
    path = "/api/calls/hangup",
    tag = "Calls",
    operation_id = "hangupCall",
    responses((status = 200, body = OkResponse))
)]
pub async fn hangup_handler(_state: Arc<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    adb_shell("input keyevent KEYCODE_ENDCALL").await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[utoipa::path(
    get,
    path = "/api/calls/status",
    tag = "Calls",
    operation_id = "getCallStatus",
    responses((status = 200, body = CallStatus))
)]
pub async fn status_handler(state: Arc<AppState>) -> Result<Json<CallStatus>, ApiError> {
    // Try ADB first
    if let Ok(status) = query_call_state_adb().await {
        return Ok(Json(status));
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

/// Query call state via `adb shell dumpsys telephony.registry`
async fn query_call_state_adb() -> Result<CallStatus, ApiError> {
    let out = adb_shell("dumpsys telephony.registry | grep -E 'mCallState|mCallIncomingNumber'").await?;

    let mut call_state = 0i32;
    let mut number: Option<String> = None;

    for line in out.lines() {
        let trimmed = line.trim();
        if let Some(val) = trimmed.strip_prefix("mCallState=") {
            call_state = val.trim().parse().unwrap_or(0);
        }
        if let Some(val) = trimmed.strip_prefix("mCallIncomingNumber=") {
            let n = val.trim().to_string();
            if !n.is_empty() {
                number = Some(n);
            }
        }
    }

    let state = match call_state {
        0 => "idle",
        1 => "ringing",
        2 => "active",
        _ => "idle",
    };

    Ok(CallStatus {
        state: state.to_string(),
        number,
        duration: None,
    })
}

/// Background task that polls call state via ADB and emits events on /ws/events.
pub fn spawn_call_state_monitor(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut last_state = "idle".to_string();
        let mut last_number: Option<String> = None;

        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            let status = match query_call_state_adb().await {
                Ok(s) => s,
                Err(_) => continue,
            };

            if status.state != last_state {
                let event = match status.state.as_str() {
                    "ringing" => Some(serde_json::json!({
                        "event": "call.incoming",
                        "data": { "number": &status.number }
                    })),
                    "active" => Some(serde_json::json!({
                        "event": "call.connected",
                        "data": { "number": status.number.as_deref().or(last_number.as_deref()) }
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
                    eprintln!("[calls] {} -> {}", last_state, status.state);
                }

                last_state = status.state.clone();
                last_number = status.number;
            }
        }
    });
}
