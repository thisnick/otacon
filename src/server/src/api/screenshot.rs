use axum::response::{IntoResponse, Response};

use super::adb::adb;

#[utoipa::path(
    get,
    path = "/api/screenshot",
    tag = "Screen",
    operation_id = "getScreenshot",
    responses(
        (status = 200, description = "PNG image of the current phone screen", content_type = "image/png"),
    )
)]
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
