use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::SystemTime;

use super::adb::{adb, adb_shell};
use super::ApiError;
use crate::phone::PhoneState;

#[derive(Deserialize)]
pub struct FactoryResetBody {
    pub confirm: bool,
    pub phone_id: String,
}

#[derive(Serialize)]
pub struct FactoryResetResponse {
    pub status: String,
    pub dry_run: bool,
    pub triggered_at: u64,
}

pub async fn handler(
    ps: Arc<PhoneState>,
    path_id: String,
    body: Json<FactoryResetBody>,
) -> Result<(axum::http::StatusCode, Json<FactoryResetResponse>), ApiError> {
    if !body.confirm {
        return Err(ApiError::BadRequest(
            "confirm must be true".into(),
        ));
    }

    if body.phone_id != path_id {
        return Err(ApiError::BadRequest(
            format!("phone_id '{}' does not match path '{}'", body.phone_id, path_id),
        ));
    }

    let serial = &ps.config.adb_serial;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    eprintln!(
        "phone.factory_reset: phone_id={} serial={} — executing testharness reset",
        path_id, serial,
    );
    // This command wipes the phone but preserves ADB trust
    adb(serial, &["shell", "cmd", "testharness", "enable"]).await?;

    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(FactoryResetResponse {
            status: "triggered".into(),
            dry_run: false,
            triggered_at: now,
        }),
    ))
}
