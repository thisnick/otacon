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
    /// "connected" when bridge health checks pass, "disconnected" otherwise.
    status: String,
}

/// GET /phones — list all registered phones.
pub async fn list(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<PhoneSummary>> {
    let phones = state.phones.read().await;
    let mut result: Vec<PhoneSummary> = phones
        .values()
        .map(|ps| {
            let connected = ps.bridge.is_device_owner_available()
                || ps.bridge.is_snapshot_available();
            PhoneSummary {
                id: ps.config.id.clone(),
                adb_serial: ps.config.adb_serial.clone(),
                adapter_mac: ps.config.adapter_mac.clone(),
                phone_bt_mac: ps.config.phone_bt_mac.clone(),
                vnc_port: ps.config.vnc_port,
                snapshot_port: ps.config.snapshot_port,
                internal_port: ps.config.internal_port,
                registry_id: ps.config.registry_id.clone(),
                status: if connected { "connected" } else { "disconnected" }.into(),
            }
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
    let connected = ps.bridge.is_device_owner_available()
        || ps.bridge.is_snapshot_available();
    Ok(Json(PhoneSummary {
        id: ps.config.id.clone(),
        adb_serial: ps.config.adb_serial.clone(),
        adapter_mac: ps.config.adapter_mac.clone(),
        phone_bt_mac: ps.config.phone_bt_mac.clone(),
        vnc_port: ps.config.vnc_port,
        snapshot_port: ps.config.snapshot_port,
        internal_port: ps.config.internal_port,
        registry_id: ps.config.registry_id.clone(),
        status: if connected { "connected" } else { "disconnected" }.into(),
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
            status: "connected".into(),
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
        status: "connected".into(),
    }))
}

/// DELETE /phones/{id} — permanently remove a phone.
///
/// Returns 409 if the phone is currently connected (bridge health checks pass).
/// On success: wipes BlueZ bond, releases dongle, removes from phones.json,
/// notifies registry, drops PhoneState, emits phone.deleted event.
pub async fn remove(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut phones = state.phones.write().await;
    let ps = phones.get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("phone '{id}' not found")))?;

    // 1. Verify phone is disconnected
    let connected = ps.bridge.is_device_owner_available()
        || ps.bridge.is_snapshot_available();
    if connected {
        return Err(ApiError::Conflict(
            "phone_connected".into(),
            "Unplug the phone first.".into(),
        ));
    }

    let config = ps.config.clone();
    let registry_id = config.registry_id.clone();
    phones.remove(&id);

    // 2. Persist removal to phones.json — remove the entry for this serial
    let configs: Vec<PhoneConfig> = phones.values().map(|p| p.config.clone()).collect();
    drop(phones);
    crate::phone::save_phones(&state.config_path, &configs).await.ok();

    // Also remove from the on-disk phones.json directly (the merge-aware
    // save_phones above writes our in-memory set, but the serial may also
    // exist in fleet-agent's copy — remove it explicitly).
    remove_serial_from_phones_json(&state.config_path, &config.adb_serial).await;

    // 3. Wipe BlueZ bond directory
    if let (Some(ref adapter_mac), Some(ref phone_bt_mac)) =
        (&config.adapter_mac, &config.phone_bt_mac)
    {
        let adapter_dir = adapter_mac.replace(':', "").to_uppercase();
        let adapter_dir_colon = adapter_mac.to_uppercase();
        let phone_dir = phone_bt_mac.replace(':', "").to_uppercase();
        let phone_dir_colon = phone_bt_mac.to_uppercase();
        // Try both formats: with and without colons
        for adapter in [&adapter_dir_colon, &adapter_dir] {
            for phone in [&phone_dir_colon, &phone_dir] {
                let path = format!("/var/lib/bluetooth/{adapter}/{phone}");
                tokio::fs::remove_dir_all(&path).await.ok();
            }
        }
        eprintln!("[delete] Wiped BlueZ bond for {}/{}", adapter_mac, phone_bt_mac);
    }

    // 4. Release dongle to spare pool (via fleet-agent's phones.json —
    //    already handled by removing the entry above; the dongle's adapter_mac
    //    is no longer associated with any phone)

    // 5. Notify registry (best-effort)
    if let Some(ref reg_id) = registry_id {
        notify_registry_delete(reg_id).await;
    }

    // 6. Emit local event
    let event = serde_json::json!({
        "event": "phone.deleted",
        "data": {
            "id": id,
            "adb_serial": config.adb_serial,
            "registry_id": registry_id,
        }
    });
    let _ = state.system_events_tx.send(event.to_string());

    eprintln!("[delete] Phone '{id}' (serial: {}) permanently removed", config.adb_serial);

    Ok(Json(serde_json::json!({
        "deleted": true,
        "phone_id": id,
    })))
}

/// Remove a specific serial from the on-disk phones.json, regardless of
/// what the in-memory state contains.
async fn remove_serial_from_phones_json(path: &std::path::Path, serial: &str) {
    use tokio::io::AsyncWriteExt;

    let on_disk: Vec<PhoneConfig> = match tokio::fs::read_to_string(path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => return,
    };

    let filtered: Vec<&PhoneConfig> = on_disk.iter()
        .filter(|p| p.adb_serial != serial)
        .collect();

    if filtered.len() == on_disk.len() {
        return; // nothing to remove
    }

    let data = match serde_json::to_string_pretty(&filtered) {
        Ok(d) => d,
        Err(_) => return,
    };

    let dir = path.parent().unwrap_or(std::path::Path::new("."));
    let tmp_path = dir.join(format!(".phones_tmp_{}", std::process::id()));
    if let Ok(mut f) = tokio::fs::File::create(&tmp_path).await {
        if f.write_all(data.as_bytes()).await.is_ok()
            && f.sync_all().await.is_ok()
        {
            tokio::fs::rename(&tmp_path, path).await.ok();
        } else {
            tokio::fs::remove_file(&tmp_path).await.ok();
        }
    }
}

/// Best-effort DELETE to registry to mirror phone removal.
async fn notify_registry_delete(registry_id: &str) {
    let registry_url = match std::env::var("REGISTRY_URL") {
        Ok(url) => url.trim_end_matches('/').to_string(),
        Err(_) => return,
    };

    let token = match std::fs::read_to_string(crate::fleet::AUTH_FILE)
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
        .and_then(|json| json.get("token")?.as_str().map(|s| s.to_string()))
    {
        Some(t) => t,
        None => return,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let url = format!("{registry_url}/api/v1/phones/{registry_id}");
    match client.delete(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            eprintln!("[delete] Registry notified: deleted {registry_id}");
        }
        Ok(resp) => {
            eprintln!("[delete] Registry delete failed for {registry_id}: {}", resp.status());
        }
        Err(e) => {
            eprintln!("[delete] Registry delete error for {registry_id}: {e}");
        }
    }
}
