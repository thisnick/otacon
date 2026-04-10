use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct DeviceEvent {
    pub event: String,
    pub data: serde_json::Value,
}

/// Receives push events from the device owner app (via adb reverse).
/// Broadcasts them on /ws/events and updates call state for /api/calls/status.
pub async fn event_handler(
    state: Arc<AppState>,
    Json(body): Json<DeviceEvent>,
) -> Json<serde_json::Value> {
    let event = serde_json::json!({
        "event": body.event,
        "data": body.data,
    });
    let _ = state.events_tx.send(event.to_string());
    eprintln!("[internal] {} from device", body.event);

    // Update sim_call state so /api/calls/status reflects push events
    match body.event.as_str() {
        "call.incoming" => {
            let mut sim = state.sim_call.lock().await;
            sim.state = "ringing".to_string();
            sim.number = body.data.get("number").and_then(|v| v.as_str()).map(String::from);
            sim.connected_at = None;
        }
        "call.connected" => {
            let mut sim = state.sim_call.lock().await;
            sim.state = "active".to_string();
            if let Some(n) = body.data.get("number").and_then(|v| v.as_str()) {
                sim.number = Some(n.to_string());
            }
            sim.connected_at = Some(std::time::Instant::now());
        }
        "call.ended" => {
            let mut sim = state.sim_call.lock().await;
            sim.state = "idle".to_string();
            sim.number = None;
            sim.connected_at = None;
        }
        _ => {}
    }

    Json(serde_json::json!({"ok": true}))
}
