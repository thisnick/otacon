use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use utoipa::ToSchema;

use super::adb::adb_shell;
use super::autotap;
use super::ApiError;
use crate::phone::PhoneState;

#[derive(Serialize, ToSchema)]
pub struct EsimProfile {
    #[serde(rename = "subId")]
    sub_id: i64,
    iccid: String,
    carrier: String,
    slot: i64,
    embedded: bool,
    enabled: bool,
    #[serde(rename = "isDefault")]
    is_default: bool,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct InstallBody {
    #[serde(rename = "activationCode")]
    activation_code: String,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct SwitchBody {
    #[serde(rename = "subId")]
    sub_id: i64,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct EnableBody {
    #[serde(rename = "subId")]
    sub_id: i64,
    enabled: bool,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct DeleteBody {
    #[serde(rename = "subId")]
    sub_id: i64,
}

#[derive(Serialize, ToSchema)]
pub struct EsimDefaults {
    #[serde(rename = "smsSubId")]
    sms_sub_id: Option<i64>,
    #[serde(rename = "voiceSubId")]
    voice_sub_id: Option<i64>,
    #[serde(rename = "dataSubId")]
    data_sub_id: Option<i64>,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct SetDefaultsBody {
    #[serde(rename = "smsSubId")]
    sms_sub_id: Option<i64>,
    #[serde(rename = "voiceSubId")]
    voice_sub_id: Option<i64>,
    #[serde(rename = "dataSubId")]
    data_sub_id: Option<i64>,
}

// --- List all profiles via dumpsys isub ---

#[utoipa::path(
    get,
    path = "/api/esim/profiles",
    tag = "eSIM",
    operation_id = "listEsimProfiles",
    responses((status = 200, body = Vec<EsimProfile>))
)]
pub async fn profiles_handler(state: Arc<PhoneState>) -> Result<Json<Vec<EsimProfile>>, ApiError> {
    let serial = &state.config.adb_serial;
    // Get active profiles from app_process (has unmasked ICCIDs)
    let active_json = state.bridge.snapshot_get("/esim/profiles").await.unwrap_or_default();
    let active: Vec<serde_json::Value> = serde_json::from_str(&active_json).unwrap_or_default();

    // Build map of active profiles by subId
    let mut active_map = std::collections::HashMap::new();
    for p in &active {
        if let Some(sub_id) = p.get("subId").and_then(|v| v.as_i64()) {
            active_map.insert(sub_id, p);
        }
    }

    // Get default SMS subId
    let default_sms = adb_shell(serial, "settings get global multi_sim_sms").await
        .unwrap_or_default().trim().parse::<i64>().unwrap_or(-1);

    // Parse dumpsys for ALL embedded profiles (including disabled)
    let dump = adb_shell(serial, "dumpsys isub").await?;
    let mut profiles = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    for chunk in dump.split("[SubscriptionInfoInternal:") {
        if !chunk.contains("isEmbedded=1") {
            continue;
        }

        let sub_id = parse_dump_field_i64(chunk, "id");
        if sub_id < 0 || !seen_ids.insert(sub_id) {
            continue;
        }

        let slot = parse_dump_field_i64(chunk, "simSlotIndex");
        let apps_enabled = parse_dump_field_i64(chunk, "areUiccApplicationsEnabled") == 1;

        // Use unmasked data from active profiles if available
        let (iccid, carrier) = if let Some(ap) = active_map.get(&sub_id) {
            (
                ap.get("iccid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                ap.get("carrier").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            )
        } else {
            (
                parse_dump_field_str(chunk, "iccId"),
                parse_dump_field_str(chunk, "carrierName"),
            )
        };

        if iccid.is_empty() {
            continue;
        }

        profiles.push(EsimProfile {
            sub_id,
            iccid,
            carrier,
            slot,
            embedded: true,
            enabled: slot >= 0 && apps_enabled,
            is_default: sub_id == default_sms,
        });
    }

    // Also add active physical SIM (not embedded)
    for p in &active {
        let embedded = p.get("embedded").and_then(|v| v.as_bool()).unwrap_or(false);
        let sub_id = p.get("subId").and_then(|v| v.as_i64()).unwrap_or(-1);
        if !embedded && sub_id >= 0 && !seen_ids.contains(&sub_id) {
            profiles.push(EsimProfile {
                sub_id,
                iccid: p.get("iccid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                carrier: p.get("carrier").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                slot: p.get("slot").and_then(|v| v.as_i64()).unwrap_or(-1),
                embedded: false,
                enabled: true,
                is_default: sub_id == default_sms,
            });
        }
    }

    // Sort by subId
    profiles.sort_by_key(|p| p.sub_id);

    Ok(Json(profiles))
}

// --- Install via Device Owner ContentProvider ---

#[utoipa::path(
    post,
    path = "/api/esim/install",
    tag = "eSIM",
    operation_id = "installEsimProfile",
    request_body = InstallBody,
    responses((status = 200, body = serde_json::Value))
)]
pub async fn install_handler(state: Arc<PhoneState>, Json(body): Json<InstallBody>) -> Result<Json<serde_json::Value>, ApiError> {
    let serial = &state.config.adb_serial;
    let encoded = urlencoding::encode(&body.activation_code);

    // Spawn background auto-tapper for the carrier confirmation dialog
    // ("Allow your carrier to set up eSIM?" → tap "Yes"). The context
    // keywords ensure we only tap when the eSIM dialog is actually visible —
    // not a random button elsewhere in the UI.
    static ESIM_CONFIRM_BUTTONS: &[&str] = &["yes", "allow", "ok", "confirm"];
    static ESIM_CONFIRM_CONTEXT: &[&str] = &["esim", "carrier", "set up"];
    let tap_handle = autotap::spawn_auto_tap(
        state.clone(),
        ESIM_CONFIRM_BUTTONS,
        ESIM_CONFIRM_CONTEXT,
        Duration::from_secs(120),
    );

    let output = adb_shell(serial, &format!(
        "content query --uri 'content://com.otacon.kiosk/esim/install?activationCode={encoded}'"
    )).await?;

    // Cancel the auto-tapper if still running
    tap_handle.abort();

    parse_content_result(&output)
}

// --- Delete via Device Owner ContentProvider ---

#[utoipa::path(
    post,
    path = "/api/esim/delete",
    tag = "eSIM",
    operation_id = "deleteEsimProfile",
    request_body = DeleteBody,
    responses((status = 200, body = serde_json::Value))
)]
pub async fn delete_handler(serial: &str, Json(body): Json<DeleteBody>) -> Result<Json<serde_json::Value>, ApiError> {
    let output = adb_shell(serial, &format!(
        "content query --uri 'content://com.otacon.kiosk/esim/delete?subId={}'",
        body.sub_id
    )).await?;

    parse_content_result(&output)
}

// --- Switch via app_process snapshot server ---

#[utoipa::path(
    post,
    path = "/api/esim/switch",
    tag = "eSIM",
    operation_id = "switchEsimProfile",
    request_body = SwitchBody,
    responses((status = 200, body = serde_json::Value))
)]
pub async fn switch_handler(state: Arc<PhoneState>, Json(body): Json<SwitchBody>) -> Result<Json<serde_json::Value>, ApiError> {
    let resp = state.bridge.snapshot_get(&format!("/esim/switch?subId={}", body.sub_id)).await?;
    let parsed: serde_json::Value = serde_json::from_str(&resp)
        .map_err(|e| ApiError::Adb(format!("Invalid response: {e}")))?;

    if parsed.get("error").is_some() {
        return Err(ApiError::Adb(parsed["error"].as_str().unwrap_or("unknown").to_string()));
    }
    Ok(Json(parsed))
}

