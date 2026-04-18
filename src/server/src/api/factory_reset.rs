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

    // Clear DPM restrictions first — DISALLOW_FACTORY_RESET blocks
    // testharness enable silently (exits 0 but does nothing).
    eprintln!("phone.factory_reset: clearing restrictions before reset");
    let _ = adb_shell(
        serial,
        "am broadcast -a com.otacon.kiosk.CLEAR_RESTRICTIONS -n com.otacon.kiosk/.BootReceiver",
    )
    .await;
    // Brief pause so the receiver finishes clearing restrictions
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Remove device owner so wipeData can proceed (device owner also blocks
    // factory reset on some Android versions even after clearing restrictions)
    eprintln!("phone.factory_reset: removing device owner");
    let _ = adb_shell(
        serial,
        "am broadcast -a com.otacon.kiosk.REMOVE_DEVICE_OWNER -n com.otacon.kiosk/.BootReceiver",
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

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
