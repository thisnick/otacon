use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use crate::store::{Phone, PhoneConfig};

#[derive(Deserialize, ToSchema)]
pub struct RegisterPhoneBody {
    pub host_id: String,
    pub adb_serial: String,
    pub phone_number: Option<String>,
    pub model: Option<String>,
    pub bt_mac: Option<String>,
    pub imei: Option<String>,
    pub adapter_mac: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct DeregisterPhoneBody {
    #[allow(dead_code)]
    pub host_id: String,
    pub phone_id: String,
}

/// Register or update a phone (node-scope).
#[utoipa::path(
    post,
    path = "/api/v1/hosts/phones/register",
    request_body = RegisterPhoneBody,
    responses(
        (status = 200, description = "Phone registered", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterPhoneBody>,
) -> Json<serde_json::Value> {
    let store = &state.store;
    let now = Utc::now();
    let mut phones = store.phones.write().await;

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

/// Mark a phone as disconnected (node-scope).
#[utoipa::path(
    post,
    path = "/api/v1/hosts/phones/deregister",
    request_body = DeregisterPhoneBody,
    responses(
        (status = 200, description = "Phone deregistered", body = serde_json::Value),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
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

/// List phones (summary).
#[utoipa::path(
    get,
    path = "/api/v1/admin/phones",
    responses(
        (status = 200, description = "All phones", body = Vec<Phone>),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn list(
    State(state): State<AppState>,
) -> Json<Vec<Phone>> {
    let phones = state.store.phones.read().await;
    let mut result: Vec<Phone> = phones.values().cloned().collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Json(result)
}

/// Phone detail with host location, SIMs, and config.
#[utoipa::path(
    get,
    path = "/api/v1/admin/phones/{id}",
    params(("id" = String, Path, description = "Phone ID")),
    responses(
        (status = 200, description = "Phone detail", body = serde_json::Value),
        (status = 404, description = "Phone not found"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn get_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let store = &state.store;
    let phones = store.phones.read().await;
    let phone = phones.get(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?.clone();
    drop(phones);

    let host_info = if let Some(ref host_id) = phone.host_id {
        let hosts = store.hosts.read().await;
        hosts.get(host_id).map(|h| serde_json::json!({
            "id": h.id,
            "fqdn": h.fqdn,
            "tailscale_ip": h.tailscale_ip,
            "api_port": h.api_port,
        }))
    } else {
        None
    };

    let sims = store.sims.read().await;
    let phone_sims: Vec<serde_json::Value> = sims.values()
        .filter(|s| s.phone_id == id)
        .map(|s| serde_json::json!({
            "iccid": s.iccid,
            "phone_number": s.phone_number,
            "carrier": s.carrier,
            "slot": s.slot,
            "is_active": s.is_active,
            "is_esim": s.is_esim,
            "profile_name": s.profile_name,
        }))
        .collect();

    Ok(Json(serde_json::json!({
        "id": phone.id,
        "adb_serial": phone.adb_serial,
        "phone_number": phone.phone_number,
        "model": phone.model,
        "bt_mac": phone.bt_mac,
        "imei": phone.imei,
        "adapter_mac": phone.adapter_mac,
        "status": phone.status,
        "host": host_info,
        "sims": phone_sims,
        "config": phone.config,
        "connected_at": phone.connected_at,
        "created_at": phone.created_at,
        "updated_at": phone.updated_at,
    })))
}

/// Get phone config.
#[utoipa::path(
    get,
    path = "/api/v1/admin/phones/{id}/config",
    params(("id" = String, Path, description = "Phone ID")),
    responses(
        (status = 200, description = "Phone config", body = PhoneConfig),
        (status = 404, description = "Phone not found"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
pub async fn get_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PhoneConfig>, axum::http::StatusCode> {
    let phones = state.store.phones.read().await;
    phones.get(&id)
        .map(|p| Json(p.config.clone()))
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

/// Set phone config (pushes to host).
#[utoipa::path(
    put,
    path = "/api/v1/admin/phones/{id}/config",
    params(("id" = String, Path, description = "Phone ID")),
    request_body = PhoneConfig,
    responses(
        (status = 200, description = "Config updated", body = serde_json::Value),
        (status = 404, description = "Phone not found"),
    ),
    security(("bearer" = [])),
    tag = "Admin — Fleet"
)]
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

/// Permanently remove a phone (Pi-initiated, node-scope).
#[utoipa::path(
    delete,
    path = "/api/v1/hosts/phones/{id}",
    params(("id" = String, Path, description = "Phone ID")),
    responses(
        (status = 200, description = "Phone deleted", body = serde_json::Value),
        (status = 404, description = "Phone not found"),
    ),
    security(("bearer" = [])),
    tag = "Node"
)]
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let store = &state.store;

    let mut phones = store.phones.write().await;
    let phone = phones.remove(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let adapter_mac = phone.adapter_mac.clone();
    drop(phones);
    store.save_phones().await;

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

    let mut sims = store.sims.write().await;
    sims.retain(|_, sim| sim.phone_id != id);
    drop(sims);
    store.save_sims().await;

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