// --- Enable/Disable via app_process snapshot server ---

#[utoipa::path(
    post,
    path = "/api/esim/enable",
    tag = "eSIM",
    operation_id = "enableEsimProfile",
    request_body = EnableBody,
    responses((status = 200, body = serde_json::Value))
)]
pub async fn enable_handler(state: Arc<PhoneState>, Json(body): Json<EnableBody>) -> Result<Json<serde_json::Value>, ApiError> {
    let resp = state.bridge.snapshot_get(&format!(
        "/esim/enable?subId={}&enabled={}", body.sub_id, body.enabled
    )).await?;
    let parsed: serde_json::Value = serde_json::from_str(&resp)
        .map_err(|e| ApiError::Adb(format!("Invalid response: {e}")))?;

    if parsed.get("error").is_some() {
        return Err(ApiError::Adb(parsed["error"].as_str().unwrap_or("unknown").to_string()));
    }
    Ok(Json(parsed))
}

// --- Defaults via ADB settings ---

#[utoipa::path(
    get,
    path = "/api/esim/defaults",
    tag = "eSIM",
    operation_id = "getEsimDefaults",
    responses((status = 200, body = EsimDefaults))
)]
pub async fn defaults_get_handler(serial: &str) -> Result<Json<EsimDefaults>, ApiError> {
    let sms = adb_shell(serial, "settings get global multi_sim_sms").await
        .unwrap_or_default().trim().parse::<i64>().ok();
    let voice = adb_shell(serial, "settings get global multi_sim_voice").await
        .unwrap_or_default().trim().parse::<i64>().ok();
    let data = adb_shell(serial, "settings get global multi_sim_data_call").await
        .unwrap_or_default().trim().parse::<i64>().ok();

    Ok(Json(EsimDefaults {
        sms_sub_id: sms,
        voice_sub_id: voice,
        data_sub_id: data,
    }))
}

