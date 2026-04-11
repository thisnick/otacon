pub mod adb;
pub mod action;
pub mod apps;
pub mod bridge;
pub mod calls;
pub mod clipboard;
pub mod contacts;
pub mod device;
pub mod esim;
pub mod open;
pub mod record;
pub mod screenshot;
pub mod sms;
pub mod snapshot;
pub mod internal;
pub mod test_sim;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;
use utoipa::{OpenApi, ToSchema};

use crate::AppState;

#[derive(Serialize, ToSchema)]
pub struct OkResponse {
    pub ok: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ErrorResponse {
    pub error: String,
}

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

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Otacon Phone Automation API",
        description = "REST API for controlling an Android phone connected to a Raspberry Pi.",
        version = "1.0.0",
        license(name = "MIT"),
    ),
    servers(
        (url = "https://otacon-pi:8080", description = "Default Tailscale address"),
    ),
    paths(
        action::handler,
        screenshot::handler,
        snapshot::handler,
        device::info_handler,
        device::notifications_handler,
        device::dismiss_notification_handler,
        device::notification_action_handler,
        clipboard::get_handler,
        clipboard::set_handler,
        sms::threads_handler,
        sms::messages_handler,
        sms::send_handler,
        contacts::handler,
        apps::list_handler,
        apps::running_handler,
        apps::launch_handler,
        apps::stop_handler,
        apps::install_handler,
        open::handler,
        record::start_handler,
        record::stop_handler,
        record::status_handler,
        calls::dial_handler,
        calls::answer_handler,
        calls::hangup_handler,
        calls::status_handler,
    ),
    components(schemas(
        action::Action, action::TapParams, action::SwipeParams, action::PinchParams,
        action::KeyParams, action::TypeParams, action::SetTextParams, action::ScrollParams,
        snapshot::A11yNode, snapshot::Bounds,
        device::DeviceInfo, device::Notification, device::NotificationAction,
        sms::SmsThread, sms::SmsMessage, sms::SendSmsBody,
        clipboard::ClipboardContent, clipboard::SetClipboardBody,
        apps::App, apps::LaunchBody,
        contacts::Contact,
        open::OpenBody,
        record::StartRecordBody, record::RecordStatus,
        calls::DialBody, calls::CallStatus,
        OkResponse, ErrorResponse,
    ))
)]
pub struct ApiDoc;

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
        .route("/info", get({
            let state = state.clone();
            move || device::info_handler(state)
        }))
        // Notifications
        .route("/notifications", get({
            let state = state.clone();
            move || device::notifications_handler(state)
        }))
        .route("/notifications/{key}", delete({
            let state = state.clone();
            move |path| device::dismiss_notification_handler(state, path)
        }))
        .route("/notifications/{key}/action/{index}", post({
            let state = state.clone();
            move |path| device::notification_action_handler(state, path)
        }))
        // Clipboard
        .route("/clipboard", get({
            let state = state.clone();
            move || clipboard::get_handler(state)
        }).put({
            let state = state.clone();
            move |body| clipboard::set_handler(state, body)
        }))
        // SMS
        .route("/sms/threads", get(sms::threads_handler))
        .route(
            "/sms/threads/{id}/messages",
            get(sms::messages_handler),
        )
        .route("/sms/messages", post({
            let state = state.clone();
            move |body| sms::send_handler(state, body)
        }))
        // Calls
        .route("/calls/dial", post({
            let state = state.clone();
            move |body| calls::dial_handler(state, body)
        }))
        .route("/calls/answer", post({
            let state = state.clone();
            move || calls::answer_handler(state)
        }))
        .route("/calls/hangup", post({
            let state = state.clone();
            move || calls::hangup_handler(state)
        }))
        .route("/calls/status", get({
            let state = state.clone();
            move || calls::status_handler(state)
        }))
        // Contacts
        .route("/contacts", get(contacts::handler))
        // Apps
        .route("/apps", get(apps::list_handler))
        .route(
            "/apps/running",
            get(apps::running_handler).post(apps::launch_handler),
        )
        .route("/apps/running/{package}", delete(apps::stop_handler))
        .route("/apps/install", post(apps::install_handler)
            .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024)))
        // eSIM
        .route("/esim/profiles", get({
            let state = state.clone();
            move || esim::profiles_handler(state)
        }))
        .route("/esim/install", post(esim::install_handler))
        .route("/esim/delete", post({
            move |body| esim::delete_handler(body)
        }))
        .route("/esim/switch", post({
            let state = state.clone();
            move |body| esim::switch_handler(state, body)
        }))
        .route("/esim/enable", post({
            let state = state.clone();
            move |body| esim::enable_handler(state, body)
        }))
        .route("/esim/defaults", get(esim::defaults_get_handler).put(esim::defaults_set_handler))
        // Open URI
        .route("/open", post(open::handler))
        // Recording
        .route("/record/start", post({
            let state = state.clone();
            move |body| record::start_handler(state, body)
        }))
        .route("/record/stop", post({
            let state = state.clone();
            move || record::stop_handler(state)
        }))
        .route("/record/status", get({
            let state = state.clone();
            move || record::status_handler(state)
        }))
        // Test simulation (bypass device owner bridge)
        .route("/test/call/incoming", post({
            let state = state.clone();
            move |body| test_sim::sim_incoming(state, body)
        }))
        .route("/test/call/connect", post({
            let state = state.clone();
            move || test_sim::sim_connect(state)
        }))
        .route("/test/call/end", post({
            let state = state.clone();
            move |body| test_sim::sim_end(state, body)
        }))
        .route("/test/sms/receive", post({
            let state = state.clone();
            move |body| test_sim::sim_sms_receive(state, body)
        }))
        // Internal events (from device owner app via adb reverse)
        .route("/internal/event", post({
            let state = state.clone();
            move |body| internal::event_handler(state, body)
        }))
        // OpenAPI spec
        .route("/docs/openapi.json", get(|| async {
            let spec = ApiDoc::openapi().to_json().unwrap();
            ([("content-type", "application/json")], spec)
        }))
}
