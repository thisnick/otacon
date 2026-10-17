use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::phone::PhoneState;

#[derive(Deserialize)]
pub struct DeviceEvent {
    pub event: String,
    pub data: serde_json::Value,
}

/// Receives push events from the phone (the kiosk's call/SMS watcher via adb
/// reverse) and from fleet-agent.
///
/// Call events feed the voice controller (caller ID fallback, and call state
/// while HFP is down), which publishes its own `call.*` events. Everything
/// else is republished on /ws/events as `{"type": event, "ts": ..., ...data}`.
pub async fn event_handler(
    state: Arc<PhoneState>,
    Json(body): Json<DeviceEvent>,
) -> Json<serde_json::Value> {
    eprintln!("[internal] [{}] {} from device", state.config.id, body.event);
    match body.event.as_str() {
        "call.incoming" | "call.connected" | "call.ended" => {
            state.voice.kiosk_event(&body.event, &body.data);
        }
        "monitor_status" => {
            if let Some(status) = body.data.get("status") {
                *state.monitor_status.lock().await = Some(status.clone());
            }
        }
        _ => state.emit_event(&body.event, body.data),
    }
    Json(serde_json::json!({"ok": true}))
}
