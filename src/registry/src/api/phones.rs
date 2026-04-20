use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;

use super::AppState;
use crate::store::{Phone, PhoneConfig};

#[derive(Deserialize)]
pub struct RegisterPhoneBody {
    pub host_id: String,
    pub adb_serial: String,
    pub phone_number: Option<String>,
    pub model: Option<String>,
    pub bt_mac: Option<String>,
    pub imei: Option<String>,
    pub adapter_mac: Option<String>,
}

#[derive(Deserialize)]
pub struct DeregisterPhoneBody {
    #[allow(dead_code)]
    pub host_id: String,
    pub phone_id: String,
}

#[derive(Deserialize)]
pub struct UpdatePhoneBody {
    pub id: Option<String>,
    pub phone_number: Option<String>,
    pub model: Option<String>,
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterPhoneBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let now = Utc::now();
    let mut phones = store.phones.write().await;

    // Match existing phone by IMEI first, then adb_serial
    let existing_id = if let Some(ref imei) = body.imei {
        phones.iter()
            .find(|(_, p)| p.imei.as_deref() == Some(imei))
            .map(|(id, _)| id.clone())
    } else {
        None
    }.or_else(|| {
        phones.iter()
            .find(|(_, p)| p.adb_serial == body.adb_serial)
            .map(|(id, _)| id.clone())
    });

    if let Some(id) = existing_id {
        // Update existing phone
        let phone = phones.get_mut(&id).unwrap();
        let old_host = phone.host_id.clone();
        phone.host_id = Some(body.host_id.clone());
        phone.status = "connected".into();
        phone.connected_at = Some(now);
        phone.updated_at = now;
        if body.phone_number.is_some() { phone.phone_number = body.phone_number; }
        if body.model.is_some() { phone.model = body.model; }
        if body.bt_mac.is_some() { phone.bt_mac = body.bt_mac; }
        if body.imei.is_some() { phone.imei = body.imei; }
        if body.adapter_mac.is_some() { phone.adapter_mac = body.adapter_mac; }

        let config = phone.config.clone();
        let phone_id = id.clone();

        let adapter_mac_for_dongle = phone.adapter_mac.clone();
        drop(phones);
        if let Some(ref mac) = adapter_mac_for_dongle {
            let mut dongles = store.dongles.write().await;
            for dongle in dongles.values_mut() {
                if dongle.bt_mac.eq_ignore_ascii_case(mac) {
                    dongle.phone_id = Some(phone_id.clone());
                }
            }
            drop(dongles);
            store.save_dongles().await;
        }
        store.save_phones().await;

        if old_host.as_deref() != Some(&body.host_id) {
            store.add_event("phone.moved", Some(phone_id.clone()),
                Some(serde_json::json!({
                    "from_host": old_host,
                    "to_host": body.host_id,
                }))).await;
        } else {
            store.add_event("phone.connected", Some(phone_id.clone()), None).await;
        }

        Json(serde_json::json!({
            "phone_id": phone_id,
            "config": config,
        }))
    } else {
        let phone_id = generate_phone_id(&body, &phones);
        let config = PhoneConfig::default();

        let adapter_mac_for_dongle = body.adapter_mac.clone();
        phones.insert(phone_id.clone(), Phone {
            id: phone_id.clone(),
            adb_serial: body.adb_serial,
            phone_number: body.phone_number,
            model: body.model,
            bt_mac: body.bt_mac,
            imei: body.imei,
            adapter_mac: body.adapter_mac,
            host_id: Some(body.host_id),
            status: "connected".into(),
            config: config.clone(),
            connected_at: Some(now),
            created_at: now,
            updated_at: now,
        });
        drop(phones);
        if let Some(ref mac) = adapter_mac_for_dongle {
            let mut dongles = store.dongles.write().await;
            for dongle in dongles.values_mut() {
                if dongle.bt_mac.eq_ignore_ascii_case(mac) {
                    dongle.phone_id = Some(phone_id.clone());
                }
            }
            drop(dongles);
            store.save_dongles().await;
        }
        store.save_phones().await;
        store.add_event("phone.connected", Some(phone_id.clone()), None).await;

        Json(serde_json::json!({
            "phone_id": phone_id,
            "config": config,
        }))
    }
}

pub async fn deregister(
    State(state): State<AppState>,
    Json(body): Json<DeregisterPhoneBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let mut phones = store.phones.write().await;
    if let Some(phone) = phones.get_mut(&body.phone_id) {
        phone.host_id = None;
        phone.status = "disconnected".into();
        phone.updated_at = Utc::now();
    }
    drop(phones);
    store.save_phones().await;
    store.add_event("phone.disconnected", Some(body.phone_id), None).await;
    Json(serde_json::json!({"ok": true}))
}