#[utoipa::path(
    put,
    path = "/api/esim/defaults",
    tag = "eSIM",
    operation_id = "setEsimDefaults",
    request_body = SetDefaultsBody,
    responses((status = 200, body = serde_json::Value))
)]
pub async fn defaults_set_handler(serial: &str, Json(body): Json<SetDefaultsBody>) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(sms) = body.sms_sub_id {
        adb_shell(serial, &format!("settings put global multi_sim_sms {sms}")).await?;
    }
    if let Some(voice) = body.voice_sub_id {
        adb_shell(serial, &format!("settings put global multi_sim_voice {voice}")).await?;
    }
    if let Some(data) = body.data_sub_id {
        adb_shell(serial, &format!("settings put global multi_sim_data_call {data}")).await?;
    }
    Ok(Json(serde_json::json!({"ok": true})))
}

// --- Helpers ---

fn parse_dump_field_i64(chunk: &str, field: &str) -> i64 {
    // Match: field=123 followed by space or end
    let prefix = format!("{field}=");
    if let Some(start) = chunk.find(&prefix) {
        let rest = &chunk[start + prefix.len()..];
        let end = rest.find(|c: char| !c.is_ascii_digit() && c != '-').unwrap_or(rest.len());
        rest[..end].parse().unwrap_or(-1)
    } else {
        -1
    }
}

fn parse_dump_field_str(chunk: &str, field: &str) -> String {
    let prefix = format!("{field}=");
    if let Some(start) = chunk.find(&prefix) {
        let rest = &chunk[start + prefix.len()..];
        let end = rest.find(' ').unwrap_or(rest.len());
        rest[..end].to_string()
    } else {
        String::new()
    }
}

fn parse_content_result(output: &str) -> Result<Json<serde_json::Value>, ApiError> {
    // Parse "Row: 0 key=value, key=value, ..." format
    if output.contains("error=") {
        let err = output.split("error=").nth(1).unwrap_or(output).trim();
        return Err(ApiError::Adb(err.to_string()));
    }

    let mut result = serde_json::Map::new();
    if let Some(row) = output.strip_prefix("Row: 0 ") {
        for pair in row.split(", ") {
            if let Some((k, v)) = pair.split_once('=') {
                let key = k.trim().to_string();
                let val = v.trim();
                if val == "true" {
                    result.insert(key, serde_json::Value::Bool(true));
                } else if val == "false" {
                    result.insert(key, serde_json::Value::Bool(false));
                } else if val == "NULL" {
                    result.insert(key, serde_json::Value::Null);
                } else if let Ok(n) = val.parse::<i64>() {
                    result.insert(key, serde_json::json!(n));
                } else {
                    result.insert(key, serde_json::Value::String(val.to_string()));
                }
            }
        }
    }

    Ok(Json(serde_json::Value::Object(result)))
}
