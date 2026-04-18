use axum::extract::Path;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

use super::adb::{adb_shell, parse_content_row};
use super::{ApiError, OkResponse};
use crate::phone::PhoneState;

#[derive(Serialize, ToSchema)]
pub struct SmsThread {
    thread_id: i64,
    address: String,
    snippet: String,
    date: String,
}

#[derive(Serialize, ToSchema)]
pub struct SmsMessage {
    id: i64,
    address: String,
    body: String,
    date: String,
    #[serde(rename = "type")]
    msg_type: String,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct SendSmsBody {
    pub to: String,
    pub body: String,
}

#[utoipa::path(
    get,
    path = "/api/sms/threads",
    tag = "SMS",
    operation_id = "listSmsThreads",
    responses((status = 200, body = Vec<SmsThread>))
)]
pub async fn threads_handler(serial: &str) -> Result<Json<Vec<SmsThread>>, ApiError> {
    // Query SMS threads via content provider
    // Note: Android doesn't have a clean "threads" content URI with snippets,
    // so we query sms grouped by thread_id, taking the latest message per thread.
    let out = adb_shell(serial,
        "content query --uri content://sms --projection thread_id:address:body:date --sort 'date DESC'"
    ).await?;

    let mut threads: Vec<SmsThread> = Vec::new();
    let mut seen_threads = std::collections::HashSet::new();

    for line in out.lines() {
        if let Some(row) = parse_content_row(line) {
            let thread_id = row.get("thread_id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            if thread_id == 0 || !seen_threads.insert(thread_id) {
                continue;
            }
            threads.push(SmsThread {
                thread_id,
                address: row.get("address").cloned().unwrap_or_default(),
                snippet: row.get("body").cloned().unwrap_or_default(),
                date: row.get("date").cloned().unwrap_or_default(),
            });
        }
    }

    Ok(Json(threads))
}

#[utoipa::path(
    get,
    path = "/api/sms/threads/{id}/messages",
    tag = "SMS",
    operation_id = "getSmsMessages",
    params(("id" = String, Path)),
    responses((status = 200, body = Vec<SmsMessage>))
)]
pub async fn messages_handler(serial: &str, Path(thread_id): Path<String>) -> Result<Json<Vec<SmsMessage>>, ApiError> {
    let out = adb_shell(serial, &format!(
        "content query --uri content://sms --projection _id:address:body:date:type --where \"thread_id={}\" --sort 'date ASC'",
        thread_id
    )).await?;

    let mut messages = Vec::new();
    for line in out.lines() {
        if let Some(row) = parse_content_row(line) {
            messages.push(SmsMessage {
                id: row.get("_id").and_then(|v| v.parse().ok()).unwrap_or(0),
                address: row.get("address").cloned().unwrap_or_default(),
                body: row.get("body").cloned().unwrap_or_default(),
                date: row.get("date").cloned().unwrap_or_default(),
                msg_type: match row.get("type").map(String::as_str) {
                    Some("1") => "received".to_string(),
                    Some("2") => "sent".to_string(),
                    Some(other) => other.to_string(),
                    None => "unknown".to_string(),
                },
            });
        }
    }

    Ok(Json(messages))
}

#[utoipa::path(
    post,
    path = "/api/sms/messages",
    tag = "SMS",
    operation_id = "sendSms",
    request_body = SendSmsBody,
    responses((status = 200, body = OkResponse))
)]
pub async fn send_handler(state: Arc<PhoneState>, Json(body): Json<SendSmsBody>) -> Result<Json<serde_json::Value>, ApiError> {
    let serial = &state.config.adb_serial;
    let to_encoded = urlencoding::encode(&body.to);
    let body_encoded = urlencoding::encode(&body.body);
    state.bridge.device_query(serial,
        &format!("sms/send?to={to_encoded}&body={body_encoded}")
    ).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