pub async fn list(
    State(state): State<AppState>,
) -> Json<Vec<Phone>> {
    let phones = state.store.phones.read().await;
    let mut result: Vec<Phone> = phones.values().cloned().collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Phone>, axum::http::StatusCode> {
    let phones = state.store.phones.read().await;
    phones.get(&id)
        .cloned()
        .map(Json)
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

pub async fn location(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let store = &state.store;
    let phones = store.phones.read().await;
    let phone = phones.get(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let host_id = phone.host_id.clone();
    drop(phones);

    let host_id = host_id.ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let hosts = store.hosts.read().await;
    let host = hosts.get(&host_id).ok_or(axum::http::StatusCode::NOT_FOUND)?;

    Ok(Json(serde_json::json!({
        "phone_id": id,
        "host_id": host_id,
        "host_fqdn": host.fqdn,
        "tailscale_ip": host.tailscale_ip,
        "api_port": host.api_port,
    })))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdatePhoneBody>,
) -> Result<Json<Phone>, axum::http::StatusCode> {
    let store = &state.store;
    let mut phones = store.phones.write().await;
    let phone = phones.get_mut(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;

    if let Some(new_id) = body.id {
        let mut p = phone.clone();
        p.id = new_id.clone();
        p.updated_at = Utc::now();
        if let Some(number) = body.phone_number { p.phone_number = Some(number); }
        if let Some(model) = body.model { p.model = Some(model); }
        phones.remove(&id);
        phones.insert(new_id, p.clone());
        drop(phones);
        store.save_phones().await;
        return Ok(Json(p));
    }

    if let Some(number) = body.phone_number { phone.phone_number = Some(number); }
    if let Some(model) = body.model { phone.model = Some(model); }
    phone.updated_at = Utc::now();
    let result = phone.clone();
    drop(phones);
    store.save_phones().await;
    Ok(Json(result))
}

pub async fn get_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PhoneConfig>, axum::http::StatusCode> {
    let phones = state.store.phones.read().await;
    phones.get(&id)
        .map(|p| Json(p.config.clone()))
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

pub async fn set_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(config): Json<PhoneConfig>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let store = &state.store;
    let mut phones = store.phones.write().await;
    let phone = phones.get_mut(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
    phone.config = config.clone();
    phone.updated_at = Utc::now();
    let host_id = phone.host_id.clone();
    drop(phones);
    store.save_phones().await;

    let pushed = if let Some(ref host_id) = host_id {
        store.push_config(host_id, &id, &config).await
    } else {
        false
    };

    store.add_event("phone.config_updated", Some(id.clone()),
        Some(serde_json::json!({
            "config": config,
            "pushed": pushed,
        }))).await;

    Ok(Json(serde_json::json!({"ok": true, "pushed": pushed})))
}

/// DELETE /api/v1/phones/{id} — permanently remove a phone (Pi-initiated).
///
/// Node-scope auth: the calling host must own this phone.
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let store = &state.store;

    // Remove the phone
    let mut phones = store.phones.write().await;
    let phone = phones.remove(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let adapter_mac = phone.adapter_mac.clone();
    drop(phones);
    store.save_phones().await;

    // Clear dongle association
    if let Some(ref mac) = adapter_mac {
        let mut dongles = store.dongles.write().await;
        for dongle in dongles.values_mut() {
            if dongle.bt_mac.eq_ignore_ascii_case(mac) {
                dongle.phone_id = None;
            }
        }
        drop(dongles);
        store.save_dongles().await;
    }

    // Remove SIM records for this phone
    let mut sims = store.sims.write().await;
    sims.retain(|_, sim| sim.phone_id != id);
    drop(sims);
    store.save_sims().await;

    // Emit event
    store.add_event("phone.deleted", Some(id.clone()),
        Some(serde_json::json!({
            "adb_serial": phone.adb_serial,
            "adapter_mac": adapter_mac,
        }))).await;

    Ok(Json(serde_json::json!({"deleted": true, "phone_id": id})))
}

fn generate_phone_id(body: &RegisterPhoneBody, phones: &std::collections::HashMap<String, Phone>) -> String {
    if let Some(ref model) = body.model {
        let slug: String = model.chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect::<String>()
            .to_lowercase();
        if !slug.is_empty() {
            let candidate = format!("phone-{}", &slug[..slug.len().min(12)]);
            if !phones.contains_key(&candidate) {
                return candidate;
            }
        }
    }

    for i in 1.. {
        let candidate = format!("phone-{i}");
        if !phones.contains_key(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}
