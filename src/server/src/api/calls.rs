use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
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
    // Prefer bridge (device owner app) → fallback to ADB
    let payload = serde_json::json!({"number": body.number});
    if state.bridge.device_post("/call/dial", &payload.to_string()).await.is_err() {
        adb_shell(&format!(
            "am start -a android.intent.action.CALL -d tel:{}",
            body.number.replace(' ', "")
        )).await?;
    }

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
pub async fn answer_handler(state: Arc<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    if state.bridge.device_post("/call/answer", "{}").await.is_err() {
        adb_shell("input keyevent KEYCODE_CALL").await?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[utoipa::path(
    post,
    path = "/api/calls/hangup",
    tag = "Calls",
    operation_id = "hangupCall",
    responses((status = 200, body = OkResponse))
)]
pub async fn hangup_handler(state: Arc<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    if state.bridge.device_post("/call/hangup", "{}").await.is_err() {
        adb_shell("input keyevent KEYCODE_ENDCALL").await?;
    }
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
    // Check push-event state first (updated by internal.rs and test_sim.rs)
    {
        let sim = state.sim_call.lock().await;
        if !sim.state.is_empty() && sim.state != "idle" {
            let duration = sim.connected_at.map(|t| t.elapsed().as_secs());
            return Ok(Json(CallStatus {
                state: sim.state.clone(),
                number: sim.number.clone(),
                duration,
            }));
        }
    }

    // Fall back to ADB query (works even without push events)
    if let Ok(status) = query_call_state_adb().await {
        return Ok(Json(status));
    }

    Ok(Json(CallStatus {
        state: "idle".to_string(),
        number: None,
        duration: None,
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

