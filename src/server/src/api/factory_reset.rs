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

    // Check if already in test harness mode — testharness enable is a no-op
    // when the flag is already set (exits 0, no wipe happens).
    let harness_prop = adb_shell(serial, "getprop persist.sys.test_harness")
        .await
        .unwrap_or_default();
    let already_testharness = harness_prop.trim() == "1";

    if already_testharness {
        eprintln!(
            "phone.factory_reset: phone already in testharness mode — \
             clearing flag via settings db before re-enable"
        );
        // On non-root devices we can't setprop, but we can clear it via
        // settings global. The testharness service checks the persist prop,
        // but also stores state in settings. Clear both paths.
        let _ = adb_shell(
            serial,
            "settings put global test_harness_mode 0",
        )
        .await;
    }

    // Clear DPM restrictions first — DISALLOW_FACTORY_RESET blocks
    // testharness enable silently (exits 0 but does nothing).
    eprintln!("phone.factory_reset: clearing restrictions before reset");
    let _ = adb_shell(
        serial,
        "am broadcast -a com.otacon.kiosk.CLEAR_RESTRICTIONS -n com.otacon.kiosk/.BootReceiver",
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Remove device owner — it must be removed before testharness enable,
    // otherwise DPM blocks the wipe even with restrictions cleared.
    eprintln!("phone.factory_reset: removing device owner");
    let _ = adb_shell(
        serial,
        "am broadcast -a com.otacon.kiosk.REMOVE_DEVICE_OWNER -n com.otacon.kiosk/.BootReceiver",
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Attempt testharness reset (wipes /data, preserves ADB trust)
    adb(serial, &["shell", "cmd", "testharness", "enable"]).await?;

    // If already in testharness mode and the above was still a no-op,
    // report it so the caller can take alternative action.
    if already_testharness {
        return Ok((
            axum::http::StatusCode::OK,
            Json(FactoryResetResponse {
                status: "already_in_test_harness_mode".into(),
                dry_run: false,
                triggered_at: now,
            }),
        ));
    }

    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(FactoryResetResponse {
            status: "triggered".into(),
            dry_run: false,
            triggered_at: now,
        }),
    ))
}
