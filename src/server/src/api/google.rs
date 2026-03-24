use axum::extract::{Json, Query};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::sync::Arc;

use super::ApiError;
use crate::AppState;

#[derive(Deserialize)]
pub struct TokenQuery {
    pub scope: String,
    pub account: Option<String>,
}

#[derive(Deserialize)]
pub struct SetupBody {
    pub client_id: String,
    pub client_secret: String,
}

pub async fn setup_handler(
    state: Arc<AppState>,
    Json(body): Json<SetupBody>,
) -> Result<axum::Json<serde_json::Value>, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "google setup requires device owner app (not available)".into(),
        ));
    }
    let payload = serde_json::json!({
        "client_id": body.client_id,
        "client_secret": body.client_secret,
    })
    .to_string();
    state.bridge.device_post("/google/setup", &payload).await?;
    Ok(axum::Json(serde_json::json!({"ok": true})))
}

pub async fn accounts_handler(state: Arc<AppState>) -> Result<Response, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "google accounts requires device owner app (not available)".into(),
        ));
    }
    let body = state.bridge.device_get("/google/accounts").await?;
    Ok(([("content-type", "application/json")], body).into_response())
}

pub async fn token_handler(
    state: Arc<AppState>,
    Query(query): Query<TokenQuery>,
) -> Result<Response, ApiError> {
    if !state.bridge.is_device_owner_available() {
        return Err(ApiError::Adb(
            "google token requires device owner app (not available)".into(),
        ));
    }

    // If no account specified, use the first one
    let account = if let Some(a) = query.account {
        a
    } else {
        let accounts_json = state.bridge.device_get("/google/accounts").await?;
        let accounts: Vec<String> = serde_json::from_str(&accounts_json)
            .map_err(|e| ApiError::Adb(format!("failed to parse accounts: {e}")))?;
        accounts
            .into_iter()
            .next()
            .ok_or_else(|| ApiError::NotFound("no google accounts on device".into()))?
    };

    let payload = serde_json::json!({
        "account": account,
        "scope": query.scope,
    })
    .to_string();

    let body = state.bridge.device_post("/google/token", &payload).await?;
    Ok(([("content-type", "application/json")], body).into_response())
}
