//! WebSocket endpoints for real-time communication.
//!
//! - `/ws/host/config?host_id=<id>` — registry pushes config updates to connected hosts
//! - `/ws/fleet/events` — broadcast fleet events to all subscribers

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::api::AppState;
use crate::store::RegistryStore;

// ── /ws/host/config ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct HostConfigQuery {
    pub host_id: String,
}

/// GET /ws/host/config?host_id=<id> — WebSocket upgrade for host config push
pub async fn host_config_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<HostConfigQuery>,
) -> Response {
    let host_id = query.host_id;
    eprintln!("[ws] Host config connection from '{host_id}'");
    ws.on_upgrade(move |socket| handle_host_config(socket, state.store, host_id))
}

async fn handle_host_config(socket: WebSocket, store: Arc<RegistryStore>, host_id: String) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Create a channel for this host; store it so set_config can push to it
    let (tx, mut rx) = mpsc::channel(64);
    {
        let mut senders = store.host_config_senders.write().await;
        senders.insert(host_id.clone(), tx);
    }
    eprintln!("[ws] Host '{host_id}' registered for config push");

    // Forward config push messages to the WebSocket
    let host_id_send = host_id.clone();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                        eprintln!("[ws] Host '{host_id_send}' send failed, disconnecting");
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[ws] Failed to serialize config push: {e}");
                }
            }
        }
    });

    // Drain incoming messages (Pi may send acks, we just discard them)
    let drain_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = drain_task => {},
    }

    // Cleanup: remove sender from the map
    {
        let mut senders = store.host_config_senders.write().await;
        senders.remove(&host_id);
    }
    eprintln!("[ws] Host '{host_id}' disconnected from config push");
}

// ── /ws/fleet/events ─────────────────────────────────────────────────

/// GET /ws/fleet/events — WebSocket upgrade for fleet event broadcast
pub async fn fleet_events_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    eprintln!("[ws] Fleet events subscriber connected");
    ws.on_upgrade(move |socket| handle_fleet_events(socket, state.store))
}

async fn handle_fleet_events(socket: WebSocket, store: Arc<RegistryStore>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut rx = store.events_tx.subscribe();

    // Forward broadcast events to the WebSocket
    let send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    match serde_json::to_string(&event) {
                        Ok(json) => {
                            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            eprintln!("[ws] Failed to serialize event: {e}");
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[ws] Fleet events subscriber lagged, skipped {n} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Drain incoming messages
    let drain_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = drain_task => {},
    }

    eprintln!("[ws] Fleet events subscriber disconnected");
}
