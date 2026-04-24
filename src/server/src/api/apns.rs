use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::adb::{adb_shell, parse_content_row};
use super::ApiError;

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApnOverride {
    pub id: i32,
    pub entry_name: String,
    pub apn_name: String,
    pub operator_numeric: String,
    pub types: String,
    pub protocol: String,
    pub roaming_protocol: String,
    pub auth_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mmsc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mms_proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mms_port: Option<i32>,
    pub enabled: bool,
}

#[derive(Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApnBody {
    #[serde(alias = "name", alias = "entry_name")]
    pub entry_name: Option<String>,
    pub apn: Option<String>,
    #[serde(alias = "operator", alias = "operator_numeric")]
    pub operator_numeric: Option<String>,
    pub types: Option<String>,
    pub protocol: Option<String>,
    #[serde(alias = "roaming_protocol")]
    pub roaming_protocol: Option<String>,
    #[serde(alias = "auth_type")]
    pub auth_type: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    #[serde(alias = "mms_url")]
    pub mmsc: Option<String>,
    #[serde(alias = "mms_proxy")]
    pub mms_proxy: Option<String>,
    #[serde(alias = "mms_port")]
    pub mms_port: Option<i32>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct ApnEnabled {
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct SetApnEnabledBody {
    pub enabled: bool,
}

#[utoipa::path(
    get,
    path = "/api/apns",
    tag = "APN",
    operation_id = "listApns",
    responses((status = 200, body = Vec<ApnOverride>))
)]
pub async fn list_handler(serial: &str) -> Result<Json<Vec<ApnOverride>>, ApiError> {
    let output = adb_shell(serial, "content query --uri 'content://com.otacon.kiosk/apns'").await?;
    Ok(Json(parse_apn_rows(&output)?))
}

#[utoipa::path(
    post,
    path = "/api/apns",
    tag = "APN",
    operation_id = "createApn",
    request_body = ApnBody,
    responses((status = 200, body = ApnOverride))
)]
pub async fn create_handler(
    serial: &str,
    Json(body): Json<ApnBody>,
) -> Result<Json<ApnOverride>, ApiError> {
    validate_create_body(&body)?;
    let query = body.to_query_params(None);
    let output = adb_shell(
        serial,
        &format!("content query --uri 'content://com.otacon.kiosk/apns/create?{query}'"),
    )
    .await?;
    Ok(Json(parse_single_apn(&output)?))
}

#[utoipa::path(
    put,
    path = "/api/apns/{apn_id}",
    tag = "APN",
    operation_id = "updateApn",
    params(("apn_id" = i32, Path, description = "Android override APN id")),
    request_body = ApnBody,
    responses((status = 200, body = ApnOverride))
)]
pub async fn update_handler(
    serial: &str,
    apn_id: i32,
    Json(body): Json<ApnBody>,
) -> Result<Json<ApnOverride>, ApiError> {
    if !body.has_any_field() {
        return Err(ApiError::BadRequest("no APN fields provided".into()));
    }
    let query = body.to_query_params(Some(apn_id));
    let output = adb_shell(
        serial,
        &format!("content query --uri 'content://com.otacon.kiosk/apns/update?{query}'"),
    )
    .await?;
    Ok(Json(parse_single_apn(&output)?))
}

#[utoipa::path(
    delete,
    path = "/api/apns/{apn_id}",
    tag = "APN",
    operation_id = "deleteApn",
    params(("apn_id" = i32, Path, description = "Android override APN id")),
    responses((status = 200, body = serde_json::Value))
)]
pub async fn delete_handler(
    serial: &str,
    apn_id: i32,
) -> Result<Json<serde_json::Value>, ApiError> {
    let output = adb_shell(
        serial,
        &format!("content query --uri 'content://com.otacon.kiosk/apns/delete?id={apn_id}'"),
    )
    .await?;
    parse_result_object(&output)
}

#[utoipa::path(
    get,
    path = "/api/apns/enabled",
    tag = "APN",
    operation_id = "getApnsEnabled",
    responses((status = 200, body = ApnEnabled))
)]
pub async fn enabled_handler(serial: &str) -> Result<Json<ApnEnabled>, ApiError> {
    let output =
        adb_shell(serial, "content query --uri 'content://com.otacon.kiosk/apns/enabled'").await?;
    Ok(Json(ApnEnabled {
        enabled: parse_bool_field(&output, "enabled")?,
    }))
}

#[utoipa::path(
    put,
    path = "/api/apns/enabled",
    tag = "APN",
    operation_id = "setApnsEnabled",
    request_body = SetApnEnabledBody,
    responses((status = 200, body = ApnEnabled))
)]
pub async fn set_enabled_handler(
    serial: &str,
    Json(body): Json<SetApnEnabledBody>,
) -> Result<Json<ApnEnabled>, ApiError> {
    let output = adb_shell(
        serial,
        &format!(
            "content query --uri 'content://com.otacon.kiosk/apns/enabled?enabled={}'",
            body.enabled
        ),
    )
    .await?;
    Ok(Json(ApnEnabled {
        enabled: parse_bool_field(&output, "enabled")?,
    }))
}

impl ApnBody {
    fn has_any_field(&self) -> bool {
        self.entry_name.is_some()
            || self.apn.is_some()
            || self.operator_numeric.is_some()
            || self.types.is_some()
            || self.protocol.is_some()
            || self.roaming_protocol.is_some()
            || self.auth_type.is_some()
            || self.user.is_some()
            || self.password.is_some()
            || self.mmsc.is_some()
            || self.mms_proxy.is_some()
            || self.mms_port.is_some()
    }

