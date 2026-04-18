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

    let dry_run = std::env::var("OTACON_ALLOW_TESTHARNESS")
        .map(|v| v != "1")
        .unwrap_or(true);

    if dry_run {
        eprintln!(
            "phone.factory_reset: phone_id={} serial={} dry_run=true \
             (OTACON_ALLOW_TESTHARNESS not set — would run: adb -s {} shell cmd testharness enable)",
            path_id, serial, serial,
        );
    } else {
        // Write marker file so device-monitor knows to reprovision after reboot
        adb_shell(serial, "echo reset > /data/local/tmp/otacon-reset-pending").await?;
        eprintln!(
            "phone.factory_reset: phone_id={} serial={} dry_run=false — executing testharness reset",
            path_id, serial,
        );
        // This command wipes the phone but preserves ADB trust
        adb(serial, &["shell", "cmd", "testharness", "enable"]).await?;
    }

    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(FactoryResetResponse {
            status: if dry_run {
                "dry_run".into()
            } else {
                "triggered".into()
            },
            dry_run,
            triggered_at: now,
        }),
    ))
}
