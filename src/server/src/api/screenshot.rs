use axum::response::{IntoResponse, Response};

use super::adb::adb;

pub async fn handler() -> Result<Response, super::ApiError> {
    let png = adb(&["exec-out", "screencap", "-p"]).await?;

    Ok((
        [
            ("content-type", "image/png"),
            ("cache-control", "no-cache"),
        ],
        png,
    )
        .into_response())
}