    fn to_query_params(&self, apn_id: Option<i32>) -> String {
        let mut parts = Vec::new();
        if let Some(id) = apn_id {
            parts.push(format!("id={id}"));
        }
        push_param(&mut parts, "name", self.entry_name.as_deref());
        push_param(&mut parts, "apn", self.apn.as_deref());
        push_param(&mut parts, "operator", self.operator_numeric.as_deref());
        push_param(&mut parts, "types", self.types.as_deref());
        push_param(&mut parts, "protocol", self.protocol.as_deref());
        push_param(&mut parts, "roamingProtocol", self.roaming_protocol.as_deref());
        push_param(&mut parts, "authType", self.auth_type.as_deref());
        push_param(&mut parts, "user", self.user.as_deref());
        push_param(&mut parts, "password", self.password.as_deref());
        push_param(&mut parts, "mmsc", self.mmsc.as_deref());
        push_param(&mut parts, "mmsProxy", self.mms_proxy.as_deref());
        if let Some(port) = self.mms_port {
            parts.push(format!("mmsPort={port}"));
        }
        parts.join("&")
    }
}

fn validate_create_body(body: &ApnBody) -> Result<(), ApiError> {
    required("name", body.entry_name.as_deref())?;
    required("apn", body.apn.as_deref())?;
    required("operatorNumeric", body.operator_numeric.as_deref())?;
    Ok(())
}

fn required(name: &str, value: Option<&str>) -> Result<(), ApiError> {
    if value.map(str::trim).unwrap_or_default().is_empty() {
        return Err(ApiError::BadRequest(format!("missing {name}")));
    }
    Ok(())
}

fn push_param(parts: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        parts.push(format!("{key}={}", urlencoding::encode(value)));
    }
}

fn parse_apn_rows(output: &str) -> Result<Vec<ApnOverride>, ApiError> {
    let mut rows = Vec::new();
    for line in output.lines() {
        if let Some(row) = parse_content_row(line) {
            if let Some(error) = row.get("error") {
                return Err(ApiError::Adb(error.clone()));
            }
            rows.push(apn_from_row(&row)?);
        }
    }
    Ok(rows)
}

fn parse_single_apn(output: &str) -> Result<ApnOverride, ApiError> {
    parse_apn_rows(output)?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::Adb("missing APN response row".into()))
}

fn parse_bool_field(output: &str, field: &str) -> Result<bool, ApiError> {
    let object = parse_result_object(output)?.0;
    object
        .get(field)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| ApiError::Adb(format!("missing {field} response field")))
}

fn parse_result_object(output: &str) -> Result<Json<serde_json::Value>, ApiError> {
    for line in output.lines() {
        if let Some(row) = parse_content_row(line) {
            if let Some(error) = row.get("error") {
                return Err(ApiError::Adb(error.clone()));
            }
            let mut object = serde_json::Map::new();
            for (key, value) in row {
                object.insert(key, parse_value(&value));
            }
            return Ok(Json(serde_json::Value::Object(object)));
        }
    }
    Ok(Json(serde_json::json!({})))
}

fn apn_from_row(row: &std::collections::HashMap<String, String>) -> Result<ApnOverride, ApiError> {
    Ok(ApnOverride {
        id: parse_i32(row, "id")?,
        entry_name: row.get("entryName").cloned().unwrap_or_default(),
        apn_name: row.get("apnName").cloned().unwrap_or_default(),
        operator_numeric: row.get("operatorNumeric").cloned().unwrap_or_default(),
        types: row.get("types").cloned().unwrap_or_default(),
        protocol: row.get("protocol").cloned().unwrap_or_default(),
        roaming_protocol: row.get("roamingProtocol").cloned().unwrap_or_default(),
        auth_type: row.get("authType").cloned().unwrap_or_default(),
        user: row
            .get("user")
            .filter(|value| !value.is_empty() && value.as_str() != "NULL")
            .cloned(),
        mmsc: optional_string(row, "mmsc"),
        mms_proxy: optional_string(row, "mmsProxy"),
        mms_port: optional_positive_i32(row, "mmsPort")?,
        enabled: row.get("enabled").map(|value| value == "true").unwrap_or(false),
    })
}

fn optional_string(row: &std::collections::HashMap<String, String>, key: &str) -> Option<String> {
    row.get(key)
        .filter(|value| !value.is_empty() && value.as_str() != "NULL")
        .cloned()
}

fn optional_positive_i32(
    row: &std::collections::HashMap<String, String>,
    key: &str,
) -> Result<Option<i32>, ApiError> {
    match row.get(key) {
        Some(value) if !value.is_empty() && value != "NULL" => {
            let parsed = value
                .parse::<i32>()
                .map_err(|e| ApiError::Adb(format!("invalid {key}: {e}")))?;
            Ok((parsed > 0).then_some(parsed))
        }
        _ => Ok(None),
    }
}

fn parse_i32(row: &std::collections::HashMap<String, String>, key: &str) -> Result<i32, ApiError> {
    row.get(key)
        .ok_or_else(|| ApiError::Adb(format!("missing {key}")))?
        .parse::<i32>()
        .map_err(|e| ApiError::Adb(format!("invalid {key}: {e}")))
}

fn parse_value(value: &str) -> serde_json::Value {
    if value == "true" {
        serde_json::Value::Bool(true)
    } else if value == "false" {
        serde_json::Value::Bool(false)
    } else if value == "NULL" {
        serde_json::Value::Null
    } else if let Ok(n) = value.parse::<i64>() {
        serde_json::json!(n)
    } else {
        serde_json::Value::String(value.to_string())
    }
}
