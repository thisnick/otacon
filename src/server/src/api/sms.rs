use axum::extract::Path;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::adb::{adb_shell, parse_content_row};
use super::ApiError;

#[derive(Serialize)]
pub struct SmsThread {
    thread_id: i64,
    address: String,
    snippet: String,
    date: String,
}

#[derive(Serialize)]
pub struct SmsMessage {
    id: i64,
    address: String,
    body: String,
    date: String,
    #[serde(rename = "type")]
    msg_type: String,
}

#[derive(Deserialize)]
pub struct SendSmsBody {
    pub to: String,
    pub body: String,
}

pub async fn threads_handler() -> Result<Json<Vec<SmsThread>>, ApiError> {
    // Query SMS threads via content provider
    // Note: Android doesn't have a clean "threads" content URI with snippets,
    // so we query sms grouped by thread_id, taking the latest message per thread.
    let out = adb_shell(
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

pub async fn messages_handler(Path(thread_id): Path<String>) -> Result<Json<Vec<SmsMessage>>, ApiError> {
    let out = adb_shell(&format!(
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

pub async fn send_handler(Json(body): Json<SendSmsBody>) -> Result<Json<serde_json::Value>, ApiError> {
    // Use service call isms to actually send SMS
    // Method 5 works on most Android versions
    let cmd = format!(
        "service call isms 5 i32 0 s16 \"com.android.mms.service\" s16 \"null\" s16 \"{}\" s16 \"null\" s16 \"'{}'\" s16 \"null\" s16 \"null\"",
        body.to,
        body.body.replace('\'', "\\'")
    );
    adb_shell(&cmd).await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

