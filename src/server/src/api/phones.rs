use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::ApiError;
use crate::AppState;
use crate::phone::PhoneConfig;

#[derive(Serialize)]
pub struct PhoneSummary {
    id: String,
    adb_serial: String,
    adapter_mac: Option<String>,
    phone_bt_mac: Option<String>,
    vnc_port: u16,
    snapshot_port: u16,
    internal_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    registry_id: Option<String>,
}

/// GET /phones — list all registered phones.
pub async fn list(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<PhoneSummary>> {
    let phones = state.phones.read().await;
    let mut result: Vec<PhoneSummary> = phones
        .values()
        .map(|ps| PhoneSummary {
            id: ps.config.id.clone(),
            adb_serial: ps.config.adb_serial.clone(),
            adapter_mac: ps.config.adapter_mac.clone(),
            phone_bt_mac: ps.config.phone_bt_mac.clone(),
            vnc_port: ps.config.vnc_port,
            snapshot_port: ps.config.snapshot_port,
            internal_port: ps.config.internal_port,
            registry_id: ps.config.registry_id.clone(),
        })
        .collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

/// GET /phones/{id} — get a specific phone's config.
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<PhoneSummary>, ApiError> {
    let phones = state.phones.read().await;
    let ps = phones.get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("phone '{id}' not found")))?;
    Ok(Json(PhoneSummary {
        id: ps.config.id.clone(),
        adb_serial: ps.config.adb_serial.clone(),
        adapter_mac: ps.config.adapter_mac.clone(),
        phone_bt_mac: ps.config.phone_bt_mac.clone(),
        vnc_port: ps.config.vnc_port,
        snapshot_port: ps.config.snapshot_port,
        internal_port: ps.config.internal_port,
        registry_id: ps.config.registry_id.clone(),
    }))
}

#[derive(Deserialize)]
pub struct RegisterBody {
    pub id: Option<String>,
    pub adb_serial: String,
    pub snapshot_port: Option<u16>,
    pub internal_port: Option<u16>,
    pub audio_backend: Option<String>,
    pub adapter_mac: Option<String>,
    pub phone_bt_mac: Option<String>,
}

/// POST /phones — register or update a phone (upsert).
pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<PhoneSummary>, ApiError> {
    let id = body.id.unwrap_or_else(|| {
        // Generate a simple ID from the serial
        let slug = body.adb_serial.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_lowercase();
        if slug.is_empty() { "phone-1".into() } else { format!("phone-{}", &slug[..slug.len().min(8)]) }
    });

    let mut phones = state.phones.write().await;

    // Upsert: if phone already exists, update mutable fields and rebuild state
    if let Some(existing) = phones.get(&id) {
        let mut config = existing.config.clone();
        let mut changed = false;
        if body.adapter_mac.is_some() && body.adapter_mac != config.adapter_mac {
            config.adapter_mac = body.adapter_mac;
            changed = true;
        }
        if body.phone_bt_mac.is_some() && body.phone_bt_mac != config.phone_bt_mac {
            config.phone_bt_mac = body.phone_bt_mac;
            changed = true;
        }
        if let Some(ref backend) = body.audio_backend {
            if *backend != config.audio_backend {
                config.audio_backend = backend.clone();
                changed = true;
            }
        }

        if changed {
            // Rebuild phone state with updated config.
            // Re-use existing VNC proxy — it already holds the port and
            // will pick up the new PhoneState via Arc indirection.
            let audio_config = crate::AudioConfig::from_env();
            let phone_state = crate::create_phone_state(config.clone(), &audio_config);
            phones.insert(id.clone(), phone_state);

            // Persist to disk
            let configs: Vec<PhoneConfig> = phones.values().map(|p| p.config.clone()).collect();
            drop(phones);
            crate::phone::save_phones(&state.config_path, &configs).await.ok();

            let event = serde_json::json!({"event": "phone.updated", "data": {"id": id}});
            let _ = state.system_events_tx.send(event.to_string());
        } else {
            drop(phones);
        }

        return Ok(Json(PhoneSummary {
            id: config.id,
            adb_serial: config.adb_serial,
            adapter_mac: config.adapter_mac,
            phone_bt_mac: config.phone_bt_mac,
            vnc_port: config.vnc_port,
            snapshot_port: config.snapshot_port,
            internal_port: config.internal_port,
            registry_id: config.registry_id,
        }));
    }

    // New phone — allocate ports
    let snapshot_port = body.snapshot_port.unwrap_or_else(|| {
        let used: Vec<u16> = phones.values().map(|p| p.config.snapshot_port).collect();
        (9091..).find(|p| !used.contains(p)).unwrap()
    });
    let internal_port = body.internal_port.unwrap_or_else(|| {
        let used: Vec<u16> = phones.values().map(|p| p.config.internal_port).collect();
        (8081..).find(|p| !used.contains(p)).unwrap()
    });

    let config = PhoneConfig {
        id: id.clone(),
        adb_serial: body.adb_serial.clone(),
        adapter_mac: body.adapter_mac,
        phone_bt_mac: body.phone_bt_mac,
        display_num: 50 + phones.len() as u16,
        vnc_port: 5900 + phones.len() as u16,
        snapshot_port,
        internal_port,
        audio_backend: body.audio_backend.unwrap_or_else(|| "alsa".into()),
        registry_id: None,
    };

    let audio_config = crate::AudioConfig::from_env();
    let phone_state = crate::create_phone_state(config.clone(), &audio_config);

    // Start lazy VNC proxy for this phone
    crate::spawn_vnc_proxy(phone_state.clone());

    phones.insert(id.clone(), phone_state);

    // Persist to disk
    let configs: Vec<PhoneConfig> = phones.values().map(|p| p.config.clone()).collect();
    drop(phones);
    crate::phone::save_phones(&state.config_path, &configs).await.ok();

    // Broadcast system event
    let event = serde_json::json!({"event": "phone.added", "data": {"id": id}});
    let _ = state.system_events_tx.send(event.to_string());

    Ok(Json(PhoneSummary {
        id: config.id,
        adb_serial: config.adb_serial,
        adapter_mac: config.adapter_mac,
        phone_bt_mac: config.phone_bt_mac,
        vnc_port: config.vnc_port,
        snapshot_port: config.snapshot_port,
        internal_port: config.internal_port,
        registry_id: config.registry_id,
    }))
}

/// DELETE /phones/{id} — remove a phone.
pub async fn remove(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut phones = state.phones.write().await;
    if phones.remove(&id).is_none() {
        return Err(ApiError::NotFound(format!("phone '{id}' not found")));
    }

    // Persist to disk
    let configs: Vec<PhoneConfig> = phones.values().map(|p| p.config.clone()).collect();
    drop(phones);
    crate::phone::save_phones(&state.config_path, &configs).await.ok();

    // Broadcast system event
    let event = serde_json::json!({"event": "phone.removed", "data": {"id": id}});
    let _ = state.system_events_tx.send(event.to_string());

    Ok(Json(serde_json::json!({"ok": true})))
}
