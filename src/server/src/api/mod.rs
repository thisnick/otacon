pub mod adb;
pub mod action;
pub mod apps;
pub mod contacts;
pub mod device;
pub mod screenshot;
pub mod sms;
pub mod snapshot;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use std::sync::Arc;

use crate::AppState;

#[derive(Debug)]
pub enum ApiError {
    Adb(String),
    BadRequest(String),
    NotFound(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::Adb(msg) => (StatusCode::BAD_GATEWAY, msg),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        // UI actions
        .route(
            "/action",
            post({
                let state = state.clone();
                move |body| action::handler(state, body)
            }),
        )
        // Screen
        .route("/screenshot", get(screenshot::handler))
        .route(
            "/snapshot",
            get({
                let state = state.clone();
                move |query| snapshot::handler(state, query)
            }),
        )
        .route("/info", get(device::info_handler))
        // Notifications
        .route("/notifications", get(device::notifications_handler))
        // SMS
        .route("/sms/threads", get(sms::threads_handler))
        .route(
            "/sms/threads/{id}/messages",
            get(sms::messages_handler),
        )
        .route("/sms/messages", post(sms::send_handler))
        // Contacts
        .route("/contacts", get(contacts::handler))
        // Apps
        .route("/apps", get(apps::list_handler))
        .route(
            "/apps/running",
            get(apps::running_handler).post(apps::launch_handler),
        )
        .route("/apps/running/{package}", delete(apps::stop_handler))
}
